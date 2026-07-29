#!/usr/bin/env node
// Parity harness: TS port vs the rust binary. Byte-level where possible.
//   node reference/parity-ts.mjs [file...]
// Env: TANUKI_BIN (rust binary), TANUKI_TS ("bun src/cli.ts" | "node dist/cli.js")
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pixelEqual, pngPixels } from "./lib/png.mjs";
import { mcpSession } from "./lib/mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BIN = process.env.TANUKI_BIN || path.join(ROOT, "target", "release", "tanuki-context");
const TS = (process.env.TANUKI_TS ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const tsRun = (args, opts = {}) =>
  execFileSync(TS[0], [...TS.slice(1), ...args], { encoding: "utf8", maxBuffer: 1 << 28, cwd: ROOT, ...opts });
const rsRun = (args, opts = {}) =>
  execFileSync(BIN, args, { encoding: "utf8", maxBuffer: 1 << 28, cwd: ROOT, ...opts });

function syntheticLog() {
  const L = [];
  for (let i = 0; i < 300; i++) {
    const ts = `2026-07-15T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.123Z`;
    L.push(`${ts} INFO  heartbeat ok latency=${3 + (i % 7)}ms conn=a1b2c3d${i}e`);
    if (i % 3 === 0) L.push(`${ts} INFO  poll queue depth=${i % 11} worker=w-${i % 4}`);
  }
  L.push("2026-07-15T10:05:01.999Z ERROR connection refused to db-primary:5432 after 3 retries");
  for (let i = 0; i < 100; i++)
    L.push(`2026-07-15T10:06:${String(i % 60).padStart(2, "0")}.000Z INFO  retry backoff sleeping 500ms`);
  for (let i = 0; i < 20; i++)
    L.push(`fetching chunk ${i}: 10%\rfetching chunk ${i}: 55%\rfetching chunk ${i}: 100% done`);
  L.push("windows style line\r");
  L.push("done \u00e9\u00e8 \u4e2d\u6587\u30c6\u30b9\u30c8 \u{1F980} end");
  return L.join("\n");
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures++;
};
// Both engines emit topRepeats in deterministic first-seen order since the
// rust HashMap tie-order fix — compare everything exactly, no canonicalizing.
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmp = mkdtempSync(path.join(os.tmpdir(), "tanuki-parity-"));
const logFile = path.join(tmp, "synthetic.log");
writeFileSync(logFile, syntheticLog());
// deterministic NDJSON fixture: sparse keys (extra), a float that must stay
// fractional (0.75), and an integral float literal (3.0) that both engines
// must print as "3" inside table cells (integral-f64 coercion contract).
const ndjsonFile = path.join(tmp, "rows.ndjson");
writeFileSync(
  ndjsonFile,
  Array.from({ length: 240 }, (_, i) =>
    JSON.stringify({
      ts: `2026-07-26T04:${String(i % 60).padStart(2, "0")}:00Z`,
      level: i % 11 === 0 ? "error" : "info",
      unit: `svc-${i % 5}.service`,
      pid: 1000 + (i % 41),
      message: `copied segment_${String(i % 13).padStart(5, "0")}.parquet ok rc=0`,
      extra: i % 7 === 0 ? { retry: i % 3 } : undefined,
    }),
  ).join("\n") +
    '\n{"ts":"2026-07-26T05:00:00Z","level":"info","unit":"svc-0.service","pid":1,"message":"ratios","ratio":0.75,"count":3.0}' +
    '\n{"ts":"2026-07-26T05:00:01Z","level":"info","unit":"svc-0.service","pid":2,"message":"tab\\tand\\nnewline","ratio":0.5,"count":2}\n',
);
const events = path.join(tmp, "events.jsonl");
writeFileSync(events, [
  JSON.stringify({ ts: 1, tool: "tanuki_render", inputTokens: 1000, cacheRead: 200, cacheCreate: 50 }),
  JSON.stringify({ ts: 2, tool: "tanuki_estimate", inputTokens: 400 }),
  JSON.stringify({ ts: 3, tool: "proxy", input_tokens: 900, cache_read_tokens: 100, output_tokens: 4500 }),
].join("\n") + "\n");

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [logFile, ndjsonFile, path.join(ROOT, "README.md"), path.join(ROOT, "DESIGN.md"), fileURLToPath(import.meta.url)];

for (const file of files) {
  const name = path.basename(file);
  console.log(`\n== ${name} ==`);

  // distill CLI: full stats JSON
  const dTs = JSON.parse(tsRun(["distill", file]));
  const dRs = JSON.parse(rsRun(["distill", file]));
  check("distill stats deep-equal", deq(dTs, dRs), `ts=${JSON.stringify(dTs)}\n        rs=${JSON.stringify(dRs)}`);

  // estimate CLI: every level default, plus knob combos at level 2
  const combos = [
    ["0"], ["1"], ["2"], ["3"], ["4"],
    ["2", "--no-pack"], ["2", "--font", "tiny"], ["2", "--codebook"],
    ["2", "--distill"], ["0", "--no-pack", "--font", "tiny"], ["2", "--codebook", "--font", "tiny", "--distill"],
    // table knob: no-ops on prose files (gate), full path on rows.ndjson
    ["0", "--table"], ["2", "--table", "--distill"], ["0", "--table", "--codebook"],
    // situation-aware cost: provider tile counting + cache ratios must match
    ["0", "--model", "gpt-5"], ["0", "--model", "gemini-2.5-pro"],
    ["0", "--model", "claude-opus-4", "--cached"],
    ["0", "--table", "--model", "gpt-5", "--cached"],
  ];
  for (const c of combos) {
    const eTs = JSON.parse(tsRun(["estimate", file, ...c]));
    const eRs = JSON.parse(rsRun(["estimate", file, ...c]));
    check(`estimate ${c.join(" ")}`, deq(eTs, eRs), `ts=${JSON.stringify(eTs)}\n        rs=${JSON.stringify(eRs)}`);
  }

  // render CLI: JSON + pixel-exact PNGs. --distill included because the
  // summary tie-order bug (rust HashMap iteration) only showed on distilled
  // renders — the pixel compare must cover that path.
  for (const extra of [[], ["--no-pack"], ["--distill"], ["--distill", "--codebook"]]) {
    const oTs = path.join(tmp, `ts-${name}${extra.join("")}`);
    const oRs = path.join(tmp, `rs-${name}${extra.join("")}`);
    const rTs = JSON.parse(tsRun(["render", file, "0", oTs, ...extra]));
    const rRs = JSON.parse(rsRun(["render", file, "0", oRs, ...extra]));
    check(`render json ${extra.join(" ") || "(pack)"}`, deq(rTs, rRs), `ts=${JSON.stringify(rTs)}\n        rs=${JSON.stringify(rRs)}`);
    let pxOk = rTs.pages === rRs.pages;
    let pxDetail = "";
    for (let i = 0; pxOk && i < rRs.pages; i++) {
      const a = pngPixels(readFileSync(path.join(oTs, `page${i}.png`)));
      const b = pngPixels(readFileSync(path.join(oRs, `page${i}.png`)));
      if (a.w !== b.w || a.h !== b.h) { pxOk = false; pxDetail = `page${i} geom ${a.w}x${a.h} vs ${b.w}x${b.h}`; }
      else if (!a.px.equals(b.px)) { pxOk = false; pxDetail = `page${i} pixel mismatch`; }
    }
    check(`render pixels ${extra.join(" ") || "(pack)"}`, pxOk, pxDetail);
  }

  // stash/fetch CLI: id + overview byte-equal, slices byte-equal, imaged
  // fetches pixel-equal. Separate stash dirs prove both engines write.
  {
    const dTs = path.join(tmp, `stash-ts-${name}`);
    const dRs = path.join(tmp, `stash-rs-${name}`);
    const sTs = tsRun(["stash", file], { env: { ...process.env, TANUKI_STASH: dTs } });
    const sRs = rsRun(["stash", file], { env: { ...process.env, TANUKI_STASH: dRs } });
    check("stash overview", sTs === sRs, `ts=${JSON.stringify(sTs.slice(0, 200))}\n        rs=${JSON.stringify(sRs.slice(0, 200))}`);
    const id = sTs.split(" ")[1];
    const fTs = tsRun(["fetch", id, "--lines", "3-40"], { env: { ...process.env, TANUKI_STASH: dTs } });
    const fRs = rsRun(["fetch", id, "--lines", "3-40"], { env: { ...process.env, TANUKI_STASH: dRs } });
    check("fetch lines slice", fTs === fRs, "");
    const oTs = path.join(tmp, `fetch-ts-${name}`);
    const oRs = path.join(tmp, `fetch-rs-${name}`);
    const qTs = tsRun(["fetch", id, oTs, "--query", "error|ERROR"], { env: { ...process.env, TANUKI_STASH: dTs } });
    const qRs = rsRun(["fetch", id, oRs, "--query", "error|ERROR"], { env: { ...process.env, TANUKI_STASH: dRs } });
    let qOk = qTs === qRs;
    let qDetail = qOk ? "" : `ts=${qTs.slice(0, 160)} rs=${qRs.slice(0, 160)}`;
    if (qOk && qTs.startsWith('{"imageTokens"')) {
      const pages = JSON.parse(qTs.split("\n")[0]).pages;
      for (let i = 0; qOk && i < pages; i++) {
        const a = pngPixels(readFileSync(path.join(oTs, `page${i}.png`)));
        const b = pngPixels(readFileSync(path.join(oRs, `page${i}.png`)));
        if (a.w !== b.w || a.h !== b.h || !a.px.equals(b.px)) { qOk = false; qDetail = `fetch page${i} mismatch`; }
      }
    }
    check("fetch query (gated)", qOk, qDetail);
  }
}

// --- MCP protocol parity on one canonical session
console.log("\n== MCP session ==");
const text = readFileSync(logFile, "utf8");
// stash+verify parity: a controlled needle string so both engines derive the
// same id (sha256 first 12 hex, per stash) and verify byte-identically.
const vText = "alpha\nid 3451bd1b-13c4-4558-aa67-a62bc042905e beta\ngamma cafe1234 delta\n";
const vId = createHash("sha256").update(vText, "utf8").digest("hex").slice(0, 12);
// fetch parity: a needle-dense stash, so `tanuki_fetch` must decline to image
// and return the slice as text identically in both engines (0.14).
const fText = `${Array.from({ length: 400 }, (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a token=${String(i).padStart(4, "0")}cafebabe9f21`).join("\n")}\n`;
const fId = createHash("sha256").update(fText, "utf8").digest("hex").slice(0, 12);
// redaction parity (0.18): a slice carrying credential-shaped values, so a
// default fetch must mask them and a redact:false fetch must not, identically.
const secretText = `${Array.from({ length: 40 }, (_, i) =>
  i % 4 === 0
    ? `2026-07-27 cfg load AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI${String(i).padStart(2, "0")}K7MDENGbPxRfiCYEXAMPLEKEY`
    : `2026-07-27 worker-${i % 5} INFO handled request in ${i * 7}ms`,
).join("\n")}\n`;
const secretId = createHash("sha256").update(secretText, "utf8").digest("hex").slice(0, 12);
const requests = [
  { jsonrpc: "2.0", id: 2, method: "ping" },
  { jsonrpc: "2.0", id: 3, method: "tools/list" },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tanuki_compress", arguments: { text, level: 2 } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tanuki_distill", arguments: { text, query: "ERROR" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text, level: 3, distill: true, codebook: true } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tanuki_stats", arguments: {} } },
  { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "tanuki_render", arguments: { text, level: 1 } } },
  { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} } },
  { jsonrpc: "2.0", id: 10, method: "bogus/method" },
  { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "tanuki_stash", arguments: { text: vText } } },
  { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "tanuki_verify", arguments: { id: vId, value: "3451bd1b-13c4-4558-aa67-a62bc042905f" } } },
  { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "tanuki_verify", arguments: { id: vId, value: "cafe1234" } } },
  { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "tanuki_verify", arguments: { id: vId, value: "3451bd1b-13c4-4558-aa67-a62bc04290e5" } } },
  // sidecar classifier parity: every family the allowlist could not name
  // (MAC, git short sha, PCI id, pod name, base64, random alpha ids) must be
  // picked identically by both engines - see EVALS §7.
  {
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "tanuki_estimate",
      arguments: {
        text: [
          "relay dest=86:2b:11:51:58:03 unreachable after 34m51s",
          "merged 6c9224c into main; device 1022:14e5 bound to amdgpu",
          "pod api-worker-7d9f8b6c4-x2ktp evicted, node ip-10-2-30-4",
          "body aGVsbG8gd29ybGQxMjM0NTY3 sent ref=ryvkuvrdmg tag=YHFJNKGNSMTQBWC",
          "order ORD-5171-JRUBJMGB shipped; installed ocean-sound-theme lib32-libunistring",
          "2026-07-27T09:30:00Z worker INFO poll ok latency=14ms conn=3",
        ].join("\n"),
        level: 0,
      },
    },
  },
  // needle-dense gate parity: the sidecar budget overflows, so both engines
  // must refuse to image and say so identically (0.13.1 fix - a budgeted
  // sidecar stays cheap while dropping the ids it exists to carry).
  {
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "tanuki_estimate",
      arguments: {
        text: Array.from(
          { length: 40 },
          (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a token=${String(i).padStart(4, "0")}cafebabe9f21`,
        ).join("\n"),
        level: 0,
      },
    },
  },
  // render must REFUSE a needle-dense block, byte-identically, in both
  // engines (0.13.2 - estimate alone was gated, the action path was not).
  {
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "tanuki_render",
      arguments: {
        text: Array.from(
          { length: 40 },
          (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a token=${String(i).padStart(4, "0")}cafebabe9f21`,
        ).join("\n"),
        level: 0,
      },
    },
  },
  // stash a needle-dense text, then fetch it: both engines must decline to
  // image and hand back the slice as text (0.14 - fetch used to image with no
  // verbatim sidecar at all).
  { jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "tanuki_stash", arguments: { text: fText } } },
  { jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "tanuki_fetch", arguments: { id: fId, lines: "1-400" } } },
  // a query fetch reports the raw match count identically in both engines
  { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "tanuki_fetch", arguments: { id: fId, query: "cafebabe9f21" } } },
  // measured weak reader: both engines must floor the band and refuse to image
  { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text, level: 0, model: "claude-haiku-4-5" } } },
  { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text, level: 0, model: "claude-opus-5" } } },
  // 0.18 lazy sidecar: one pointer line instead of the carried strings. Both
  // engines must emit it character-for-character, including the id= clause.
  { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "tanuki_render", arguments: { text, verbatim: "lazy" } } },
  { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "tanuki_fetch", arguments: { id: fId, lines: "1-400", verbatim: "lazy" } } },
  // an unrecognised verbatim value must fall back to full in BOTH engines
  { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "tanuki_render", arguments: { text, verbatim: "nonsense" } } },
  // 0.18 redaction: a fetched slice masks credentials by default, returns raw
  // bytes under redact:false. Both engines must agree on the mask and count.
  { jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "tanuki_stash", arguments: { text: secretText } } },
  { jsonrpc: "2.0", id: 27, method: "tools/call", params: { name: "tanuki_fetch", arguments: { id: secretId, lines: "1-40" } } },
  { jsonrpc: "2.0", id: 28, method: "tools/call", params: { name: "tanuki_fetch", arguments: { id: secretId, lines: "1-40", redact: false } } },
  // 0.19 estimator: it prices character CLASSES, so the classifier boundaries
  // (word-like vs vowelless vs overlong runs, digits, punctuation) are where the
  // two engines can silently disagree. `chars/4` had no boundaries to disagree
  // about; these do. Empty, astral-plane and pure-base64 inputs pin the edges,
  // and the camelCase case pins the documented 239% pathology (EVALS §9) so it
  // cannot drift in one engine only.
  { jsonrpc: "2.0", id: 29, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: "", level: 0 } } },
  { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: "\u00e9\u00fc\u4e2d\u6587 \u2603 mixed \u{1f600} unicode ".repeat(200), level: 0 } } },
  { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 37) % 251)).toString("base64"), level: 0 } } },
  { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: "someLongCamelCaseIdentifierNumber42 = anotherCamelCaseValue126;\n".repeat(120), level: 0 } } },
];
const env = { TANUKI_EVENTS: events, TANUKI_STASH: tmp };
const [tsOut, rsOut] = await Promise.all([
  mcpSession(TS[0], [...TS.slice(1)], requests, { cwd: ROOT, env }),
  mcpSession(BIN, [], requests, { cwd: ROOT, env }),
]);
// A dead engine yields zero replies, and `0 === 0` would sail through a pure
// equality check while the loop below compares nothing and the file prints ALL
// PASS. The shared client parses whatever arrives instead of throwing on empty
// stdout, so demand that every request id was actually answered by both.
const answered = (out) => requests.every((r) => out.some((m) => m.id === r.id));
check(
  "MCP reply count",
  tsOut.length === rsOut.length && answered(tsOut) && answered(rsOut),
  `${tsOut.length} vs ${rsOut.length}, ${requests.length} ids requested`,
);
// Label each check from the reply id, not the array index: the handshake sends
// two lines but only `initialize` answers, so index-matching named every check
// after it one request early. Only the id=1 reply has no entry here.
const methodById = new Map(requests.map((r) => [r.id, r.method]));
for (let i = 0; i < Math.min(tsOut.length, rsOut.length); i++) {
  const a = tsOut[i], b = rsOut[i];
  // renders return PNGs, whose compressed bytes differ by zlib encoder; compare
  // their text blocks verbatim and their images by decoded pixels
  if (b.id === 8 || b.id === 23 || b.id === 25) {
    const ta = a.result.content, tb = b.result.content;
    let ok = ta.length === tb.length;
    let detail = ok ? "" : `content len ${ta.length} vs ${tb.length}`;
    for (let j = 0; ok && j < tb.length; j++) {
      if (tb[j].type === "text") {
        ok = ta[j].type === "text" && ta[j].text === tb[j].text;
        if (!ok) detail = `text block ${j}:\n        ts=${JSON.stringify(ta[j].text)}\n        rs=${JSON.stringify(tb[j].text)}`;
      } else {
        ok = pixelEqual(ta[j].data, tb[j].data);
        if (!ok) detail = `image block ${j} mismatch`;
      }
    }
    check("MCP tanuki_render (pixels)", ok, detail);
  } else {
    check(`MCP id=${b.id ?? "?"} ${methodById.get(b.id) ?? "initialize"}`, deq(a, b),
      `ts=${JSON.stringify(a).slice(0, 400)}\n        rs=${JSON.stringify(b).slice(0, 400)}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
