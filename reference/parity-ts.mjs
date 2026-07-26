#!/usr/bin/env node
// Parity harness: TS port vs the rust binary. Byte-level where possible.
//   node reference/parity-ts.mjs [file...]
// Env: TANUKI_BIN (rust binary), TANUKI_TS ("bun src/cli.ts" | "node dist/cli.js")
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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

// Decode a grayscale filter-0 PNG produced by either encoder -> raw pixel bytes.
function pngPixels(buf) {
  let off = 8;
  const idat = [];
  let w = 0, h = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w + 1)] !== 0) throw new Error(`non-zero PNG filter at row ${y}`);
    raw.copy(px, y * w, y * (w + 1) + 1, (y + 1) * (w + 1));
  }
  return { w, h, px };
}

// --- MCP: drive both servers with identical request lines, compare replies.
function mcpSession(cmd, args, lines, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out.trim().split("\n").map((l) => JSON.parse(l))));
    p.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    p.stdin.end();
  });
}

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
const req = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "ping" },
  { jsonrpc: "2.0", id: 3, method: "tools/list" },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tanuki_compress", arguments: { text, level: 2 } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tanuki_distill", arguments: { text, query: "ERROR" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text, level: 3, distill: true, codebook: true } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tanuki_stats", arguments: {} } },
  { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "tanuki_render", arguments: { text, level: 1 } } },
  { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} } },
  { jsonrpc: "2.0", id: 10, method: "bogus/method" },
];
const env = { TANUKI_EVENTS: events };
const [tsOut, rsOut] = await Promise.all([
  mcpSession(TS[0], [...TS.slice(1)], req, env),
  mcpSession(BIN, [], req, env),
]);
check("MCP reply count", tsOut.length === rsOut.length, `${tsOut.length} vs ${rsOut.length}`);
for (let i = 0; i < Math.min(tsOut.length, rsOut.length); i++) {
  const a = tsOut[i], b = rsOut[i];
  if (b.id === 8) {
    // render: compare text blocks verbatim, images by decoded pixels
    const ta = a.result.content, tb = b.result.content;
    let ok = ta.length === tb.length;
    let detail = ok ? "" : `content len ${ta.length} vs ${tb.length}`;
    for (let j = 0; ok && j < tb.length; j++) {
      if (tb[j].type === "text") {
        ok = ta[j].type === "text" && ta[j].text === tb[j].text;
        if (!ok) detail = `text block ${j}:\n        ts=${JSON.stringify(ta[j].text)}\n        rs=${JSON.stringify(tb[j].text)}`;
      } else {
        const pa = pngPixels(Buffer.from(ta[j].data, "base64"));
        const pb = pngPixels(Buffer.from(tb[j].data, "base64"));
        ok = pa.w === pb.w && pa.h === pb.h && pa.px.equals(pb.px);
        if (!ok) detail = `image block ${j} mismatch`;
      }
    }
    check("MCP tanuki_render (pixels)", ok, detail);
  } else {
    check(`MCP id=${b.id ?? "?"} ${req[i]?.method ?? ""}`, deq(a, b),
      `ts=${JSON.stringify(a).slice(0, 400)}\n        rs=${JSON.stringify(b).slice(0, 400)}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
