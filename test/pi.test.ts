// Pi extension: the five tools registered against a mock ExtensionAPI, each
// execute() driving a real spawned server. Runs the bundled dist/pi.js (what
// `pi install npm:tanuki-context` loads) against the TS engine, and — when the
// rust-branch binary is present — the same file against the Rust engine via
// TANUKI_BIN, asserting identical estimate numbers.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const LOG = Array.from({ length: 300 }, (_, i) => `2026-07-26 INFO copied /srv/data/batch/segment_${i % 7}.parquet ok`).join("\n");

type Registered = {
  name: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
};

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface Loaded {
  tools: Map<string, Registered>;
  handlers: Map<string, Handler>;
  shutdown: () => unknown;
}

async function loadExtension(env?: Record<string, string | undefined>): Promise<Loaded> {
  const saved = process.env.TANUKI_BIN;
  if (env && "TANUKI_BIN" in env) process.env.TANUKI_BIN = env.TANUKI_BIN;
  else delete process.env.TANUKI_BIN;
  const tools = new Map<string, Registered>();
  const handlers = new Map<string, Handler>();
  const mockPi = {
    registerTool(t: Registered) {
      tools.set(t.name, t);
    },
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, fn);
    },
  };
  // Cache-bust so each load re-reads TANUKI_BIN.
  const mod = await import(new URL(`../dist/pi.js?${Math.random()}`, import.meta.url).href);
  mod.default(mockPi);
  // Assigning undefined stores the string "undefined" (bun >= 1.4, node), which
  // the lazily spawned server would then try to exec.
  if (saved === undefined) delete process.env.TANUKI_BIN;
  else process.env.TANUKI_BIN = saved;
  const shutdown = () => handlers.get("session_shutdown")?.({}, {});
  return { tools, handlers, shutdown };
}

describe("pi extension (TS engine)", () => {
  let tools: Map<string, Registered>;
  let shutdown: () => unknown;
  beforeAll(async () => {
    ({ tools, shutdown } = await loadExtension());
  });
  afterAll(() => shutdown());

  test("registers the eight tanuki tools with object schemas", () => {
    expect([...tools.keys()].sort()).toEqual([
      "tanuki_compress",
      "tanuki_distill",
      "tanuki_estimate",
      "tanuki_fetch",
      "tanuki_render",
      "tanuki_stash",
      "tanuki_stats",
      "tanuki_verify",
    ]);
    for (const t of tools.values()) {
      const p: unknown = t.parameters;
      expect(p !== null && typeof p === "object" && "type" in p && p.type === "object").toBe(true);
    }
  });

  test("estimate returns the verdict JSON", async () => {
    const r = await tools.get("tanuki_estimate")!.execute("t1", { text: LOG, level: 0 });
    const est = JSON.parse(r.content[0]!.text!);
    expect(est.engine).toBe("pxpipe");
    expect(est.imageTokens).toBeGreaterThan(0);
    expect(typeof est.verdict).toBe("string");
  });

  test("render returns PNG image blocks in pi content shape", async () => {
    const r = await tools.get("tanuki_render")!.execute("t2", { text: LOG, level: 0 });
    const img = r.content.find((c) => c.type === "image");
    expect(img).toBeDefined();
    expect(img!.mimeType).toBe("image/png");
    const png = Buffer.from(img!.data!, "base64");
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  test("distill collapses the log and reports counts", async () => {
    const r = await tools.get("tanuki_distill")!.execute("t3", { text: LOG });
    const out = r.content.map((c) => c.text ?? "").join("");
    expect(out.length).toBeLessThan(LOG.length / 3);
  });

  test("server child is reused across calls and dies on shutdown", async () => {
    const a = await tools.get("tanuki_compress")!.execute("t4", { text: "hello   world", level: 1 });
    expect(a.content.map((c) => c.text ?? "").join("\n")).toContain("hello");
  });
});

// The I/O router: omp/pi hand every bash result to tool_result; a big one comes
// back crushed with the original stashed, and small or non-bash ones untouched.
describe("pi extension bash router", () => {
  const prevStash = process.env.TANUKI_STASH;
  let ext: Loaded;
  const route = (event: Record<string, unknown>) =>
    ext.handlers.get("tool_result")!(event, {}) as Promise<{ content: { type: string; text: string }[] } | undefined>;
  const passing = Array.from({ length: 400 }, (_, i) => `test suite::case_${i} ... ok`);
  const BIG = ["running 401 tests", ...passing, "test suite::broken ... FAILED", "error: test failed, to rerun pass `--lib`"].join("\n");

  beforeAll(async () => {
    process.env.TANUKI_STASH = mkdtempSync(`${tmpdir()}/tanuki-router-test-`);
    ext = await loadExtension();
  });
  afterAll(() => {
    ext.shutdown();
    if (prevStash === undefined) delete process.env.TANUKI_STASH;
    else process.env.TANUKI_STASH = prevStash;
  });

  test("a big failing bash result is cut, keeps the failure, and the original is fetchable", async () => {
    const r = await route({ toolName: "bash", input: { command: "cd x && cargo test" }, content: [{ type: "text", text: BIG }], details: { exitCode: 101 }, isError: true });
    const out = r!.content[0]!.text;
    expect(out.startsWith("[tanuki run] exit 101")).toBe(true);
    expect(out.length).toBeLessThan(BIG.length / 2);
    expect(out).toContain("suite::broken ... FAILED");
    const id = /"id":"([0-9a-f]{12})"/.exec(out)![1]!;
    const back = await ext.tools.get("tanuki_fetch")!.execute("f1", { id, lines: "200-200" });
    expect(back.content.map((c) => c.text ?? "").join("")).toContain("case_198 ... ok");
  });

  test("small results, other tools, and TANUKI_ROUTE=off pass through untouched", async () => {
    expect(await route({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "a\nb" }] })).toBeUndefined();
    expect(await route({ toolName: "read", input: {}, content: [{ type: "text", text: BIG }] })).toBeUndefined();
    process.env.TANUKI_ROUTE = "off";
    try {
      expect(await route({ toolName: "bash", input: { command: "cargo test" }, content: [{ type: "text", text: BIG }] })).toBeUndefined();
    } finally {
      delete process.env.TANUKI_ROUTE;
    }
  });
});

const RUST_BIN = process.env.TANUKI_BIN_TEST ?? "/tmp/tanuki-rust/target/release/tanuki-context";
describe.if(existsSync(RUST_BIN))("pi extension (Rust engine via TANUKI_BIN)", () => {
  test("same extension file, same numbers from the rust binary", async () => {
    const ts = await loadExtension();
    const rs = await loadExtension({ TANUKI_BIN: RUST_BIN });
    try {
      const [a, b] = await Promise.all([
        ts.tools.get("tanuki_estimate")!.execute("r1", { text: LOG, level: 2 }),
        rs.tools.get("tanuki_estimate")!.execute("r2", { text: LOG, level: 2 }),
      ]);
      expect(JSON.parse(b.content[0]!.text!)).toEqual(JSON.parse(a.content[0]!.text!));
    } finally {
      ts.shutdown();
      rs.shutdown();
    }
  });
});
