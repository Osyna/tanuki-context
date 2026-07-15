#!/usr/bin/env node
// Compare RAW TEXT vs the two-stage pipeline at every level:
//   text -> level transform (compress.mjs) -> pxpipe images
// Every level uses pxpipe; level 0 is raw->pxpipe. Emits a self-contained HTML report.
//   node compare.mjs [sampleFile] [outFile]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressText, LEVELS } from "./compress.mjs";
import { distillLog } from "./distill.mjs";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PXPIPE_ROOT || path.join(process.env.HOME, "Projects", "pxpipe");
const OUT = process.argv[3] || path.join(HERE, "compression-comparison.html");
const { renderTextToImages } = await import(path.join(ROOT, "dist", "core", "index.js"));

// Real BPE count (GPT o200k) — independent cross-check for the chars/4 baseline.
let bpe = null;
try { const t = await import("gpt-tokenizer"); bpe = (s) => t.encode(s).length; } catch { /* optional */ }

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const cat = (rels) => rels.map(read).join("\n\n");
// Production neutralizes the ↵ sentinel before rendering; without it reflow() bails.
const neutralize = (s) => s.replace(/\u21b5/g, "\u23ce");
const claudeTok = (s) => Math.round(s.length / 4);

const SAMPLES = process.argv[2]
  ? [{ name: path.basename(process.argv[2]), text: readFileSync(process.argv[2], "utf8") }]
  : [
      { name: "source code · 5 real .ts files",
        text: cat(["src/core/png.ts", "src/core/applicability.ts", "src/core/measurement.ts", "src/stats.ts", "src/sessions.ts"]) },
      { name: "prose docs · 7 real .md files",
        text: cat(["docs/NOT-OCR.md", "docs/HISTORY_CACHE_MODEL.md", "docs/ADAPTIVE_CPT_PLAN.md", "docs/TRANSFORM_INFO.md", "docs/LEGIBILITY-AUDIT-2026-07-01.md", "docs/MODEL_RENDER_PROFILES.md", "FINDINGS.md"]) },
    ];

const FIDELITY = {
  none: "raw text through pxpipe — source byte-exact reconstructable",
  whitespace: "trailing spaces + blank runs removed, then imaged; still byte-safe",
  prose: "prose filler cut, then imaged; code / IDs / paths / hashes verbatim",
  dense: "articles & intensifiers dropped, then imaged; code / IDs verbatim",
  caveman: "telegraphic prose (gist only), then imaged; code / IDs verbatim",
};

async function measure(text) {
  const baseTok = claudeTok(text);
  const rows = [{ label: "raw text (no pxpipe)", loss: "none", stage1Chars: text.length, stage1Pct: 0,
    pages: null, tok: baseTok, gtok: bpe ? bpe(text) : null, savedPct: 0, protectedLines: null,
    fidelity: "what you'd pay sending the text as text — the baseline", kind: "baseline" }];
  for (const { n, name, loss } of LEVELS) {
    const { compressed, protectedLines } = compressText(text, n);
    const { pages } = await renderTextToImages(neutralize(compressed), { reflow: true });
    const tok = Math.round(pages.reduce((a, p) => a + (p.width || 0) * (p.height || 0), 0) / 750);
    rows.push({ label: `L${n} ${name} → pxpipe`, loss, stage1Chars: compressed.length,
      stage1Pct: Math.round((1 - compressed.length / text.length) * 100),
      pages: pages.length, tok, gtok: null,
      savedPct: Math.round((1 - tok / baseTok) * 100), protectedLines,
      fidelity: FIDELITY[name], kind: n === 0 ? "l0" : "level" });
  }
  return { baseTok, chars: text.length, rows };
}

const sections = [];
for (const s of SAMPLES) sections.push({ ...s, ...(await measure(s.text)) });

