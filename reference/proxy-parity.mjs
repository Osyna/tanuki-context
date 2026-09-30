// Cross-engine proxy check: the MCP parity harness drives tools/call, so the
// proxy wire path has no byte-comparison anywhere. Run the same request through
// the TS proxy and the Rust proxy against a capturing upstream, then diff what
// upstream actually received - RAW BYTES, not parsed JSON. The rewrite is a splice
// into the client's own bytes (0.23), so key order, spacing, escapes and number
// spellings of everything untouched must survive identically in both engines.
// Only the PNG payloads are masked: the two zlib encoders emit different
// compressed bytes for identical pixels, so pages are compared as pixels.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngPixels } from "./lib/png.mjs";

const BIG = Array.from(
  { length: 300 },
  (_, i) => `2026-07-26T02:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 5} copied /srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet ok`,
).join("\n");

// 0.22 rule 7: a pretty JSON tool result in the LATEST message (recency window
// and all) must reach upstream minified, identically - Unicode, escapes and a
// past-2^53 integer inside a string included.
const PRETTY = JSON.stringify(
  { items: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, note: "café \u2603 \"quoted\"  two spaces\ttab", big: "12345678901234567890" })) },
  null,
  2,
);
const MIN = JSON.stringify(JSON.parse(PRETTY));

// Hand-written, not JSON.stringify'd: odd key order, spaces after colons, escapes,
// 1.0 / 1e2 / 1.50 and past-2^53 integers in system, tools and a tool_use input.
const LITERALS = ["1e2", "1.0", "1.50", "caf\\u00e9 \\/ SYSTEM", "12345678901234567890"];
const REQ =
  '{"max_tokens" : 16,\n "temperature": 1.0, "top_k":1e2, "model":"claude-sonnet-4-5", "stream" : false,\n' +
  ' "system" : [{"text":"caf\\u00e9 \\/ SYSTEM","type":"text"}],\n' +
  ' "tools":[{"name":"t","input_schema":{"z":12345678901234567890,"a":1.50}}],\n "messages" : [\n' +
  ` {"role":"user", "content":[{"text":${JSON.stringify(BIG)},"type":"text"}, {"type":"text","text":"tail" }]},\n` +
  ' {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"t","input":{"id":12345678901234567890,"f":1.50,"e":1e2}}]},\n' +
  ` {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":${JSON.stringify(PRETTY)}},{"type":"text","text":"latest question"}]}\n ]\n}`;

// T8a: a plain conversation. The third request is the first whose prefix has
// held twice, so it alone gains the automatic breakpoint.
const CONV = [
  '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"q0"}]}',
  '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"q0"},{"role":"assistant","content":"a0"},{"role":"user","content":"q1"}]}',
  '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"q0"},{"role":"assistant","content":"a0"},{"role":"user","content":"q1"},{"role":"assistant","content":[{"type":"text","text":"a1"},{"type":"text", "text":"a2" }]},{"role":"user","content":"q2"}]}',
];

const captured = [];
const upstream = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    captured.push(b);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 }, content: [] }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

const post = (port, body) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", resolve); },
    );
    r.on("error", reject);
    r.end(body);
  });

// Extra shapes for the splice paths, one proxy process (one session) per engine, so
// both see the same sequence: string content, tool_result with item arrays, a client
// tail block, duplicate and escaped keys, an empty-object tail, non-BMP text.
const EMOJI = "\u{1F600} caf\u00e9 \u2603";
const PRETTY_EMOJI = JSON.stringify({ rows: Array.from({ length: 12 }, (_, i) => ({ id: i, note: `${EMOJI} \"q\"  two spaces` })) }, null, 4).replaceAll("\u{1F600}", "\\ud83d\\ude00");
const CASES = [
  `{"model":"m","messages":[{"role":"user","content":${JSON.stringify(`${BIG}\n${EMOJI}`)}},{"role":"user","content":"${EMOJI} latest"}]}`,
  `{"model":"m", "messages":[ {"role":"user","content":[ {"type":"tool_result","tool_use_id":"a","content":[ {"type":"text","text":${JSON.stringify(BIG)}} , {"type":"text", "text":${JSON.stringify(PRETTY)}} ]} ]}, {"role":"user","content":"x"} ]}`,
  `{"messages":[{"role":"user","content":[ {"type":"text","text":${JSON.stringify(`${BIG}\n${EMOJI}`)}} , {"type":"text","text":"tail" } ]},{"role":"user","content":"latest"}]}`,
  `{ "messages" : [{"role":"user","content":"stale"}] , "messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","con\\u0074ent":"stale","content":${JSON.stringify(PRETTY_EMOJI)}}]},{"role":"user","content":"x"}] }`,
  `{"messages":[{"role":"user","content":[{"type":"text","text":${JSON.stringify(BIG)}}, {} ]},{"role":"user","content":"latest"}]}`,
];

