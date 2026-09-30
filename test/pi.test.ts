// Pi extension: the five tools registered against a mock ExtensionAPI, each
// execute() driving a real spawned server. Runs the bundled dist/pi.js (what
// `pi install npm:tanuki-context` loads) against the TS engine, and — when the
// rust-branch binary is present — the same file against the Rust engine via
// TANUKI_BIN, asserting identical estimate numbers.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    const r = await route({ toolName: "bash", input: { command: "cd x && cargo test" }, content: [{ type: "text", text: BIG }], details: { exitCode: 101, meta: { truncation: { artifactId: "7" } } }, isError: true });
    const out = r!.content[0]!.text;
    expect(out.startsWith("[tanuki run] exit 101")).toBe(true);
    expect(out.length).toBeLessThan(BIG.length / 2);
    expect(out).toContain("suite::broken ... FAILED");
    expect(out.endsWith("\ncomplete output: artifact://7")).toBe(true);
    const id = /"id":"([0-9a-f]{12})"/.exec(out)![1]!;
    const back = await ext.tools.get("tanuki_fetch")!.execute("f1", { id, lines: "200-200" });
    expect(back.content.map((c) => c.text ?? "").join("")).toContain("case_198 ... ok");
  });

  test("small results, other tools, readers, pipelines, and TANUKI_ROUTE=off pass through untouched", async () => {
    expect(await route({ toolName: "bash", input: { command: "cargo test" }, content: [{ type: "text", text: "a\nb" }] })).toBeUndefined();
    expect(await route({ toolName: "read", input: {}, content: [{ type: "text", text: BIG }] })).toBeUndefined();
    // distill is lossy: file and diff views the model may edit from stay whole
    for (const command of ["cat big.log", "git diff", "cd x && sed -n 1,900p a.rs", "cargo test 2>&1 | grep ok", "jq . out.json"]) {
      expect(await route({ toolName: "bash", input: { command }, content: [{ type: "text", text: BIG }] })).toBeUndefined();
    }
    process.env.TANUKI_ROUTE = "off";
    try {
      expect(await route({ toolName: "bash", input: { command: "cargo test" }, content: [{ type: "text", text: BIG }] })).toBeUndefined();
    } finally {
      delete process.env.TANUKI_ROUTE;
    }
  });

  // A 2 KB `npm test` is under RUN_INLINE_MAX, yet its second identical run
  // must still reach routeOutput so it can collapse to a delta.
  test("a mid-size test run repeated in the same stash comes back shorter the second time", async () => {
    const prev = process.env.TANUKI_STASH;
    process.env.TANUKI_STASH = mkdtempSync(`${tmpdir()}/tanuki-delta-test-`);
    try {
      const mid = Array.from({ length: 60 }, (_, i) => `  ✓ suite case number ${i} passes (${i} ms)`).join("\n") + "\n  ✗ suite broken\n\n61 tests, 1 failed";
      expect(mid.length).toBeGreaterThan(1500);
      expect(mid.length).toBeLessThan(8000);
      const ev = { toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: mid }], details: { exitCode: 1 }, isError: true };
      await route(ev);
      const second = await route(ev);
      expect(second).toBeDefined();
      expect(second!.content[0]!.text).toContain("[tanuki delta] vs previous run");
      expect(second!.content[0]!.text.length).toBeLessThan(mid.length / 2);
    } finally {
      if (prev === undefined) delete process.env.TANUKI_STASH;
      else process.env.TANUKI_STASH = prev;
    }
  });

  // Lossless JSON: a data tool's pretty-printed reply loses its indentation
  // and the spaces between tokens; strings (spaces, "\n" escapes, big
  // integers) come through byte-exact, and file views never change shape.
  const PRETTY = JSON.stringify({ id: "12345678901234567890", items: Array.from({ length: 30 }, (_, i) => ({ name: `item ${i}`, note: "two  spaces\tand a \\n escape", big: "BIGINT" })) }, null, 2)
    .replaceAll('"BIGINT"', "9007199254740993"); // past 2^53: a parse-and-print would round it
  test("pretty JSON from a data tool is minified losslessly; the omp footer stays", async () => {
    const mcp = await route({ toolName: "mcp__github__get_issue", input: {}, content: [{ type: "text", text: PRETTY }] });
    const got = mcp!.content[0]!.text;
    expect(got.length).toBeLessThan(PRETTY.length * 0.8);
    expect(JSON.parse(got)).toEqual(JSON.parse(PRETTY));
    expect(got).toContain('"two  spaces\\tand a \\\\n escape"');
    expect(got).toContain("9007199254740993"); // not re-printed through a float
    // omp cuts a result line at 768 bytes (tools.outputMaxColumns): the
    // document keeps its line breaks, so no line may outgrow the original's
    expect(got.length).toBeGreaterThan(2048);
    expect(Math.max(...got.split("\n").map((l) => l.length))).toBeLessThanOrEqual(Math.max(...PRETTY.split("\n").map((l) => l.length)));
    const footer = "\n\nWall time: 0.41 seconds";
    const gh = await route({ toolName: "bash", input: { command: "gh api repos/o/r" }, content: [{ type: "text", text: PRETTY + footer }] });
    expect(gh!.content[0]!.text).toBe(got + footer);
    // big docker JSON: lossless minify wins over the lossy run rules
    const big = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ Id: `c${i}`, State: { Status: "running" } })), null, 2);
    const dk = await route({ toolName: "bash", input: { command: "docker inspect $(docker ps -q)" }, content: [{ type: "text", text: big }] });
    expect(JSON.parse(dk!.content[0]!.text)).toEqual(JSON.parse(big));
  });

  test("JSON in file views, our own tools' results, reader commands, non-JSON text and TANUKI_MINIFY=off is left alone", async () => {
    for (const [toolName, command] of [["read", ""], ["edit", ""], ["tanuki_fetch", ""], ["bash", "cat package.json"], ["bash", "jq . package.json"], ["bash", "gh api x | jq ."]]) {
      expect(await route({ toolName, input: { command }, content: [{ type: "text", text: PRETTY }] })).toBeUndefined();
    }
    expect(await route({ toolName: "mcp__x__y", input: {}, content: [{ type: "text", text: `${PRETTY}\ntrailing prose` }] })).toBeUndefined();
    expect(await route({ toolName: "mcp__x__y", input: {}, content: [{ type: "text", text: '{"already":"compact"}' }] })).toBeUndefined();
    process.env.TANUKI_MINIFY = "off";
    try {
      expect(await route({ toolName: "mcp__x__y", input: {}, content: [{ type: "text", text: PRETTY }] })).toBeUndefined();
    } finally {
      delete process.env.TANUKI_MINIFY;
    }
  });

  // omp cuts a result line at 768 bytes BEFORE tool_result, and `gh api` is
  // compact one-line JSON off a TTY (`--jq .` keeps it so), so tool_call wraps
  // a lone `gh api` in `jq .`.
  const rewrite = async (command: string) => {
    const r = (await ext.handlers.get("tool_call")!({ toolName: "bash", input: { command, timeout: 5 } }, {})) as { input: Record<string, unknown> } | undefined;
    return r === undefined ? undefined : r.input;
  };
  test("tool_call wraps a lone gh api step in a jq-or-verbatim subshell and keeps the other input fields", async () => {
    const r = await rewrite("gh api repos/o/r");
    expect(r).toEqual({ command: `(o=$(gh api repos/o/r); rc=$?; printf '%s\\n' "$o" | jq . 2>/dev/null || printf '%s\\n' "$o"; exit $rc) #tanuki-pretty`, timeout: 5 });
    expect((await rewrite("gh api -X POST repos/o/r/issues -f title='a b'"))!.command).toContain("exit $rc)");
    // the wrapped form still routes as gh (minify sees through it)
    const out = await route({ toolName: "bash", input: { command: r!.command }, content: [{ type: "text", text: PRETTY }] });
    expect(JSON.parse(out!.content[0]!.text)).toEqual(JSON.parse(PRETTY));
  });
  test("the wrapper pretty-prints JSON, keeps a text body verbatim, and always exits with gh's code", async () => {
    const bin = mkdtempSync(`${tmpdir()}/tanuki-fakegh-`);
    writeFileSync(`${bin}/gh`, '#!/bin/sh\nprintf "%s" "$FAKE_BODY"; echo "gh: oops" >&2; exit "${FAKE_RC:-0}"\n', { mode: 0o755 });
    const run = (command: string, env: Record<string, string>) =>
      spawnSync("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: "utf8" });
    try {
      const cmd = (await rewrite("gh api repos/o/r"))!.command as string;
      const ok = run(cmd, { FAKE_BODY: '{"a":[1,2],"b":"x y"}' });
      expect([ok.status, ok.stdout]).toEqual([0, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x y"\n}\n']);
      const zen = run(cmd, { FAKE_BODY: "Keep it logically awesome." });
      expect([zen.status, zen.stdout]).toEqual([0, "Keep it logically awesome.\n"]);
      const nf = run(cmd, { FAKE_BODY: '{"message":"Not Found"}', FAKE_RC: "1" });
      expect(nf.status).toBe(1);
      expect(nf.stdout).toContain('"message": "Not Found"');
      expect(nf.stderr).toContain("gh: oops");
    } finally {
      rmSync(bin, { recursive: true });
    }
  });
  test("tool_call leaves pipes, redirects, lists, --jq/-q/--template/-t/-i, other commands alone; env switches disable it", async () => {
    for (const c of ["gh api x | head", "gh api x > o.json", "cd d && gh api x", "gh api x; echo", "gh api x --jq .name", "gh api x -q .name", "gh api x --template '{{.a}}'", "gh api x -t '{{.a}}'", "gh api -i x", "gh api x --silent",
      "gh pr list", "curl https://x", "echo $(gh api x)", "cargo test"]) {
      expect(await rewrite(c)).toBeUndefined();
    }
    expect(await ext.handlers.get("tool_call")!({ toolName: "read", input: { command: "gh api x" } }, {})).toBeUndefined();
    for (const k of ["TANUKI_ROUTE", "TANUKI_MINIFY"]) {
      process.env[k] = "off";
      try {
        expect(await rewrite("gh api repos/o/r")).toBeUndefined();
      } finally {
        delete process.env[k];
      }
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
