#!/usr/bin/env node
// Tiers report: every compression tier tanuki knows, side by side, with a
// winner per corpus and pxpipe as the imaging baseline.
//
//   node reference/tiers-report.mjs [your-files...]
//
// Reproducible by construction: the three synthetic corpora are seeded
// (same bytes on every machine), the two repo corpora ship in this repo,
// and token math is deterministic. Run it and you get this exact table.
// Every cell is one CLI call:
//
//   npx tanuki-context estimate <file> <level> [--distill] [--table]
//                                             [--no-pack] [--codebook] [--font tiny]
//
// The "pxpipe" column is tanuki with every extension off (--no-pack, no
// codebook, normal font). That mode renders byte-identical output to pxpipe
// itself; the 161-check parity suite holds the two engines to it.
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const TMP = mkdtempSync(path.join(os.tmpdir(), "tanuki-tiers-"));

// ---- deterministic corpora --------------------------------------------------
// Seeded LCG. No Math.random, no clock, no hostname: same bytes everywhere.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pad = (n, w) => String(n).padStart(w, "0");

/** systemd-style service log: heartbeats, a few units, 3% errors. */
function serviceLog() {
  const r = lcg(7);
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const out = [];
  for (let i = 0; i < 1400; i++) {
    const u = units[Math.floor(r() * units.length)];
    const ts = `2026-07-26T${pad(Math.floor(i / 60) % 24, 2)}:${pad(i % 60, 2)}:${pad(Math.floor(r() * 60), 2)}Z`;
    const roll = r();
    if (roll < 0.03) {
      out.push(`${ts} ERROR ${u}[${1000 + (i % 40)}]: connection reset by peer (errno=${104 + (i % 3)}) retry=${i % 5}`);
    } else if (roll < 0.08) {
      out.push(`${ts} WARN ${u}[${1000 + (i % 40)}]: slow response ${Math.floor(r() * 900) + 100}ms from upstream-${i % 7}`);
    } else {
      out.push(`${ts} INFO ${u}[${1000 + (i % 40)}]: copied /srv/data/prod/batch/segment_${pad(i % 97, 5)}.parquet ok bytes=${Math.floor(r() * 9e6)}`);
    }
  }
  return out.join("\n") + "\n";
}

/** journalctl -o json shape: NDJSON rows, sparse keys, ints and floats. */
function ndjsonRows() {
  const r = lcg(11);
  const out = [];
  for (let i = 0; i < 900; i++) {
    const row = {
      ts: `2026-07-26T${pad(Math.floor(i / 60) % 24, 2)}:${pad(i % 60, 2)}:00Z`,
      level: r() < 0.05 ? "error" : "info",
      unit: `svc-${i % 6}.service`,
      pid: 1000 + (i % 53),
      msg: `copied segment_${pad(i % 89, 5)}.parquet ok rc=0`,
      bytes: Math.floor(r() * 9e6),
    };
    if (i % 7 === 0) row.extra = { retry: i % 3, ratio: [0.25, 0.5, 0.75][i % 3] };
    out.push(JSON.stringify(row));
  }
  return out.join("\n") + "\n";
}

/** npm-install-style output: deep node_modules paths, tree glyphs. */
function installLog() {
  const r = lcg(13);
  const scopes = ["@babel", "@types", "@esbuild", "@rollup", "@vitest"];
  const names = ["core", "parser", "runtime", "helpers", "plugin-transform", "resolver", "loader", "utils"];
  const out = ["npm verbose cli /usr/bin/node /usr/bin/npm"];
  for (let i = 0; i < 900; i++) {
    const scope = scopes[Math.floor(r() * scopes.length)];
    const name = names[Math.floor(r() * names.length)];
    const v = `${1 + (i % 9)}.${i % 24}.${i % 11}`;
    out.push(
      `npm http fetch GET 200 https://registry.npmjs.org/${scope}/${name}/-/${name}-${v}.tgz ${Math.floor(r() * 900) + 20}ms (cache miss)`,
      `npm verbose reify node_modules/${scope}/${name}: extracted ${name}@${v}`,
    );
  }
  out.push("added 412 packages in 21s");
  return out.join("\n") + "\n";
}

const corpora = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => ({
      name: path.basename(f),
      file: f,
      json: f.endsWith(".ndjson") || f.endsWith(".json"),
      log: true, // user files: assume log-like; rerun cells by hand if not
    }))
  : [
      { name: "service log (synthetic, seeded)", gen: serviceLog, ext: "log", log: true },
      { name: "journalctl JSON (synthetic, seeded)", gen: ndjsonRows, ext: "ndjson", json: true, log: true },
      { name: "npm install log (synthetic, seeded)", gen: installLog, ext: "log", log: true },
      { name: "TypeScript source (src/main.ts)", file: path.join(ROOT, "src", "main.ts"), log: false },
      { name: "design doc (DESIGN.md)", file: path.join(ROOT, "DESIGN.md"), log: false },
    ].map((c) => {
      if (c.gen) {
        const f = path.join(TMP, `${c.name.split(" ")[0]}.${c.ext}`);
        writeFileSync(f, c.gen());
        return { name: c.name, file: f, json: c.json ?? false, log: c.log };
      }
      return { ...c, json: false };
    });

// ---- one estimate call per cell ---------------------------------------------
function est(file, level, flags = []) {
  const out = execFileSync(CMD[0], [...CMD.slice(1), "estimate", file, String(level), ...flags], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28,
  });
  return JSON.parse(out);
}
const textTok = (e) => Math.round(e.stage1Chars / 4); // same chars/4 rule as rawTextTokens
const pct = (v, raw) => `${Math.round((1 - v / raw) * 100) * -1}%`; // negative = saved