// --prune-tools: one shared piece of usage evidence (a file per engine, same bytes) and a
// tool list with a multi-line unicode description, a cache_control tool and a typed tool.
// Three requests in one session: the list is reduced on the first, the second reuses the
// verdict (same bytes), the third is a different list whose history calls one of its tools.
const USAGE = JSON.stringify({ Bash: { adv: 9, used: 9 }, Grep: { adv: 9, used: 0 }, Notebook: { adv: 9, used: 0 }, Cached: { adv: 9, used: 0 }, Late: { adv: 9, used: 0 }, Few: { adv: 2, used: 0 } });
const SCHEMA = '{"type":"object","properties":{"path":{"type":"string","description":"x"}},"required":["path"]}';
const PTOOLS =
  `[{"name":"Bash","description":"Run a command.\\nMore.","input_schema":${SCHEMA}},` +
  `{"input_schema":${SCHEMA},"description":"  caf\\u00e9 \\u2603 \\"quoted\\" search tool, first line only \\r\\nsecond","name":"Grep"},` +
  `{"name":"Notebook","description":"Edit notebooks","input_schema":${SCHEMA}},` +
  `{"name":"Cached","description":"c","input_schema":${SCHEMA},"cache_control":{"type":"ephemeral"}},` +
  '{"type":"web_search_20250305","name":"Late","max_uses":3},' +
  `{"name":"Few","description":"rarely advertised","input_schema":${SCHEMA}}]`;
const PLIST = [
  `{"model":"m","max_tokens":16,"tools":${PTOOLS},"messages":[{"role":"user","content":"hi"}]}`,
  `{"model":"m","max_tokens":16,"tools":${PTOOLS},"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"},{"role":"user","content":"again"}]}`,
  `{"model":"m","max_tokens":16,"tools":${PTOOLS.replace('"name":"Few"', '"name":"Fewer"')},"messages":[{"role":"user","content":"go"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Grep","input":{"path":"a"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}]}`,
  // other conversations that force / have called a pruned tool: that tool stays whole (their own decision)
  `{"model":"m","max_tokens":16,"tools":${PTOOLS},"tool_choice":{"type":"tool","name":"Notebook"},"messages":[{"role":"user","content":"other"}]}`,
  `{"model":"m","max_tokens":16,"tools":${PTOOLS},"messages":[{"role":"user","content":"third"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Notebook","input":{"path":"a"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}]}`,
  // the memoised conversation of requests 1-2 now forces a pruned tool: the client's own list goes out
  `{"model":"m","max_tokens":16,"tools":${PTOOLS},"tool_choice":{"type":"tool","name":"Notebook"},"messages":[{"role":"user","content":"hi"}]}`,
];
const usageFile = (label) => { const f = join(tmpdir(), `tanuki-usage-parity-${process.pid}-${label}.json`); writeFileSync(f, USAGE); return f; };

const EVENTS = join(tmpdir(), `tanuki-proxy-parity-${process.pid}.jsonl`);

