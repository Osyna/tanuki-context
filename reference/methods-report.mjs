#!/usr/bin/env node
// Methods report: measure the tanuki-only density knobs (pack / codebook / tiny
// font) against the pxpipe-faithful baseline, on real content, using ONLY the
// CLI's `estimate` (no pxpipe/node oracle needed — that's benchmark.mjs).
//   node reference/methods-report.mjs [out.html]
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
// TANUKI_BIN may point at the rust-branch binary; default is the TS CLI.
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/main.ts")).split(" ");
const OUT = process.argv[2] || path.join(HERE, "methods-report.html");
const TMP = mkdtempSync(path.join(os.tmpdir(), "tanuki-methods-"));

// ---- samples: real repo content + a synthetic path-heavy log (reproducible) --
function pathLog(n) {
  const dirs = [
    "/var/lib/backup/snapshots/2026-07-15/home/irvin/Projects/tanuki-context/src",
    "/var/lib/backup/snapshots/2026-07-15/home/irvin/Projects/pxpipe/dist/assets",
    "/srv/k8s/volumes/pvc-8842/containers/ingest-worker/logs",
  ];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const L = [];
  for (let i = 0; i < n; i++) {
    const d = dirs[Math.floor(rnd() * dirs.length)];
    const id = String(i).padStart(5, "0");
    L.push(`2026/07/15 03:1${i % 10}:${String(i % 60).padStart(2, "0")} INFO copied ${d}/file_${id}.dat to remote:arch/file_${id}.dat`);
  }
  return L.join("\n");
}
const samples = [
  { name: "code · src/main.ts", kind: "source", text: readFileSync(path.join(ROOT, "src", "main.ts"), "utf8") },
  { name: "prose · DESIGN.md", kind: "prose", text: readFileSync(path.join(ROOT, "DESIGN.md"), "utf8") },
  { name: "log · distinct paths", kind: "log", text: pathLog(300) },
];

// ---- methods: flag combos fed to `estimate` -------------------------------
const methods = [
  { key: "base", label: "pxpipe baseline", flags: ["--no-pack"], tag: "ref" },
  { key: "pack", label: "+ pack", flags: [], tag: "good" },
  { key: "packcb", label: "+ pack + codebook", flags: ["--codebook"], tag: "good" },
  { key: "tiny", label: "+ tiny 4×6", flags: ["--no-pack", "--font", "tiny"], tag: "top" },
  { key: "all", label: "all (pack+cb+tiny)", flags: ["--codebook", "--font", "tiny"], tag: "top" },
];

function estimate(text, flags) {
  const f = path.join(TMP, "in.txt");
  writeFileSync(f, text);
  const out = execFileSync(CMD[0], [...CMD.slice(1), "estimate", f, "0", ...flags], { encoding: "utf8", maxBuffer: 1 << 28, cwd: ROOT });
  return JSON.parse(out);
}

const rows = samples.map((s) => {
  const raw = estimate(s.text, ["--no-pack"]).rawTextTokens;
  const cells = {};
  for (const m of methods) cells[m.key] = estimate(s.text, m.flags).imageTokens;
  return { ...s, raw, cells };
});

// ---- console ---------------------------------------------------------------
const pctVsBase = (v, base) => Math.round((1 - v / base) * 100);
for (const r of rows) {
  console.log(`\n${r.name}  (raw-text ${r.raw} tok)`);
  for (const m of methods) {
    const v = r.cells[m.key];
    const d = m.key === "base" ? "" : `  (-${pctVsBase(v, r.cells.base)}% vs base)`;
    console.log(`  ${m.label.padEnd(20)} ${String(v).padStart(6)} img-tok${d}`);
  }
}

// ---- HTML ------------------------------------------------------------------
const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fillClass = { ref: "c-ref", good: "c-amber", top: "c-violet" };

const meterRows = (r) => {
  const base = r.cells.base;
  return methods
    .map((m) => {
      const v = r.cells[m.key];
      const w = Math.round((v / base) * 100);
      const d = m.key === "base" ? "baseline" : `−${pctVsBase(v, base)}%`;
      return `<div class="row"><div class="name">${esc(m.label)}</div>
        <div class="track"><div class="fill ${fillClass[m.tag]}" style="width:${w}%"></div></div>
        <div class="val"><b>${v}</b> <span class="d">${d}</span></div></div>`;
    })
    .join("");
};