// --- stage-0 section: noisy service log (distill -> level -> pxpipe) ---
async function pipeTok(text) {
  const { pages } = await renderTextToImages(neutralize(text), { reflow: true });
  return { pages: pages.length, tok: Math.round(pages.reduce((a, p) => a + (p.width || 0) * (p.height || 0), 0) / 750) };
}
function logSample() {
  try { // real machine log first — full user journal, noisy enough to be representative
    const t = execSync("journalctl --user -n 3000 --no-pager -o short-iso 2>/dev/null", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (t.length > 30000) return { name: "service log · journalctl --user, last 3000 lines (real)", text: t };
  } catch { /* fall through */ }
  const L = [];
  for (let i = 0; i < 300; i++) {
    const ts = `2026-07-15T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.123Z`;
    L.push(`${ts} INFO  heartbeat ok latency=${3 + (i % 7)}ms conn=a1b2c3d${i}e`);
    if (i % 3 === 0) L.push(`${ts} INFO  poll queue depth=${i % 11} worker=w-${i % 4}`);
  }
  L.push("2026-07-15T10:05:01.999Z ERROR connection refused to db-primary:5432 after 3 retries");
  L.push("    at Pool.connect (/srv/app/node_modules/pg/lib/pool.js:214:11)");
  for (let i = 0; i < 100; i++) L.push(`2026-07-15T10:06:${String(i % 60).padStart(2, "0")}.000Z INFO  retry backoff sleeping 500ms`);
  return { name: "service log · synthetic (journalctl unavailable)", text: L.join("\n") };
}
{
  const { name, text } = logSample();
  const baseTok = claudeTok(text);
  const d = distillLog(text);
  const dl4 = compressText(d.distilled, 4);
  const rows = [
    { label: "raw text (no pxpipe)", loss: "none", stage1Chars: text.length, stage1Pct: 0, pages: null, tok: baseTok,
      gtok: bpe ? bpe(text) : null, savedPct: 0, protectedLines: null, fidelity: "the noisy log, sent as text — the baseline", kind: "baseline" },
    { label: "L0 none → pxpipe", loss: "none", stage1Chars: text.length, stage1Pct: 0, ...(await pipeTok(text)),
      gtok: null, savedPct: 0, protectedLines: null, fidelity: "raw log imaged — byte-exact but the noise is still paid for", kind: "l0" },
    { label: "distill → pxpipe", loss: "selective", stage1Chars: d.distilled.length,
      stage1Pct: Math.round((1 - d.distilled.length / text.length) * 100), ...(await pipeTok(d.distilled)),
      gtok: null, savedPct: 0, protectedLines: d.stats.importantKept,
      fidelity: `noise runs collapsed ×N (${d.stats.collapsedRuns} runs); error/warn lines verbatim`, kind: "level" },
    { label: "distill → L4 → pxpipe", loss: "selective+heavy", stage1Chars: dl4.compressed.length,
      stage1Pct: Math.round((1 - dl4.compressed.length / text.length) * 100), ...(await pipeTok(dl4.compressed)),
      gtok: null, savedPct: 0, protectedLines: d.stats.importantKept,
      fidelity: "distilled, then telegraphic prose; log/code lines protected", kind: "level" },
  ];
  for (const r of rows) if (r.kind !== "baseline") r.savedPct = Math.round((1 - r.tok / baseTok) * 100);
  sections.push({ name, chars: text.length, baseTok, rows });
}

// --- console ---
for (const s of sections) {
  console.log(`\n${s.name}  ${s.chars} chars  raw-text baseline ${s.baseTok} tok`);
  for (const r of s.rows)
    console.log(`  ${r.label.padEnd(24)} ${String(r.tok).padStart(7)} tok  saved ${String(r.savedPct).padStart(3)}%  (stage1 -${String(r.stage1Pct).padStart(2)}% chars${r.pages ? `, ${r.pages}pg` : ""})`);
}

// --- HTML ---
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const hue = (p) => `hsl(${Math.round(Math.max(0, Math.min(100, p)) * 1.2)} 70% 45%)`;
const bar = (r, base) => {
  const w = Math.max(1, Math.round((r.tok / base) * 100));
  const col = r.kind === "baseline" ? "#5a6070" : hue(r.savedPct);
  return `<div class="track"><div class="fill" style="width:${w}%;background:${col}"></div><span class="blab">${r.tok.toLocaleString()} tok${r.kind === "baseline" ? "" : ` · −${r.savedPct}%`}</span></div>`;
};
const trow = (r) => `<tr class="${r.kind}">
  <td class="lv">${esc(r.label)}</td>
  <td><span class="loss l-${esc(r.loss.split(" ")[0])}">${esc(r.loss)}</span></td>
  <td class="num">${r.stage1Chars.toLocaleString()}${r.stage1Pct ? ` <span class="d">−${r.stage1Pct}%</span>` : ""}</td>
  <td class="num">${r.pages == null ? "—" : r.pages}</td>
  <td class="num">${r.tok.toLocaleString()}</td>
  <td class="num strong" style="color:${r.kind === "baseline" ? "#9aa0b4" : hue(r.savedPct)}">${r.kind === "baseline" ? "—" : r.savedPct + "%"}</td>
  <td class="fid">${esc(r.fidelity)}${r.protectedLines ? ` <span class="prot">${r.protectedLines} lines verbatim</span>` : ""}</td>
</tr>`;
const section = (s) => `<div class="card">
  <h2>${esc(s.name)}</h2>
  <p class="meta">${s.chars.toLocaleString()} chars · raw-text baseline <b>${s.baseTok.toLocaleString()}</b> tok${s.rows[0].gtok ? ` (${s.rows[0].gtok.toLocaleString()} real GPT-BPE)` : ""}</p>
  <div class="chart">${s.rows.map((r) => `<div class="clab">${esc(r.label)}<small>${esc(r.loss)}</small></div>${bar(r, s.baseTok)}`).join("")}</div>
  <table><thead><tr><th>Pipeline</th><th>Stage-1 loss</th><th>Chars after stage 1</th><th>Pages</th><th>Tokens</th><th>Saved vs raw</th><th>Fidelity</th></tr></thead>
  <tbody>${s.rows.map(trow).join("")}</tbody></table>
</div>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pxpipe pipeline comparison</title><style>
:root{--bg:#0e1016;--card:#171a23;--line:#262a37;--tx:#e7e9f0;--mut:#9aa0b4;--faint:#606779}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
.wrap{max-width:1120px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 8px;font-size:14px}
.pipe{color:var(--mut);font-size:13px;margin:0 0 22px}.pipe b{color:#c9cdff}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:22px}
h2{font-size:15px;margin:0 0 2px}.meta{color:var(--mut);margin:0 0 18px;font-size:13px}
.chart{display:grid;grid-template-columns:190px 1fr;gap:9px 14px;align-items:center;margin-bottom:20px}
.clab{font-variant-numeric:tabular-nums;font-size:13px}.clab small{color:var(--faint);display:block;font-size:11px}
.track{position:relative;background:#0000002e;border-radius:7px;height:30px;overflow:hidden}
.fill{height:100%;border-radius:7px}.blab{position:absolute;left:10px;top:0;line-height:30px;font-size:12px;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 2px #000a}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.lv{font-weight:600}td.strong{font-weight:700}
tr.baseline{background:#ffffff08}td.fid{color:var(--mut);font-size:12px}.d{color:#7fdca0;font-size:11px}
.loss{font-size:11px;padding:2px 8px;border-radius:20px;background:#2a2f3d;color:var(--mut);white-space:nowrap}
.l-none{background:#1f3a2a;color:#7fdca0}.l-lossless{background:#1f3a2a;color:#7fdca0}.l-light{background:#3a381f;color:#dcd07f}.l-medium{background:#3a2f1f;color:#dcae7f}.l-heavy{background:#3a1f1f;color:#dc8f8f}
.prot{color:#7fdca0;font-size:11px}
.note{color:var(--faint);font-size:12.5px;line-height:1.65}.note b{color:var(--mut)}
code{background:#0000003d;padding:1px 6px;border-radius:5px;color:#c9cdff}
</style></head><body><div class="wrap">
<h1>pxpipe — pipeline comparison: no compression vs levels 0–4</h1>
<p class="sub">generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</p>
<p class="pipe">pipeline: <b>text → distill (logs: dedupe ×N, keep errors, query filter) → level transform (whitespace / prose / dense / caveman) → pxpipe → PNG pages</b> · every level uses pxpipe; L0 is raw→pxpipe · image tokens are pixel-priced, so every earlier cut compounds</p>
${sections.map(section).join("")}
<div class="card"><h2>Reading this</h2><p class="note">
<b>Baseline</b> is the raw text sent as text — what you'd pay with no pxpipe at all.<br>
<b>L0 raw → pxpipe</b> is pure imaging: the whole cut comes from pixel pricing, and the source stays byte-exact reconstructable.<br>
<b>L1–L4</b> shrink the text first (stage 1), then image it: fewer chars → fewer rendered rows → fewer pixels → fewer tokens, so the two stages <b>multiply</b>. From L2 up, lines that look like code or carry a hash / path / URL / long id are never reworded (the "verbatim" count) — loss applies to prose only.<br>
<b>Content decides stage-1's bite:</b> on code nearly every line is protected, so L1–L4 ≈ L0 (that's correctness, not weakness). On prose, higher levels buy real extra tokens on top of imaging — at the cost of verbatim fidelity (L4 is gist-only).<br>
<b>distill (stage 0, for logs/output)</b> is selection, not compression: runs of near-identical lines (timestamps/ids/numbers masked) collapse to one line + "[×N similar]", error/warn/fail lines are always kept verbatim, and an optional query returns only the relevant slice. On noisy logs it beats every text level because the noise never reaches the renderer.<br>
Page granularity makes small stage-1 cuts sometimes free (same page count) and sometimes worth a whole page.<br>
Claude tokens ≈ chars/4 for text and pixels/750 for images${bpe ? "; the baseline also shows a real GPT-BPE count as a cross-check" : ""}.</p></div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`\nHTML report -> ${OUT}`);
