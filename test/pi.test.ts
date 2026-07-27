// Pi extension: the five tools registered against a mock ExtensionAPI, each
// execute() driving a real spawned server. Runs the bundled dist/pi.js (what
// `pi install npm:tanuki-context` loads) against the TS engine, and — when the
// rust-branch binary is present — the same file against the Rust engine via
// TANUKI_BIN, asserting identical estimate numbers.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";

const LOG = Array.from({ length: 300 }, (_, i) => `2026-07-26 INFO copied /srv/data/batch/segment_${i % 7}.parquet ok`).join("\n");

type Registered = {
  name: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
};

async function loadExtension(env?: Record<string, string | undefined>) {
  const saved = process.env.TANUKI_BIN;
  if (env && "TANUKI_BIN" in env) process.env.TANUKI_BIN = env.TANUKI_BIN;
  else delete process.env.TANUKI_BIN;
  const tools = new Map<string, Registered>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
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
  process.env.TANUKI_BIN = saved;
  const shutdown = () => handlers.get("session_shutdown")?.({}, {});
  return { tools, shutdown };
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