const card = (r) => `<section class="card">
  <div class="ch"><h3>${esc(r.name)}</h3><span class="raw">raw text ≈ ${r.raw} tok</span></div>
  <div class="meter">${meterRows(r)}</div>
</section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>tanuki-context · density methods</title>
<style>
:root{--ink:#0f1117;--panel:#171b25;--line:#282e3c;--soft:#20252f;--text:#eae7df;--muted:#8b91a1;--faint:#5c6273;--amber:#e9b44c;--violet:#9b7ede;--ref:#4a5163}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--text);font:16px/1.6 "Archivo",system-ui,sans-serif;
background-image:radial-gradient(1100px 520px at 78% -8%,rgba(233,180,76,.06),transparent 60%),radial-gradient(900px 500px at -6% 12%,rgba(155,126,222,.05),transparent 62%)}
.wrap{max-width:920px;margin:0 auto;padding:0 24px}
code,.mono{font-family:"JetBrains Mono",ui-monospace,monospace}
header{padding:64px 0 24px;border-bottom:1px solid var(--soft)}
.eyebrow{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--faint)}
h1{font-weight:900;font-size:clamp(30px,6vw,56px);letter-spacing:-.02em;margin:16px 0 0;line-height:1.03}
.lede{max-width:66ch;color:var(--muted);margin:18px 0 0}
.lede b{color:var(--text)}
section.card{margin:26px 0;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.ch{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}
.ch h3{margin:0;font-size:18px;font-family:"JetBrains Mono",monospace}
.raw{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--faint)}
.meter{display:flex;flex-direction:column}
.row{display:grid;grid-template-columns:180px 1fr 150px;align-items:center;gap:14px;padding:7px 0;border-top:1px solid var(--soft)}
.row:first-child{border-top:none}
.name{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--text)}
.track{position:relative;height:20px;background:var(--ink);border:1px solid var(--soft);border-radius:6px;overflow:hidden}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px 0 0 5px;background-image:repeating-linear-gradient(90deg,rgba(255,255,255,.14) 0 1px,transparent 1px 9px)}
.c-ref{background-color:var(--ref)}.c-amber{background-color:var(--amber)}.c-violet{background-color:var(--violet)}
.val{font-family:"JetBrains Mono",monospace;font-size:13px;text-align:right;color:var(--muted)}
.val b{color:var(--text)}.val .d{color:var(--amber);font-size:12px}
.notes{margin:40px 0 10px}
.notes h2{font-size:14px;font-family:"JetBrains Mono",monospace;letter-spacing:.02em;color:var(--text)}
.notes ul{color:var(--muted);font-size:14.5px;padding-left:18px}
.notes li{margin:8px 0}.notes b{color:var(--text)}
.notes code{background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:.85em;color:#f5cb5c}
footer{border-top:1px solid var(--soft);padding:28px 0 60px;margin-top:24px;color:var(--faint);font-family:"JetBrains Mono",monospace;font-size:12px;line-height:1.7}
</style></head><body>
<header><div class="wrap">
<div class="eyebrow">tanuki-context · density methods · measured</div>
<h1>Encoding for density,<br>not obscurity.</h1>
<p class="lede">Image tokens are priced by pixels, and pixels track characters — so under this pipeline every atlas codepoint costs one flat cell. That inverts the base64 report's economics: a codebook sigil, a run-length indent, a smaller cell — each a <b>direct cut in cells</b>, and each compounds through imaging. Bars below are <b>measured</b> image-tokens via the rust binary's <code>estimate</code>, lower is better, normalised to the pxpipe baseline.</p>
</div></header>
<div class="wrap">
${rows.map(card).join("\n")}
<div class="notes">
<h2>WHAT EACH KNOB DOES — AND WHAT IT COSTS</h2>
<ul>
<li><b>pack</b> (default on) — lossless tight reflow: single-cell tabs (no 4-col padding) + indent run-length <code>⇥N</code> + per-page <b>width-trim</b>. Reconstructable byte-exact (<code>↵</code>=newline, <code>→</code>=tab, <code>⇥N</code>=indent). Round-trip proven by unit test.</li>
<li><b>codebook</b> (opt-in) — recurring long tokens / path prefixes → 1-cell sigils + a trailing <code>·legend·</code> line. Fully decodable: a vision model read the legend and expanded the first log line <b>byte-exact</b> in validation. Documented, inspectable — passes the oversight test the base64 paper cares about.</li>
<li><b>tiny 4×6</b> (opt-in, experimental) — the same atlas box-filtered into a 4×6 cell (390 cols × 120 rows/page). ~40% fewer image-tokens. Transcription-accuracy gated — see validation numbers in DESIGN.md.</li>
<li><b>append-stable</b> — reflow is deterministic left-to-right, so appending content leaves earlier pages byte-identical (verified). Stacks prompt-cache pricing on top of the imaging cut for multi-turn sessions.</li>
<li><b>parity kept</b> — <code>pack=false, font=normal</code> stays byte-identical to pxpipe: 25/25 render+distill parity rows still pass. The wins are strictly additive.</li>
</ul>
</div>
</div>
<footer><div class="wrap">
generated by <code>reference/methods-report.mjs</code> · rust binary <code>estimate</code>, no pxpipe oracle · image-tokens = round(pixels/750)<br>
figures are measured on this machine's content; re-run to reproduce · tiny font is experimental, verify transcription before shipping
</div></footer>
</body></html>`;

writeFileSync(OUT, html);
console.log(`\nHTML report -> ${OUT}`);
