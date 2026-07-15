#!/usr/bin/env node
// Pipeline report for BIG log files: distill -> level -> pxpipe, with capped
// rendering (render a 2MB slice, extrapolate linearly — pixel pricing is linear
// in content; extrapolated rows are marked †). Prints aggregates only; the raw
// log never leaves this process. Emits a self-contained HTML report.
//   node biglog-report.mjs <logfile> [out.html]
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distillLog } from "./distill.mjs";
import { compressText } from "./compress.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2];
if (!FILE) { console.error("usage: node biglog-report.mjs <logfile> [out.html]"); process.exit(1); }
const OUT = process.argv[3] || path.join(path.dirname(FILE), path.basename(FILE).replace(/\.[^.]+$/, "") + "-report.html");
const PXPIPE = process.env.PXPIPE_ROOT || path.join(process.env.HOME, "Projects", "pxpipe");
const { renderTextToImages } = await import(path.join(PXPIPE, "dist", "core", "index.js"));

const neutralize = (s) => s.replace(/\u21b5/g, "\u23ce");
const CAP = 2 * 1024 * 1024;

async function imgTok(text) {
  if (!text.length) return { tok: 0, pages: 0, extrapolated: false };
  const slice = text.length > CAP ? text.slice(0, CAP) : text;
  const { pages } = await renderTextToImages(neutralize(slice), { reflow: true });
  const px = pages.reduce((a, p) => a + (p.width || 0) * (p.height || 0), 0);
  let tok = Math.round(px / 750), pg = pages.length;
  if (text.length > CAP) { const f = text.length / slice.length; tok = Math.round(tok * f); pg = Math.ceil(pg * f); }
  return { tok, pages: pg, extrapolated: text.length > CAP };
}

const t0 = Date.now();
const text = readFileSync(FILE, "utf8");
const baseTok = Math.round(text.length / 4);

const d = distillLog(text);
const tDistill = Date.now() - t0;
const l4 = compressText(d.distilled, 4);

const rows = [
  { label: "raw text (no pxpipe)", loss: "none", chars: text.length, ...{ tok: baseTok, pages: null, extrapolated: false },
    savedPct: 0, fidelity: "the full log sent as text — the baseline", kind: "baseline" },
  { label: "L0 none → pxpipe", loss: "none", chars: text.length, ...(await imgTok(text)),
    fidelity: "raw log imaged — byte-exact, but you still pay for every repeated line", kind: "l0" },
  { label: "distill → pxpipe", loss: "selective", chars: d.distilled.length, ...(await imgTok(d.distilled)),
    fidelity: `noise dropped, not compressed: ${d.stats.suppressedLines.toLocaleString()} exact + ${d.stats.templateSuppressed.toLocaleString()} same-template repeats suppressed with exact counts; ${d.stats.importantKept.toLocaleString()} error/warn lines verbatim`, kind: "level" },
  { label: "distill → L4 → pxpipe", loss: "selective+heavy", chars: l4.compressed.length, ...(await imgTok(l4.compressed)),
    fidelity: "distilled, then telegraphic prose; log/code lines protected", kind: "level" },
];
for (const r of rows) if (r.kind !== "baseline") r.savedPct = Math.round((1 - r.tok / baseTok) * 100);

// console: aggregates only — never the log content
console.log(`${path.basename(FILE)}: ${(text.length / 1048576).toFixed(1)} MB, ${d.stats.origLines.toLocaleString()} lines, baseline ${baseTok.toLocaleString()} tok`);
console.log(`distill: -${d.stats.savedPct}% chars in ${(tDistill / 1000).toFixed(1)}s (runs=${d.stats.collapsedRuns}, exact=${d.stats.suppressedLines}, template=${d.stats.templateSuppressed}, important=${d.stats.importantKept})`);
for (const r of rows) console.log(`  ${r.label.padEnd(24)} ${String(r.tok.toLocaleString()).padStart(12)} tok  saved ${String(r.savedPct).padStart(3)}%${r.extrapolated ? " †" : ""}`);

// --- HTML ---
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const hue = (p) => `hsl(${Math.round(Math.max(0, Math.min(100, p)) * 1.2)} 70% 45%)`;
const fmt = (n) => n.toLocaleString("en-US");
const bar = (r) => {
  const w = Math.max(0.5, (r.tok / baseTok) * 100);
  const col = r.kind === "baseline" ? "#5a6070" : hue(r.savedPct);
  return `<div class="track"><div class="fill" style="width:${w}%;background:${col}"></div><span class="blab">${fmt(r.tok)} tok${r.kind === "baseline" ? "" : ` · −${r.savedPct}%`}${r.extrapolated ? " †" : ""}</span></div>`;
};
const trow = (r) => `<tr class="${r.kind}"><td class="lv">${esc(r.label)}</td>
  <td><span class="loss">${esc(r.loss)}</span></td>
  <td class="num">${fmt(r.chars)}</td><td class="num">${r.pages == null ? "—" : fmt(r.pages) + (r.extrapolated ? "†" : "")}</td>
  <td class="num">${fmt(r.tok)}${r.extrapolated ? "†" : ""}</td>
  <td class="num strong" style="color:${r.kind === "baseline" ? "#9aa0b4" : hue(r.savedPct)}">${r.kind === "baseline" ? "—" : r.savedPct + "%"}</td>
  <td class="fid">${esc(r.fidelity)}</td></tr>`;