/// Post every body of `bodies` in order through one proxy process (one session)
/// and return what upstream received for each.
async function runEngine(label, cmd, args, bodies, extraEnv = {}) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const p = spawn(cmd, [...args, "--port", String(port), "--upstream", `http://127.0.0.1:${upPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TANUKI_EVENTS: EVENTS, TANUKI_TOOL_USAGE: join(tmpdir(), `tanuki-usage-parity-${process.pid}-default-${label}.json`), ...extraEnv },
  });
  let ready = false;
  p.stderr.on("data", (d) => { if (String(d).includes("proxy on")) ready = true; });
  for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 50));
  if (!ready) { p.kill(); throw new Error(`${label} never came up`); }
  const got = [];
  for (const body of bodies) {
    const before = captured.length;
    await post(port, body);
    for (let i = 0; i < 100 && captured.length === before; i++) await new Promise((r) => setTimeout(r, 50));
    if (captured.length === before) { p.kill(); throw new Error(`${label} forwarded nothing`); }
    got.push(captured.at(-1));
  }
  p.kill();
  await new Promise((r) => setTimeout(r, 100));
  return got;
}

const TS_ARGS = [process.env.TANUKI_TS_CLI ?? "dist/cli.js", "proxy"];
const [ts] = await runEngine("ts", "node", TS_ARGS, [REQ]);
const tsConv = await runEngine("ts", "node", [...TS_ARGS, "--auto-cache"], CONV); // the breakpoint is opt-in
const tsCases = await runEngine("ts", "node", TS_ARGS, CASES);
const pruneModes = [["stub", "--prune-tools", "stub", "--prune-min", "3"], ["drop", "--prune-tools", "drop", "--prune-min", "3"]];
const tsPrune = {};
for (const [m, ...a] of pruneModes) tsPrune[m] = await runEngine("ts", "node", [...TS_ARGS, ...a], PLIST, { TANUKI_TOOL_USAGE: usageFile(`ts-${m}`) });
// The Rust engine is a sibling worktree, not a dependency, so it is absent in
// a plain CI checkout. Compare cross-engine when it is there; otherwise still
// assert the single-engine invariants (breakpoint placement, recency window
// untouched, system prompt untouched) rather than silently passing on nothing.
const RS_BIN = process.env.TANUKI_BIN ?? "/tmp/tanuki-rust/target/release/tanuki-context";
const haveRust = existsSync(RS_BIN);
const [rs] = haveRust ? await runEngine("rust", RS_BIN, ["proxy"], [REQ]) : [null];
const rsConv = haveRust ? await runEngine("rust", RS_BIN, ["proxy", "--auto-cache"], CONV) : null;
const rsCases = haveRust ? await runEngine("rust", RS_BIN, ["proxy"], CASES) : null;
const rsPrune = {};
if (haveRust) for (const [m, ...a] of pruneModes) rsPrune[m] = await runEngine("rust", RS_BIN, ["proxy", ...a], PLIST, { TANUKI_TOOL_USAGE: usageFile(`rs-${m}`) });
upstream.close();
rmSync(EVENTS, { force: true });
for (const f of readdirSync(tmpdir())) if (f.startsWith(`tanuki-usage-parity-${process.pid}-`)) rmSync(join(tmpdir(), f), { force: true });

const jt = JSON.parse(ts);
const last = jt.messages[0].content.at(-1);
const latest = jt.messages.at(-1);
console.log(`ts   : ${jt.messages[0].content.length} blocks, ${jt.messages[0].content.filter((b) => b.type === "image").length} image(s)`);
console.log(`       breakpoint on last block: ${JSON.stringify(last.cache_control)}`);
console.log(`       trailing message untouched: ${latest.content[1].text === "latest question"}`);
console.log(`       system untouched: ${JSON.stringify(jt.system)}`);

// The invariant that binds for pixels: both engines must render PIXEL-identical
// pages. Their zlib encoders emit different compressed bytes for identical
// pixels, so lib/png.mjs inflates before comparing - see the note there.
const imgs = (s) => JSON.parse(s).messages[0].content.filter((b) => b.type === "image").map((b) => pngPixels(Buffer.from(b.source.data, "base64")));
const it = imgs(ts);
const ir = haveRust ? imgs(rs) : null;
const imgSame = !haveRust || (it.length === ir.length && it.every((d, i) => d.w === ir[i].w && d.h === ir[i].h && d.px.equals(ir[i].px)));
console.log(
  haveRust
    ? `\nimage pages: ${it.length} vs ${ir.length}, geometry ${it[0]?.w}x${it[0]?.h}, pixel-equal: ${imgSame}`
    : `\nimage pages: ${it.length}, geometry ${it[0]?.w}x${it[0]?.h} (cross-engine compare SKIPPED: no Rust binary at ${RS_BIN})`,
);

// The invariant that binds for everything else: RAW BYTES. Only the base64 PNG
// payload is masked (checked above as pixels).
const mask = (s) => s.replace(/"data":"[A-Za-z0-9+/=]*"/g, '"data":"<png>"');
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
function rawCompare(label, a, b) {
  if (!haveRust) { console.log(`${label}: n/a (single engine - nothing was compared)`); return true; }
  const [x, y] = [mask(a), mask(b)];
  const ok = x === y;
  console.log(`${label}: ${ok ? "IDENTICAL" : "DIFFER"} (${Buffer.byteLength(x)} vs ${Buffer.byteLength(y)} bytes, png payloads masked)`);
  if (!ok) {
    const i = firstDiff(x, y);
    console.log(`  first difference at byte ${i}\n    ts: ...${JSON.stringify(x.slice(Math.max(0, i - 40), i + 60))}\n    rs: ...${JSON.stringify(y.slice(Math.max(0, i - 40), i + 60))}`);
  }
  return ok;
}
const same = rawCompare("raw bodies (imaged + minified request)", ts, rs);

// The untouched parts are the client's own bytes: odd key order, spacing,
// escapes and number spellings, in each engine on its own.
const HEAD = REQ.slice(0, REQ.indexOf(JSON.stringify(BIG)) - '{"text":'.length);
const TAIL = REQ.slice(REQ.indexOf('},\n {"role":"assistant"'), REQ.indexOf(JSON.stringify(PRETTY)));
const spliced = [ts, rs].filter(Boolean).every((b) => b.startsWith(HEAD) && b.includes(TAIL) && LITERALS.every((l) => b.includes(l)));
console.log(`untouched bytes preserved (prefix, assistant tool_use, literals ${LITERALS.join(" ")}): ${spliced}`);

const minified = latest.content[0].content === MIN && latest.content[1].text === "latest question";
console.log(`latest tool_result minified (rule 7): ${minified}`);

// T8a: only the third request of the plain conversation carries a breakpoint, one,
// on the last block before the recency window.
const cc = (b) => (b.match(/"cache_control"/g) ?? []).length;
const convOk = tsConv.map(cc).join() === "0,0,1" && JSON.parse(tsConv[2]).messages[3].content.at(-1).cache_control?.type === "ephemeral";
const convSame = !haveRust || tsConv.every((b, i) => rawCompare(`raw bodies (conversation request ${i + 1})`, b, rsConv[i]));
if (!haveRust) console.log("raw bodies (conversation): n/a (single engine - nothing was compared)");
console.log(`auto breakpoint (breakpoints per request ${tsConv.map(cc).join("/")}, expected 0/0/1): ${convOk}`);

const caseNames = ["string content + non-BMP", "tool_result item arrays", "client tail block", "duplicate + escaped keys", "empty-object tail"];
// the pages of every case must be pixel-identical too; everything else raw bytes
const casesSame = !haveRust || tsCases.every((b, i) => rawCompare(`raw bodies (${caseNames[i]})`, b, rsCases[i]));
const casesPixels = !haveRust || tsCases.every((b, i) => {
  const grab = (t) => [...t.matchAll(/"data":"([A-Za-z0-9+/=]*)"/g)].map((m) => pngPixels(Buffer.from(m[1], "base64")));
  const [x, y] = [grab(b), grab(rsCases[i])];
  return x.length === y.length && x.every((d, j) => d.w === y[j].w && d.h === y[j].h && d.px.equals(y[j].px));
});
console.log(`pages of the extra cases pixel-identical: ${casesPixels}`);
// --prune-tools: raw bytes across engines, and the single-engine invariants (the tools that must
// survive do, the verdict is byte-stable across requests 1 and 2, a called tool is never reduced).
const toolNames = (b) => JSON.parse(b).tools.map((t) => t.name);
const toolsBytes = (b) => b.slice(b.indexOf('"tools"'), b.indexOf('"messages"'));
const pruneSame = !haveRust || pruneModes.every(([m]) => tsPrune[m].every((b, i) => rawCompare(`raw bodies (prune-tools ${m}, request ${i + 1})`, b, rsPrune[m][i])));
const pruneOk =
  toolNames(tsPrune.stub[0]).join() === "Bash,Grep,Notebook,Cached,Late,Few" &&
  JSON.parse(tsPrune.stub[0]).tools[1].description === "caf\u00e9 \u2603 \"quoted\" search tool, first line only" &&
  JSON.stringify(JSON.parse(tsPrune.stub[0]).tools[2]) === '{"name":"Notebook","description":"Edit notebooks","input_schema":{"type":"object"}}' &&
  toolNames(tsPrune.drop[0]).join() === "Bash,Cached,Late,Few" &&
  toolsBytes(tsPrune.drop[0]) === toolsBytes(tsPrune.drop[1]) &&
  toolNames(tsPrune.drop[2]).join() === "Bash,Grep,Cached,Late,Fewer" &&
  [3, 4].every((i) => ["stub", "drop"].every((m) => JSON.stringify(JSON.parse(tsPrune[m][i]).tools[2]) === JSON.stringify(JSON.parse(PLIST[i]).tools[2]))) &&
  // the evidence moved during the session (Grep was called in request 3, Few's advertise count crossed 3)
  toolNames(tsPrune.drop[3]).join() === "Bash,Grep,Notebook,Cached,Late" &&
  toolNames(tsPrune.drop[4]).join() === "Bash,Grep,Notebook,Cached,Late" &&
  ["stub", "drop"].every((m) => toolsBytes(tsPrune[m][5]) === toolsBytes(PLIST[5]));
console.log(`prune-tools verdict kept byte-stable, called tool kept: ${pruneOk}`);
const ok = same && convSame && casesSame && casesPixels && pruneSame && pruneOk && imgSame && spliced && minified && convOk && last?.cache_control?.type === "ephemeral";
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
