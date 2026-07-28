#!/usr/bin/env node
// Sidecar coverage on real logs — the honest answer to "20/20 only proves the
// two lists agree."
//
// The needle harness seeds the same kinds the scanner's allowlist already
// knows, so it measures agreement, not coverage. This measures coverage: take
// real logs, find the tokens where a single-character misread is SILENT and
// UNRECOVERABLE, and count how many the allowlist actually carries as text.
//
// Deterministic, no API key, runs on gigabytes.
//
//   node reference/coverage-report.mjs /var/log/*.log
//   node reference/coverage-report.mjs --json corpus/*.log
//
// The risk criterion is defined INDEPENDENTLY of the scanner's patterns (that
// is the point). It is deliberately conservative — formats recoverable from
// context are excluded, so the reported gap is a floor, not an inflation.

import { readFileSync } from "node:fs";

// Mirrors src/needles.ts PATTERNS. Keep in sync (parity test covers the pair).
const PATTERNS = [
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  /\b(?:sha1|sha256|sha384|sha512|md5|blake2b|blake2s|blake3):[0-9a-fA-F]{8,128}/g,
  /\b0x[0-9a-fA-F]{8,64}\b/g,
  /[A-Za-z0-9_./-]*[/.][A-Za-z0-9_.-]*:\d+:\d+/g,
  /\b[0-9a-fA-F]{12,64}\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
  /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g,
];

// Recoverable from context, sequence, or language => NOT at risk.
const RECOVERABLE = [
  /^\d+(?:\.\d+)?(?:ns|us|ms|s|m|h|d|B|[KMGT]i?B|%)$/i, // measurements
  /^(?:\d+h)?(?:\d+m)?\d+(?:\.\d+)?s$/, // durations 1h30m0s
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+\-]*)?$/, // ISO date/time
  /^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?$/, // clock
  /^[vV]?\d+(?:[._]\d+)+$/, // versions
  /^\d{1,8}$/, // small ints
  /^[A-Za-z_]+$/, // words
];

// Unrecoverable identifier families: one flipped char is silent and final.
const RISKY = [
  [/^[0-9a-fA-F]{6,}$/, "hex run >=6 (git short sha, request id)"],
  [/^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, "MAC address"],
  [/^(?:[0-9a-fA-F]{4}:)+[0-9a-fA-F]{4}(?:\.[0-9A-Fa-f]+)?$/, "PCI/USB id"],
  [/^[A-Za-z0-9+/]{16,}={0,2}$/, "base64 blob"],
  [/^\d{9,}$/, "long numeric id"],
  [/^[0-9a-fA-F]{4,}(?:[:-][0-9a-fA-F]{4,})+$/, "hex-group id"],
];

/// null = recoverable/not at risk. Otherwise the value + its family.
export function classify(tok) {
  let v = tok;
  const eq = v.lastIndexOf("=");
  if (eq > 0) v = v.slice(eq + 1); // key=value -> the value is the risky half
  v = v.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9=+/]+$/g, "");
  if (v.length < 6) return null;
  for (const r of RECOVERABLE) if (r.test(v)) return null;
  for (const [r, name] of RISKY) if (r.test(v)) return { v, name };
  // Generic structural rule (no named format): interleaved alnum — pod names,
  // build ids, container ids. This is the rule that generalizes past the list.
  if (v.length >= 10 && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) {
    let flips = 0;
    for (let i = 1; i < v.length; i++) {
      if (/[0-9]/.test(v[i]) !== /[0-9]/.test(v[i - 1])) flips++;
    }
    if (flips >= 3) return { v, name: "mixed alnum id (pod/build/container)" };
  }
  return null;
}

/// Chars of `v` claimed by the allowlist (union of matched spans).
function coveredChars(v) {
  const spans = [];
  for (const p of PATTERNS) {
    p.lastIndex = 0;
    for (const m of v.matchAll(p)) spans.push([m.index, m.index + m[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = -1;
  for (const [a, b] of spans) {
    const s = Math.max(a, end);
    if (b > s) {
      covered += b - s;
      end = b;
    }
  }
  return covered;
}

export function coverage(text) {
  const freq = new Map();
  for (const raw of text.split(/\s+/)) {
    if (raw.length >= 6) freq.set(raw, (freq.get(raw) ?? 0) + 1);
  }
  const fam = new Map();
  let atRisk = 0, full = 0, partial = 0, missed = 0, riskChars = 0, missChars = 0;
  for (const [raw, count] of freq) {
    if (count > 2) continue; // repeated => self-correcting, not at risk
    const c = classify(raw);
    if (!c) continue;
    atRisk++;
    riskChars += c.v.length;
    const cov = coveredChars(c.v);
    if (cov === c.v.length) full++;
    else if (cov > 0) {
      partial++;
      missChars += c.v.length - cov;
    } else {
      missed++;
      missChars += c.v.length;
      fam.set(c.name, (fam.get(c.name) ?? 0) + 1);
    }
  }
  return { chars: text.length, atRisk, full, partial, missed, riskChars, missChars, fam };
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: coverage-report.mjs [--json] <log>...");
  process.exit(2);
}

const rows = [];
const famAll = new Map();
let T = { chars: 0, atRisk: 0, full: 0, partial: 0, missed: 0, riskChars: 0, missChars: 0 };
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
    full: r.full,
    partial: r.partial,
    missed: r.missed,
    "covered%": +(100 * r.full / Math.max(1, r.atRisk)).toFixed(1),
  });
  for (const [k, v] of r.fam) famAll.set(k, (famAll.get(k) ?? 0) + v);
  for (const k of Object.keys(T)) T[k] += r[k];
}
const pct = (n, d) => +(100 * n / Math.max(1, d)).toFixed(1);
const oneIn = T.missChars > 0 ? Math.round(T.chars / T.missChars) : Infinity;
const out = {
  corpusMB: +(T.chars / 1e6).toFixed(2),
  atRisk: T.atRisk,
  fullyCovered: T.full,
  coveredPct: pct(T.full, T.atRisk),
  partial: T.partial,
  missed: T.missed,
  missedPct: pct(T.missed, T.atRisk),
  unprotectedCharsPerMillion: +(1e6 * T.missChars / Math.max(1, T.chars)).toFixed(0),
  oneInNChars: oneIn,
  families: Object.fromEntries([...famAll].sort((a, b) => b[1] - a[1])),
};
if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.table(rows);
  console.log(`corpus ${out.corpusMB} MB | at-risk identifiers ${out.atRisk}`);
  console.log(`  fully carried as text : ${out.fullyCovered} (${out.coveredPct}%)`);
  console.log(`  partially carried     : ${out.partial}`);
  console.log(`  riding as pixels      : ${out.missed} (${out.missedPct}%)`);
  console.log(`  unprotected at-risk chars: ${out.unprotectedCharsPerMillion}/million  =>  1 in ${oneIn.toLocaleString()}`);
  console.log("\nmissed families (what to add next):");
  for (const [k, v] of Object.entries(out.families)) console.log(`  ${String(v).padStart(6)}  ${k}`);
}