const repRow = (e) => `<tr><td class="num strong">×${fmt(e.count)}</td><td>${e.kind === "template" ? '<span class="loss">template</span>' : '<span class="loss l-exact">exact</span>'}</td><td class="mono">${esc(e.exemplar)}</td></tr>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(path.basename(FILE))} — pxpipe pipeline report</title><style>
:root{--bg:#0e1016;--card:#171a23;--line:#262a37;--tx:#e7e9f0;--mut:#9aa0b4;--faint:#606779}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
.wrap{max-width:1120px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 22px;font-size:14px}
.chips{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 22px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:130px}
.chip b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.chip span{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:22px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:0 0 16px}
.chart{display:grid;grid-template-columns:190px 1fr;gap:9px 14px;align-items:center;margin-bottom:6px}
.clab{font-size:13px}.clab small{color:var(--faint);display:block;font-size:11px}
.track{position:relative;background:#0000002e;border-radius:7px;height:30px;overflow:hidden}
.fill{height:100%;border-radius:7px;min-width:2px}.blab{position:absolute;left:10px;top:0;line-height:30px;font-size:12px;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 2px #000a}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.lv{font-weight:600;white-space:nowrap}td.strong{font-weight:700}
tr.baseline{background:#ffffff08}td.fid{color:var(--mut);font-size:12px}
.loss{font-size:11px;padding:2px 8px;border-radius:20px;background:#2a2f3d;color:var(--mut);white-space:nowrap}.l-exact{background:#1f3a2a;color:#7fdca0}
.mono{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--mut);word-break:break-all}
.note{color:var(--faint);font-size:12.5px;line-height:1.65}.note b{color:var(--mut)}
</style></head><body><div class="wrap">
<h1>${esc(path.basename(FILE))} — pipeline report</h1>
<p class="sub">${esc(FILE)} · ${(text.length / 1048576).toFixed(1)} MB · ${fmt(d.stats.origLines)} lines · pipeline <b>distill → level → pxpipe</b> · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</p>
<div class="chips">
  <div class="chip"><b>${fmt(baseTok)}</b><span>baseline tokens (raw text)</span></div>
  <div class="chip"><b>${fmt(rows[2].tok)}</b><span>tokens after distill → pxpipe</span></div>
  <div class="chip"><b>−${rows[2].savedPct}%</b><span>total cut</span></div>
  <div class="chip"><b>−${d.stats.savedPct}%</b><span>chars cut by distill alone</span></div>
  <div class="chip"><b>${fmt(d.stats.suppressedLines + d.stats.templateSuppressed)}</b><span>repeated lines suppressed</span></div>
  <div class="chip"><b>${fmt(d.stats.importantKept)}</b><span>error/warn lines kept verbatim</span></div>
</div>
<div class="card"><h2>Tokens (shorter = cheaper)</h2><div class="chart">
${rows.map((r) => `<div class="clab">${esc(r.label)}<small>${esc(r.loss)}</small></div>${bar(r)}`).join("")}
</div></div>
<div class="card"><h2>Detail</h2>
<table><thead><tr><th>Pipeline</th><th>Loss</th><th>Chars</th><th>Pages</th><th>Tokens</th><th>Saved</th><th>Fidelity</th></tr></thead>
<tbody>${rows.map(trow).join("")}</tbody></table>
<p class="note">† rendered from a ${CAP / 1048576} MB slice and extrapolated linearly (pixel pricing is linear in content).</p></div>
<div class="card"><h2>What the noise was — top repeated lines (exact counts)</h2>
<table><thead><tr><th>Count</th><th>Match</th><th>Exemplar (first occurrence, truncated)</th></tr></thead>
<tbody>${d.stats.topRepeats.map(repRow).join("")}</tbody></table>
<p class="note"><b>exact</b> = same line after masking timestamps/ids/numbers · <b>template</b> = same event shape with a varying path/name (non-alpha tokens unified). The distilled text keeps the first occurrences of each plus this table — so the log stays <b>usable</b>: every distinct event type is visible with its true frequency, errors/warnings stay byte-exact, and only redundancy is dropped. The full log remains on disk for exact lookups.</p></div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`\nHTML report -> ${OUT}`);
