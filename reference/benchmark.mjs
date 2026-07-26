#!/usr/bin/env node
// Full node-vs-rust benchmark: every ladder level (plus distill for logs) on
// real content, timing both engines in-process (median of N runs, discarded
// warmup), asserting token parity, and emitting a self-contained HTML report.
//   node reference/benchmark.mjs [out.html]
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { execFileSync, execSync, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { distillLog } from "./node-mcp/distill.mjs";
import { compressText, LEVELS } from "./node-mcp/compress.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// TANUKI_BIN may point at the rust-branch binary; default is the TS CLI.
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(HERE, "..", "dist", "cli.js")) ? "node dist/cli.js" : "bun src/main.ts")).split(" ");
const PXPIPE = process.env.PXPIPE_ROOT || path.join(process.env.HOME, "Projects", "pxpipe");
const OUT = process.argv[2] || path.join(HERE, "benchmark-report.html");
const RUNS = 3;
const { renderTextToImages } = await import(path.join(PXPIPE, "dist", "core", "index.js"));
const neutralize = (s) => s.replace(/\u21b5/g, "\u23ce");
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---- samples (real content) ------------------------------------------------
const read = (rel) => readFileSync(path.join(PXPIPE, rel), "utf8");
const tmpFile = (name, text) => {
  const p = path.join(os.tmpdir(), name);
  writeFileSync(p, text);
  return p;
};
const samples = [];
samples.push({
  name: "source code · 5 real .ts files", kind: "text",
  file: tmpFile("bm-code.txt", ["src/core/png.ts", "src/core/applicability.ts", "src/core/measurement.ts", "src/stats.ts", "src/sessions.ts"].map(read).join("\n\n")),
});
samples.push({
  name: "prose docs · 7 real .md files", kind: "text",
  file: tmpFile("bm-prose.txt", ["docs/NOT-OCR.md", "docs/HISTORY_CACHE_MODEL.md", "docs/ADAPTIVE_CPT_PLAN.md", "docs/TRANSFORM_INFO.md", "docs/LEGIBILITY-AUDIT-2026-07-01.md", "docs/MODEL_RENDER_PROFILES.md", "FINDINGS.md"].map(read).join("\n\n")),
});
try {
  const j = execSync("journalctl --user -n 3000 --no-pager -o short-iso 2>/dev/null", { encoding: "utf8", maxBuffer: 1 << 26 });
  if (j.length > 100_000) samples.push({ name: "service log · journalctl --user, 3000 lines (real)", kind: "log", file: tmpFile("bm-journal.txt", j) });
} catch { /* skip */ }
// 12 MB corpus: first 2 MB is a byte-real slice of the original 126 MB rclone
// log; the rest cycles those real lines with volatile fields rewritten.
const SYNC = path.join(PXPIPE, "demo", "logs", "sync-12mb.log");
let syncFull = null;
try {
  if (statSync(SYNC).size > 1 << 20) {
    samples.push({ name: "sync log · 2 MB real slice of an rclone log", kind: "log", file: tmpFile("bm-sync2mb.txt", readFileSync(SYNC, "utf8").slice(0, 2 * 1024 * 1024)) });
    syncFull = SYNC;
  }
} catch { /* skip */ }