// ---- measure ------------------------------------------------------------------
const rows = [];
for (const c of corpora) {
  const base = est(c.file, 0);
  const raw = base.rawTextTokens;
  const kb = Math.round(readFileSync(c.file, "utf8").length / 1024);

  // text tiers (never rendered; tokens = chars/4 after the stage)
  const text = {
    L1: textTok(est(c.file, 1)),
    L2: textTok(est(c.file, 2)),
    L3: textTok(est(c.file, 3)),
    L4: textTok(est(c.file, 4)),
    distill: textTok(est(c.file, 0, ["--distill"])),
    table: c.json ? textTok(est(c.file, 0, ["--table"])) : null,
  };

  // image tiers (exact page geometry)
  const rec = base.recommend;
  const image = {
    pxpipe: est(c.file, 0, ["--no-pack"]).imageTokens,
    pack: base.imageTokens,
    codebook: est(c.file, 0, ["--codebook"]).imageTokens,
    table: c.json ? est(c.file, 0, ["--table", "--codebook"]).imageTokens : null,
    best: rec.imageTokens,
    bestKnobs: ["pack", rec.codebook ? "codebook" : null, rec.table ? "table" : null].filter(Boolean).join("+"),
    distill: rec.withDistill.imageTokens,
    tiny: rec.tinyImageTokens,
  };
  rows.push({ name: c.name, file: c.file, kb, raw, text, image, log: c.log });
}

// ---- markdown ------------------------------------------------------------------
const md = [];
const line = (cells) => md.push(`| ${cells.join(" | ")} |`);
const bold = (s) => `**${s}**`;
const cell = (v, raw, isMin) => (v === null ? "n/a" : `${isMin ? bold(v.toLocaleString("en-US")) : v.toLocaleString("en-US")} (${pct(v, raw)})`);

md.push("<!-- generated by reference/tiers-report.mjs; do not edit numbers by hand -->");
md.push("");
md.push("### Table A. Text stays text: the ladder, distill, and the table codec");
md.push("");
md.push("Tokens are chars/4 after each stage. L1 and table are lossless; L2-L4 reword prose; distill drops repeats but keeps every error line.");
md.push("");
line(["corpus", "raw", "L1 whitespace", "L2 prose", "L3 dense", "L4 caveman", "distill", "table"]);
line(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]);
for (const r of rows) {
  const vals = [r.text.L1, r.text.L2, r.text.L3, r.text.L4, r.text.distill, r.text.table];
  const min = Math.min(...vals.filter((v) => v !== null));
  line([r.name, r.raw.toLocaleString("en-US"), ...vals.map((v) => cell(v, r.raw, v === min))]);
}
md.push("");
md.push("### Table B. Text becomes pixels: pxpipe baseline and every tanuki knob");
md.push("");
md.push("Image tokens, exact page geometry. The pxpipe column is the extensions-off mode that renders byte-identical to pxpipe. pack, codebook, and table are reversible; the distill route and tiny font are the opt-in trades.");
md.push("");
line(["corpus", "raw text", "pxpipe", "+pack", "+codebook", "+table+codebook", "best reversible", "distill route", "tiny font"]);
line(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]);
for (const r of rows) {
  const revVals = [r.image.pxpipe, r.image.pack, r.image.codebook, r.image.table, r.image.best];
  const minRev = Math.min(...revVals.filter((v) => v !== null));
  line([
    r.name,
    r.raw.toLocaleString("en-US"),
    cell(r.image.pxpipe, r.raw, false),
    cell(r.image.pack, r.raw, false),
    cell(r.image.codebook, r.raw, false),
    cell(r.image.table, r.raw, false),
    `${bold(r.image.best.toLocaleString("en-US"))} (${pct(r.image.best, r.raw)}) ${r.image.bestKnobs}`,
    cell(r.image.distill, r.raw, false),
    cell(r.image.tiny, r.raw, false),
  ]);
}
md.push("");
md.push("### Table C. Winners");
md.push("");
md.push("Two verdicts per corpus, because the eligible tiers differ by content. When the content must survive intact (code, docs), only lossless tiers compete: L1/table text, pxpipe, and tanuki's reversible knobs. On logs the distill route competes too. Margin is the winner vs the pxpipe baseline.");
md.push("");
line(["corpus", "lossless text", "pxpipe", "tanuki reversible", "tanuki log route", "winner", "vs pxpipe"]);
line(["---", "---:", "---:", "---:", "---:", "---", "---:"]);
for (const r of rows) {
  const losslessText = Math.min(...[r.text.L1, r.text.table].filter((v) => v !== null));
  const entries = [
    ["lossless text", losslessText],
    ["pxpipe", r.image.pxpipe],
    [`tanuki ${r.image.bestKnobs}`, r.image.best],
  ];
  if (r.log) entries.push(["tanuki distill route", r.image.distill]);
  const [wName, wVal] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  line([
    r.name,
    losslessText.toLocaleString("en-US"),
    r.image.pxpipe.toLocaleString("en-US"),
    `${r.image.best.toLocaleString("en-US")} ${r.image.bestKnobs}`,
    r.log ? r.image.distill.toLocaleString("en-US") : "not eligible",
    bold(wName),
    `${Math.round((1 - wVal / r.image.pxpipe) * 100) * -1}%`,
  ]);
}
md.push("");
md.push(`Corpora: ${rows.map((r) => `${r.name} (${r.kb} KB)`).join("; ")}.`);
md.push(`Synthetic files were written to ${TMP} so you can rerun any single cell by hand.`);
md.push("");

const report = md.join("\n");
const outFile = path.join(HERE, "tiers-report.md");
writeFileSync(outFile, report);
console.log(report);
console.log(`markdown -> ${outFile}`);
