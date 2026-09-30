// --prune-tools: the tool list is reduced ONCE per distinct list from cross-session
// usage evidence and forwarded byte-identically afterwards (the tools head the
// cached prefix), a pruned tool stays reachable, and usage is counted either way.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_DEFAULTS, newSession, transformRequestBody, type ProxyCfg } from "../src/proxy.ts";
import { fileUsage, type UsageMap, type UsageStore } from "../src/toolusage.ts";

const CFG: ProxyCfg = { ...PROXY_DEFAULTS, port: 0, upstream: "http://127.0.0.1:1", pruneTools: "stub", pruneMin: 3 };

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} does one thing.\nLong second paragraph nobody needs every turn, ${"pad ".repeat(80)}`,
  input_schema: { type: "object", properties: { path: { type: "string", description: "x".repeat(200) } }, required: ["path"] },
  ...extra,
});
const TOOLS = [tool("Bash"), tool("Read"), tool("NotebookEdit"), tool("WebFetch")];

/** In-memory usage evidence: Bash/Read are called in every conversation, the others never. */
function store(map: UsageMap): UsageStore & { bumps: [string[], string[]][] } {
  const bumps: [string[], string[]][] = [];
  return { bumps, load: () => JSON.parse(JSON.stringify(map)) as UsageMap, bump: (adv, used) => void bumps.push([adv, used]) };
}
const EVIDENCE: UsageMap = {
  Bash: { adv: 9, used: 9 },
  Read: { adv: 9, used: 4 },
  NotebookEdit: { adv: 9, used: 0 },
  WebFetch: { adv: 2, used: 0 }, // too few conversations to say
};
const body = (over: Record<string, unknown> = {}, tools: unknown[] = TOOLS, msgs: unknown[] = [{ role: "user", content: "hi" }]): string =>
  JSON.stringify({ model: "claude-sonnet-4-5", tools, messages: msgs, ...over });
const toolsOf = (raw: string): { name: string; input_schema: unknown; description: string }[] => JSON.parse(raw).tools;

function session(map: UsageMap = EVIDENCE) {
  const s = newSession();
  const st = store(map);
  s.toolUsage = st;
  return { s, st };
}

describe("prune-tools", () => {
  test("stub mode reduces only tools advertised often enough and called never; the rest keep the client's bytes", () => {
    const { s } = session();
    const raw = body();
    const r = transformRequestBody(raw, CFG, s)!;
    expect(r.prunedTools!.names).toEqual(["NotebookEdit"]);
    const out = toolsOf(r.body);
    expect(out.map((t) => t.name)).toEqual(["Bash", "Read", "NotebookEdit", "WebFetch"]); // order kept
    expect(out[2]).toEqual({ name: "NotebookEdit", description: "NotebookEdit does one thing.", input_schema: { type: "object" } });
    const orig = JSON.parse(raw).tools;
    expect(out[0]).toEqual(orig[0]);
    expect(out[3]).toEqual(orig[3]);
    expect(r.body.length).toBeLessThan(raw.length);
    expect(r.prunedTools!.tokens).toBeGreaterThan(50);
    // everything outside the tool list is byte-for-byte the client's
    expect(r.body.slice(0, raw.indexOf('"tools"'))).toBe(raw.slice(0, raw.indexOf('"tools"')));
    expect(r.body.slice(r.body.indexOf('"messages"'))).toBe(raw.slice(raw.indexOf('"messages"')));
  });

  test("drop mode leaves the tool out entirely", () => {
    const { s } = session();
    const r = transformRequestBody(body(), { ...CFG, pruneTools: "drop" }, s)!;
    expect(toolsOf(r.body).map((t) => t.name)).toEqual(["Bash", "Read", "WebFetch"]);
  });

  test("off by default: nothing pruned, bytes untouched, but usage is still counted", () => {
    const { s, st } = session();
    const raw = body();
    const r = transformRequestBody(raw, { ...CFG, pruneTools: "off" }, s)!;
    expect(r.prunedTools).toBeNull();
    expect(r.changed).toBe(false);
    expect(r.body).toBe(raw);
    expect(st.bumps).toEqual([[["Bash", "Read", "NotebookEdit", "WebFetch"], []]]);
  });

  test("no evidence, no pruning: an empty usage map prunes nothing", () => {
    const { s } = session({});
    const r = transformRequestBody(body(), CFG, s)!;
    expect(r.prunedTools).toBeNull();
    expect(r.changed).toBe(false);
  });

  test("decided once per conversation: the same bytes on every request, even after the evidence changes", () => {
    const map: UsageMap = JSON.parse(JSON.stringify(EVIDENCE));
    const { s } = session(map);
    const first = transformRequestBody(body(), CFG, s)!;
    // the evidence now says NotebookEdit is used and WebFetch is dead: this conversation keeps its list
    map.NotebookEdit.used = 5;
    map.WebFetch = { adv: 9, used: 0 };
    const turns = [
      [{ role: "user", content: "hi" }],
      [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "more" }],
    ];
    for (const m of turns) {
      const again = transformRequestBody(body({}, TOOLS, m), CFG, s)!;
      expect(again.body.slice(again.body.indexOf('"tools"'), again.body.indexOf('"messages"'))).toBe(first.body.slice(first.body.indexOf('"tools"'), first.body.indexOf('"messages"')));
    }
    // a genuinely different tool list is a new decision
    const fresh = transformRequestBody(body({}, TOOLS.slice(0, 3)), CFG, s)!;
    expect(fresh.prunedTools).toBeNull();
  });

  test("a tool the history already called is never reduced, nor one that tool_choice forces, nor one carrying cache_control", () => {
    const called = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "NotebookEdit", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    expect(transformRequestBody(body({}, TOOLS, called), CFG, session().s)!.prunedTools).toBeNull();
    expect(transformRequestBody(body({ tool_choice: { type: "tool", name: "NotebookEdit" } }), CFG, session().s)!.prunedTools).toBeNull();
    const cached = [tool("Bash"), tool("NotebookEdit", { cache_control: { type: "ephemeral" } })];
    expect(transformRequestBody(body({}, cached), CFG, session().s)!.prunedTools).toBeNull();
  });

  test("server-side tools (typed) and tools without a schema are left alone", () => {
    const list = [{ type: "web_search_20250305", name: "NotebookEdit", max_uses: 3 }, { name: "NotebookEdit", description: "no schema" }];
    const r = transformRequestBody(body({}, list), CFG, session().s)!;
    expect(r.prunedTools).toBeNull();
  });

  test("usage counts a conversation once, and a call once per name", () => {
    const { s, st } = session({});
    const turn1 = body();
    const turn2 = body({}, TOOLS, [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "tool_use", id: "t2", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
    for (const b of [turn1, turn2, turn2]) transformRequestBody(b, { ...CFG, pruneTools: "off" }, s);
    expect(st.bumps).toEqual([
      [["Bash", "Read", "NotebookEdit", "WebFetch"], []],
      [[], ["Bash"]],
    ]);
  });

  test("evidence crossing the threshold mid-proxy-lifetime: the next conversation is pruned, the current one stays byte-stable", () => {
    const map: UsageMap = JSON.parse(JSON.stringify(EVIDENCE));
    map.NotebookEdit = { adv: 1, used: 0 }; // below pruneMin (3) when the proxy starts
    const { s } = session(map);
    const listOf = (raw: string): string => raw.slice(raw.indexOf('"tools"'), raw.indexOf('"messages"'));
    const turn2 = [{ role: "user", content: "a" }, { role: "assistant", content: "ok" }, { role: "user", content: "more" }];
    const a1 = transformRequestBody(body({}, TOOLS, [{ role: "user", content: "a" }]), CFG, s)!;
    expect(a1.prunedTools).toBeNull();
    map.NotebookEdit = { adv: 9, used: 0 }; // the evidence grows while the proxy keeps running
    const a2 = transformRequestBody(body({}, TOOLS, turn2), CFG, s)!;
    expect(a2.prunedTools).toBeNull(); // conversation A keeps the bytes it started with
    expect(listOf(a2.body)).toBe(listOf(a1.body));
    const b1 = transformRequestBody(body({}, TOOLS, [{ role: "user", content: "b" }]), CFG, s)!;
    expect(b1.prunedTools!.names).toEqual(["NotebookEdit"]); // conversation B starts pruned
    const b2 = transformRequestBody(body({}, TOOLS, [{ role: "user", content: "b" }, { role: "assistant", content: "ok" }, { role: "user", content: "more" }]), CFG, s)!;
    expect(listOf(b2.body)).toBe(listOf(b1.body));
  });

  test("a memo made for one conversation never hides a tool another conversation forces or already called", () => {
    const { s } = session();
    const first = transformRequestBody(body(), CFG, s)!;
    expect(first.prunedTools!.names).toEqual(["NotebookEdit"]);
    const listOf = (raw: string): string => raw.slice(raw.indexOf('"tools"'), raw.indexOf('"messages"'));
    // same tool list, another conversation: a plain one still gets the memoised bytes
    const plain = transformRequestBody(body({}, TOOLS, [{ role: "user", content: "other" }]), CFG, s)!;
    expect(listOf(plain.body)).toBe(listOf(first.body));
    // forcing the pruned tool -> the client's own list, and the request is not rewritten at all
    const forcedRaw = body({ tool_choice: { type: "tool", name: "NotebookEdit" } }, TOOLS, [{ role: "user", content: "third" }]);
    const forced = transformRequestBody(forcedRaw, CFG, s)!;
    expect(forced.prunedTools).toBeNull();
    expect(forced.body).toBe(forcedRaw);
    // a history that already called it -> same
    const calledRaw = body({}, TOOLS, [
      { role: "user", content: "fourth" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "NotebookEdit", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
    const called = transformRequestBody(calledRaw, CFG, s)!;
    expect(called.prunedTools).toBeNull();
    expect(called.body).toBe(calledRaw);
    // and the memo itself survived: the next plain conversation is pruned again
    expect(listOf(transformRequestBody(body({}, TOOLS, [{ role: "user", content: "fifth" }]), CFG, s)!.body)).toBe(listOf(first.body));
  });

  test("evidence: tools the proxy hid are not counted as advertised; a forced tool_choice counts as a call", () => {
    for (const mode of ["stub", "drop"] as const) {
      const { s, st } = session();
      transformRequestBody(body(), { ...CFG, pruneTools: mode }, s);
      expect(st.bumps).toEqual([[["Bash", "Read", "WebFetch"], []]]); // NotebookEdit was pruned: no adv
    }
    const { s, st } = session({});
    transformRequestBody(body({ tool_choice: { type: "tool", name: "WebFetch" } }), { ...CFG, pruneTools: "off" }, s);
    expect(st.bumps).toEqual([[["Bash", "Read", "NotebookEdit", "WebFetch"], ["WebFetch"]]]);
  });

  test("a conversation is the same conversation when only its cache_control moves; the oldest is evicted, not all", () => {
    const { s, st } = session({});
    const cfg = { ...CFG, pruneTools: "off" as const };
    const plain = body({}, TOOLS, [{ role: "user", content: [{ type: "text", text: "same start" }] }]);
    const cached = body({}, TOOLS, [{ role: "user", content: [{ type: "text", text: "same start", cache_control: { type: "ephemeral" } }] }]);
    transformRequestBody(plain, cfg, s);
    transformRequestBody(cached, cfg, s);
    transformRequestBody(plain, cfg, s);
    expect(st.bumps.length).toBe(1); // counted once
    for (let i = 0; i < 2000; i++) transformRequestBody(body({}, TOOLS, [{ role: "user", content: `conv ${i}` }]), cfg, s);
    const before = st.bumps.length;
    transformRequestBody(body({}, TOOLS, [{ role: "user", content: "conv 1999" }]), cfg, s);
    expect(st.bumps.length).toBe(before); // a recent conversation is still remembered
    transformRequestBody(plain, cfg, s);
    expect(st.bumps.length).toBe(before + 1); // the oldest one was evicted and counts again
  });

  test("file store round-trips and counts across proxy processes; private file, no stray temp files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tanuki-usage-"));
    const prev = process.env.TANUKI_TOOL_USAGE;
    process.env.TANUKI_TOOL_USAGE = join(dir, "sub", "u.json");
    try {
      const a = fileUsage();
      a.bump(["Bash", "Read"], []);
      fileUsage().bump(["Bash"], ["Bash"]);
      expect(a.load()).toEqual({ Bash: { adv: 2, used: 1 }, Read: { adv: 1, used: 0 } });
      expect(readFileSync(join(dir, "sub", "u.json"), "utf8")).toBe('{"Bash":{"adv":2,"used":1},"Read":{"adv":1,"used":0}}\n');
      expect(statSync(join(dir, "sub", "u.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(dir, "sub"))).toEqual(["u.json"]);
    } finally {
      if (prev === undefined) delete process.env.TANUKI_TOOL_USAGE;
      else process.env.TANUKI_TOOL_USAGE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