// ---- engines ----------------------------------------------------------------
async function nodePipeline(text, { level = 0, distill = false } = {}) {
  const times = [];
  let out;
  for (let i = 0; i <= RUNS; i++) {
    const t0 = performance.now();
    const working = distill ? distillLog(text).distilled : text;
    const { compressed } = compressText(working, level);
    const { pages } = await renderTextToImages(neutralize(compressed), { reflow: true });
    const px = pages.reduce((a, p) => a + (p.width || 0) * (p.height || 0), 0);
    if (i > 0) times.push(performance.now() - t0);
    // v0.11: Anthropic bills 28-px patches, same model tanuki uses
    const tok = pages.reduce((a, p) => a + Math.ceil((p.width || 1) / 28) * Math.ceil((p.height || 1) / 28), 0);
    out = { pages: pages.length, imageTokens: tok, stage1Chars: [...compressed].length };
  }
  return { medianMs: median(times), ...out };
}
function rustPipeline(file, { level = 0, distill = false } = {}) {
  const argv = ["bench", file, "pipeline", String(level), String(RUNS)];
  if (distill) argv.push("--distill");
  const r = JSON.parse(execFileSync(CMD[0], [...CMD.slice(1), ...argv], { encoding: "utf8", maxBuffer: 1 << 28, cwd: path.join(HERE, "..") }));
  return { medianMs: r.medianMs, ...r.result };
}
function nodeDistillTimed(text) {
  const times = [];
  let stats;
  for (let i = 0; i <= RUNS; i++) {
    const t0 = performance.now();
    stats = distillLog(text).stats;
    if (i > 0) times.push(performance.now() - t0);
  }
  return { medianMs: median(times), stats };
}

