#!/usr/bin/env bun
// Sidecar coverage on real logs — the honest answer to "20/20 only proves the
// two lists agree."
//
// The needle harness seeds the same kinds the scanner knows, so it measures
// agreement, not coverage. This measures coverage: take real logs, find tokens
// where a single-character misread is SILENT and UNRECOVERABLE, run the REAL
// engine (`scanNeedles`, blocked into pages like production), and count how
// many of those tokens actually come back as text.
//
// The risk criterion below names unrecoverable shapes. It cannot prove the
// engine generalises — a criterion and an engine written by the same hand will
// agree with each other. That job belongs to `adversarial-report.mjs`, which
// synthesises shapes the engine never saw. Run both.
//
// (A shape-free Shannon-entropy criterion was tried here and removed: entropy
// over a token's own characters measures diversity, not unpredictability, and
// flags `ocean-sound-theme` and `DESIGN.md` as unrecoverable. Bigram surprisal
// against the corpus fails too — MACs score LOW because `NN:NN` pairs are
// everywhere. No shape-free oracle survived contact; the adversarial harness
// is the honest substitute.)
//
// Deterministic, no API key, runs on gigabytes.
//
//   bun reference/coverage-report.mjs /var/log/*.log
//   bun reference/coverage-report.mjs --json corpus/*.log
//
// The criterion excludes formats recoverable from context, so the reported gap
// is a floor, not an inflation.

import { readFileSync } from "node:fs";
import { scanNeedles } from "../src/needles.ts";

const BLOCK = 120; // lines per rendered page, matches a realistic render

// Recoverable from context, sequence, or language => NOT at risk.
const RECOVERABLE = [
  /^\d+(?:\.\d+)?(?:ns|us|ms|s|m|h|d|B|[KMGT]i?B|%)$/i,
  /^(?:\d+h)?(?:\d+m)?\d+(?:\.\d+)?s$/,
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+\-]*)?$/,
  /^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?$/,
  /^[vV]?\d+(?:[._]\d+)+$/,
  /^\d{1,8}$/,
  /^[A-Za-z_]+$/,
];

const FAMILIES = [
  [/^[0-9a-fA-F]{6,}$/, "hex run >=6 (git short sha, request id)"],
  [/^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, "MAC address"],
  [/^(?:[0-9a-fA-F]{4}:)+[0-9a-fA-F]{4}(?:\.[0-9A-Fa-f]+)?$/, "PCI/USB id"],
  [/^[A-Za-z0-9+/]{16,}={0,2}$/, "base64 blob"],
  [/^\d{9,}$/, "long numeric id"],
  [/^[0-9a-fA-F]{4,}(?:[:-][0-9a-fA-F]{4,})+$/, "hex-group id"],
];

/// Whitespace token -> the part that carries the risk (`key=value` -> value).
function value(tok) {
  let v = tok;
  const eq = v.lastIndexOf("=");
  if (eq > 0) v = v.slice(eq + 1);
  return v.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9=+/]+$/g, "");
}

/// null = recoverable. Otherwise the family that makes it unrecoverable.
function atRiskFamily(v) {
  if (v.length < 6) return null;
  for (const r of RECOVERABLE) if (r.test(v)) return null;
  for (const [r, name] of FAMILIES) if (r.test(v)) return name;
  if (v.length >= 10 && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) {
    let flips = 0;
    for (let i = 1; i < v.length; i++) {
      if (/[0-9]/.test(v[i]) !== /[0-9]/.test(v[i - 1])) flips++;
    }
    if (flips >= 3) return "mixed alnum id (pod/build/container)";
  }
  return null;
}

export function coverage(text) {
  const lines = text.split("\n");
  const shipped = new Set();
  let dense = 0;
  let blocks = 0;
  for (let i = 0; i < lines.length; i += BLOCK) {
    const s = scanNeedles(lines.slice(i, i + BLOCK).join("\n"));
    blocks++;
    if (s.dense) dense++;
    for (const n of s.needles) shipped.add(n.value);
  }
  const joined = [...shipped].join("\n"); // byte-exact readability, bare or in-token
  const freq = new Map();
  for (const raw of text.split(/\s+/)) {
    if (raw.length >= 6) freq.set(raw, (freq.get(raw) ?? 0) + 1);
  }
  const miss = new Map();
  let atRisk = 0;
  let covered = 0;
  let riskChars = 0;
  let missChars = 0;
  for (const [raw, count] of freq) {
    if (count > 2) continue; // repeated => self-correcting, not at risk
    const v = value(raw);
    const fam = atRiskFamily(v);
    if (fam === null) continue;
    atRisk++;
    riskChars += v.length;
    if (shipped.has(v) || joined.includes(v)) covered++;
    else {
      missChars += v.length;
      miss.set(fam, (miss.get(fam) ?? 0) + 1);
    }
  }
  return { chars: text.length, dense, blocks, atRisk, covered, riskChars, missChars, miss };
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const minIdx = args.indexOf("--min");
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : null;
const files = args.filter((a) => !a.startsWith("--") && a !== args[minIdx + 1]);
if (files.length === 0) {
  console.error("usage: bun reference/coverage-report.mjs [--json] [--min PCT] <log>...");
  process.exit(2);
}

const rows = [];
const missAll = new Map();
const T = { chars: 0, dense: 0, blocks: 0, atRisk: 0, covered: 0, missChars: 0 };
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const r = coverage(text);
  rows.push({
    log: f.replace(/^.*\//, ""),
    MB: +(r.chars / 1e6).toFixed(2),
    atRisk: r.atRisk,
    carried: r.covered,
    "covered%": +((100 * r.covered) / Math.max(1, r.atRisk)).toFixed(1),
    "dense pages": `${r.dense}/${r.blocks}`,
  });
  for (const [k, v] of r.miss) missAll.set(k, (missAll.get(k) ?? 0) + v);
  T.chars += r.chars;
  T.dense += r.dense;
  T.blocks += r.blocks;
  T.atRisk += r.atRisk;
  T.covered += r.covered;
  T.missChars += r.missChars;
}
const oneIn = T.missChars > 0 ? Math.round(T.chars / T.missChars) : Infinity;
const out = {
  corpusMB: +(T.chars / 1e6).toFixed(2),
  atRisk: T.atRisk,
  carried: T.covered,
  coveredPct: +((100 * T.covered) / Math.max(1, T.atRisk)).toFixed(1),
  densePages: `${T.dense}/${T.blocks}`,
  unprotectedCharsPerMillion: +((1e6 * T.missChars) / Math.max(1, T.chars)).toFixed(1),
  oneInNChars: oneIn,
  missedFamilies: Object.fromEntries([...missAll].sort((a, b) => b[1] - a[1])),
};
if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.table(rows);
  console.log(`corpus ${out.corpusMB} MB, pages of ${BLOCK} lines`);
  console.log(`  at-risk identifiers carried as text: ${out.carried}/${out.atRisk} (${out.coveredPct}%)`);
  console.log(`  needle-dense pages (flagged, keep as text): ${out.densePages}`);
  console.log(`  unprotected at-risk chars: ${out.unprotectedCharsPerMillion}/million  =>  1 in ${oneIn.toLocaleString()}`);
  if (missAll.size > 0) {
    console.log("\nstill missed (what to add next):");
    for (const [k, v] of Object.entries(out.missedFamilies)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
}
if (MIN !== null) {
  if (out.coveredPct < MIN) {
    console.error(`FAIL: coverage ${out.coveredPct}% is below the required ${MIN}%`);
    process.exit(1);
  }
  console.log(`OK: coverage ${out.coveredPct}% >= ${MIN}%`);
}