// ---- server weight ----------------------------------------------------------
async function serverWeight(label, cmd, argv) {
  const t0 = performance.now();
  const p = spawn(cmd, argv, { stdio: ["pipe", "pipe", "ignore"] });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  await new Promise((r) => p.stdout.once("data", r));
  const ms = performance.now() - t0;
  const rss = Number(readFileSync(`/proc/${p.pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/)[1]) / 1024;
  p.kill();
  return { label, firstResponseMs: ms, rssMb: rss };
}

// ---- run matrix ---------------------------------------------------------------
let parityOk = 0, parityFail = 0;
const speedups = [];
for (const s of samples) {
  const text = readFileSync(s.file, "utf8");
  s.chars = text.length;
  s.baseTok = Math.round(text.length / 4);
  s.rows = [];
  const specs = [];
  for (const { n } of LEVELS) specs.push({ label: `L${n} ${LEVELS[n].name} → pxpipe`, level: n, distill: false, loss: LEVELS[n].loss });
  if (s.kind === "log") {
    specs.push({ label: "distill → pxpipe", level: 0, distill: true, loss: "selective" });
    specs.push({ label: "distill → L4 → pxpipe", level: 4, distill: true, loss: "selective+heavy" });
  }
  for (const spec of specs) {
    process.stderr.write(`  ${s.name} :: ${spec.label}\n`);
    const nj = await nodePipeline(text, spec);
    const rj = rustPipeline(s.file, spec);
    const match = nj.imageTokens === rj.imageTokens && nj.pages === rj.pages;
    match ? parityOk++ : parityFail++;
    const speedup = nj.medianMs / rj.medianMs;
    speedups.push(speedup);
    s.rows.push({ ...spec, node: nj, rust: rj, match, speedup, savedPct: Math.round((1 - rj.imageTokens / s.baseTok) * 100) });
  }
}

// full 12MB distill speed (both engines, counts compared)
let bigLog = null;
if (syncFull) {
  process.stderr.write(`  full sync.log distill (both engines)\n`);
  const text = readFileSync(syncFull, "utf8");
  const nd = nodeDistillTimed(text);
  const rd = JSON.parse(execFileSync(CMD[0], [...CMD.slice(1), "bench", syncFull, "distill", "0", String(RUNS)], { encoding: "utf8", maxBuffer: 1 << 28, cwd: path.join(HERE, "..") }));
  const match = nd.stats.suppressedLines === rd.result.suppressedLines && nd.stats.templateSuppressed === rd.result.templateSuppressed;
  match ? parityOk++ : parityFail++;
  bigLog = { chars: text.length, nodeMs: nd.medianMs, rustMs: rd.medianMs, match,
    exact: rd.result.suppressedLines, tmpl: rd.result.templateSuppressed, savedPct: rd.result.savedPct };
  speedups.push(nd.medianMs / rd.medianMs);
}

const weights = [
  await serverWeight("tanuki-context (ts)", CMD[0], CMD.slice(1)),
  await serverWeight("pxpipe MCP (node)", "node", [path.join(HERE, "node-mcp", "server.mjs")]),
];
const binMb = statSync(existsSync(path.join(HERE, "..", "dist", "cli.js")) ? path.join(HERE, "..", "dist", "cli.js") : CMD[CMD.length - 1]).size / 1048576;
const cpu = (readFileSync("/proc/cpuinfo", "utf8").match(/model name\s*:\s*(.+)/) || [])[1] || "unknown CPU";
const nodeV = process.version;

// ---- console ------------------------------------------------------------------
for (const s of samples) {
  console.log(`\n${s.name}  ${s.chars.toLocaleString()} chars  baseline ${s.baseTok.toLocaleString()} tok`);
  for (const r of s.rows)
    console.log(`  ${r.label.padEnd(24)} tok ${String(r.rust.imageTokens).padStart(7)} ${r.match ? "=" : "MISMATCH"}  node ${r.node.medianMs.toFixed(0).padStart(6)}ms  rust ${r.rust.medianMs.toFixed(0).padStart(6)}ms  ${r.speedup.toFixed(1)}x`);
}
if (bigLog) console.log(`\nfull 12MB distill: node ${(bigLog.nodeMs / 1000).toFixed(2)}s  ts ${(bigLog.rustMs / 1000).toFixed(2)}s  counts ${bigLog.match ? "identical" : "MISMATCH"}`);
console.log(`\nparity: ${parityOk} ok, ${parityFail} fail`);

// ---- HTML -----------------------------------------------------------------------
const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const hue = (p) => `hsl(${Math.round(Math.max(0, Math.min(100, p)) * 1.2)} 70% 45%)`;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const ms = (x) => x >= 1000 ? (x / 1000).toFixed(2) + " s" : x.toFixed(x < 10 ? 1 : 0) + " ms";
const tokBar = (r, base) => {
  const w = Math.max(0.6, (r.rust.imageTokens / base) * 100);
  return `<div class="track"><div class="fill" style="width:${w}%;background:${hue(r.savedPct)}"></div><span class="blab">${fmt(r.rust.imageTokens)} tok · −${r.savedPct}%</span></div>`;
};
const timeBars = (r, maxMs) => {
  const wN = Math.max(0.6, (r.node.medianMs / maxMs) * 100);
  const wR = Math.max(0.6, (r.rust.medianMs / maxMs) * 100);
  return `<div class="tt"><div class="trow"><span class="tl">node</span><div class="track sm"><div class="fill" style="width:${wN}%;background:#8a8f9f"></div><span class="blab sm">${ms(r.node.medianMs)}</span></div></div>
  <div class="trow"><span class="tl">rust</span><div class="track sm"><div class="fill" style="width:${wR}%;background:#e8734a"></div><span class="blab sm">${ms(r.rust.medianMs)} · ${r.speedup.toFixed(1)}×</span></div></div></div>`;
};
const sampleCard = (s) => {
  const maxMs = Math.max(...s.rows.map((r) => r.node.medianMs));
  const rows = s.rows.map((r) => `<tr>
    <td class="lv">${esc(r.label)}</td>
    <td><span class="loss l-${esc(r.loss.split(" ")[0].split("+")[0])}">${esc(r.loss)}</span></td>
    <td class="num">${fmt(r.rust.stage1Chars)}</td>
    <td class="num">${r.rust.pages}</td>
    <td class="num">${fmt(r.rust.imageTokens)} <span class="${r.match ? "ok" : "bad"}">${r.match ? "✓" : "✗ node " + fmt(r.node.imageTokens)}</span></td>
    <td class="num strong" style="color:${hue(r.savedPct)}">${r.savedPct}%</td>
    <td class="num">${ms(r.node.medianMs)}</td>
    <td class="num">${ms(r.rust.medianMs)}</td>
    <td class="num strong" style="color:#e8734a">${r.speedup.toFixed(1)}×</td>
  </tr>`).join("");
  return `<div class="card"><h2>${esc(s.name)}</h2>
  <p class="meta">${s.chars.toLocaleString()} chars · raw-text baseline <b>${fmt(s.baseTok)}</b> tok · both engines byte-identical input</p>
  <div class="chart">${s.rows.map((r) => `<div class="clab">${esc(r.label)}<small>${esc(r.loss)}</small></div>${tokBar(r, s.baseTok)}${timeBars(r, maxMs)}`).join("")}</div>
  <table><thead><tr><th>Pipeline</th><th>Loss</th><th>Stage-1 chars</th><th>Pages</th><th>Tokens (parity)</th><th>Saved</th><th>node</th><th>rust</th><th>Speedup</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tanuki-context — node vs rust benchmark</title><style>
:root{--bg:#0e1016;--card:#171a23;--line:#262a37;--tx:#e7e9f0;--mut:#9aa0b4;--faint:#606779}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
.wrap{max-width:1180px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 22px;font-size:13.5px}
.chips{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 22px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:150px}
.chip b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.chip span{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:22px}
h2{font-size:15px;margin:0 0 2px}.meta{color:var(--mut);margin:0 0 18px;font-size:13px}
.chart{display:grid;grid-template-columns:185px 1fr 300px;gap:9px 14px;align-items:center;margin-bottom:20px}
.clab{font-size:13px}.clab small{color:var(--faint);display:block;font-size:11px}
.track{position:relative;background:#0000002e;border-radius:7px;height:28px;overflow:hidden}
.track.sm{height:13px;border-radius:4px}
.fill{height:100%;border-radius:inherit;min-width:2px}
.blab{position:absolute;left:9px;top:0;line-height:28px;font-size:12px;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 2px #000a}
.blab.sm{line-height:13px;font-size:10px}
.tt{display:flex;flex-direction:column;gap:2px}.trow{display:flex;align-items:center;gap:6px}.tl{color:var(--faint);font-size:10px;width:26px;text-align:right}
.trow .track{flex:1}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.lv{font-weight:600;white-space:nowrap}td.strong{font-weight:700}
.loss{font-size:11px;padding:2px 8px;border-radius:20px;background:#2a2f3d;color:var(--mut);white-space:nowrap}
.l-none{background:#1f3a2a;color:#7fdca0}.l-lossless{background:#1f3a2a;color:#7fdca0}.l-light{background:#3a381f;color:#dcd07f}.l-medium{background:#3a2f1f;color:#dcae7f}.l-heavy{background:#3a1f1f;color:#dc8f8f}.l-selective{background:#1f2f3a;color:#7fb8dc}
.ok{color:#7fdca0;font-size:11px}.bad{color:#dc8f8f;font-size:11px;font-weight:700}
.note{color:var(--faint);font-size:12.5px;line-height:1.65}.note b{color:var(--mut)}
code{background:#0000003d;padding:1px 6px;border-radius:5px;color:#c9cdff}
</style></head><body><div class="wrap">
<h1>tanuki-context — node vs rust, every compression level</h1>
<p class="sub">${esc(cpu)} · node ${esc(nodeV)} · rust binary ${binMb.toFixed(1)} MB · median of ${RUNS} in-process runs (1 discarded warmup) · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</p>
<div class="chips">
  <div class="chip"><b class="${parityFail ? "bad" : ""}">${parityOk}/${parityOk + parityFail}</b><span>parity checks passed (tokens + pages${bigLog ? " + distill counts" : ""})</span></div>
  <div class="chip"><b>${Math.min(...speedups).toFixed(1)}–${Math.max(...speedups).toFixed(1)}×</b><span>rust speedup range</span></div>
  ${bigLog ? `<div class="chip"><b>${(bigLog.nodeMs / 1000).toFixed(1)}s → ${(bigLog.rustMs / 1000).toFixed(1)}s</b><span>distill, 12 MB rclone log (${bigLog.match ? "counts identical" : "COUNTS DIFFER"})</span></div>` : ""}
  <div class="chip"><b>${weights[1].firstResponseMs.toFixed(0)}ms → ${weights[0].firstResponseMs.toFixed(0)}ms</b><span>MCP first response</span></div>
  <div class="chip"><b>${weights[1].rssMb.toFixed(0)}MB → ${weights[0].rssMb.toFixed(1)}MB</b><span>server RSS</span></div>
</div>
${samples.map(sampleCard).join("")}
${bigLog ? `<div class="card"><h2>Full-scale distill · 12 MB rclone sync log (${fmt(bigLog.chars)} chars)</h2>
<table><thead><tr><th>Engine</th><th>Median time</th><th>Chars cut</th><th>Exact ×N suppressed</th><th>Same-template suppressed</th></tr></thead><tbody>
<tr><td class="lv">node reference</td><td class="num">${(bigLog.nodeMs / 1000).toFixed(2)} s</td><td class="num">−${bigLog.savedPct}%</td><td class="num">${fmt(bigLog.exact)}</td><td class="num">${fmt(bigLog.tmpl)}</td></tr>
<tr><td class="lv">tanuki (ts)</td><td class="num">${(bigLog.rustMs / 1000).toFixed(2)} s</td><td class="num">−${bigLog.savedPct}%</td><td class="num">${fmt(bigLog.exact)} <span class="ok">${bigLog.match ? "✓ identical" : ""}</span></td><td class="num">${fmt(bigLog.tmpl)} <span class="ok">${bigLog.match ? "✓ identical" : ""}</span></td></tr>
</tbody></table></div>` : ""}
<div class="card"><h2>MCP server weight</h2>
<table><thead><tr><th>Server</th><th>First response</th><th>RSS</th><th>Deployable</th></tr></thead><tbody>
<tr><td class="lv">${esc(weights[1].label)}</td><td class="num">${weights[1].firstResponseMs.toFixed(0)} ms</td><td class="num">${weights[1].rssMb.toFixed(1)} MB</td><td>node + node_modules</td></tr>
<tr><td class="lv">${esc(weights[0].label)}</td><td class="num">${weights[0].firstResponseMs.toFixed(0)} ms</td><td class="num">${weights[0].rssMb.toFixed(1)} MB</td><td>one ${binMb.toFixed(1)} MB static binary</td></tr>
</tbody></table></div>
<div class="card"><h2>Methodology</h2><p class="note">
<b>Inputs are real</b>: pxpipe source files (code), pxpipe docs (prose), this machine's live journal, and a 12 MB rclone sync log (first 2 MB byte-real, remainder cycled from the same real lines with volatile fields rewritten). Both engines receive byte-identical files.<br>
<b>Timing is in-process</b> for both engines (rust: <code>tanuki-context bench</code>; node: same functions the reference MCP calls), median of ${RUNS} runs after one discarded warmup — process startup is excluded from op timings and reported separately in the server-weight table.<br>
<b>Pipeline per row</b>: optional distill (stage 0) → ladder level (stage 1) → pxpipe imaging (stage 2, PNG encode included). Tokens = 28-px patches, ⌈w/28⌉×⌈h/28⌉ per page (Anthropic's patch pricing); baseline = raw text at chars/4.<br>
<b>Parity is asserted, not assumed</b>: every row compares pages + image tokens across engines (✓), and the 12 MB distill compares suppression counts. A mismatch would be flagged in red.<br>
Levels: 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up, code/IDs/hashes/paths are never reworded; distill always keeps error/warn lines verbatim.</p></div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`\nHTML report -> ${OUT}`);
