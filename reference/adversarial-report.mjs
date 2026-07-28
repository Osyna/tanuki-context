#!/usr/bin/env bun
// Adversarial sidecar coverage — the check that cannot be a tautology.
//
// Every other coverage measure compares the scanner against a list of risky
// shapes that someone wrote down. If both lists came from the same head, a
// high score only proves they agree. This does the opposite: it synthesises
// identifiers in shapes the engine was never designed around, drops them into
// real log lines, and asks whether the engine ships them as text anyway.
//
// A rule-per-format scanner scores near zero on novel shapes. A scanner that
// reasons about recoverability generalises. That gap is the whole point.
//
//   bun reference/adversarial-report.mjs
//   bun reference/adversarial-report.mjs --json --n 200
//
// Deterministic: seeded LCG, fixed host log. No API key, no network.

import { readFileSync } from "node:fs";
import { scanNeedles } from "../src/needles.ts";

let seed = 1337;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const L = "abcdefghijklmnopqrstuvwxyz";
const U = L.toUpperCase();
const D = "0123456789";
const gen = (alphabet, n) => {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
};
const some = (a) => a[Math.floor(rnd() * a.length)];

// Shapes deliberately outside the named-format list: no uuid, no semver, no
// `sha256:`, no ipv4. If the engine only knows formats, these all escape.
const SHAPES = {
  "lowercase random": () => gen(L, 10 + Math.floor(rnd() * 8)),
  "UPPERCASE random": () => gen(U, 10 + Math.floor(rnd() * 8)),
  "MixedCase random": () => gen(L + U, 12 + Math.floor(rnd() * 8)),
  "alnum random": () => gen(L + U + D, 10 + Math.floor(rnd() * 10)),
  "digits+lower": () => gen(L + D, 10 + Math.floor(rnd() * 8)),
  "base64 with padding": () => `${gen(L + U + D + "+/", 20)}==`,
  "pod-style name": () => `${some(["api", "web", "worker"])}-${some(["prod", "canary"])}-${gen(L + D, 9)}-${gen(L, 5)}`,
  "order id prefixed": () => `ORD-${gen(D, 4)}-${gen(U + D, 8)}`,
  "underscore segments": () => `${gen(L, 4)}_${gen(D, 6)}_${gen(L + D, 7)}`,
  "dotted segments": () => `${gen(L, 5)}.${gen(L + D, 9)}.${gen(D, 4)}`,
  "slash path id": () => `${gen(L, 4)}/${gen(L + D, 12)}`,
  "colon quad": () => `${gen(D, 4)}:${gen(L + D, 4)}:${gen(L + D, 6)}`,
  "ulid-ish 26": () => gen("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26),
  "nanoid-ish": () => gen(`${L}${U}${D}_-`, 21),
  "k8s uid suffix": () => `${some(["ingress", "sidecar"])}-${gen(L + D, 10)}`,
  "hyphen chunks": () => `${gen(L + D, 5)}-${gen(L + D, 5)}-${gen(L + D, 5)}`,
};

const args = process.argv.slice(2);
const json = args.includes("--json");
const nIdx = args.indexOf("--n");
const N = nIdx >= 0 ? Number(args[nIdx + 1]) : 60;
const minIdx = args.indexOf("--min");
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : null;

// Real log lines as the host, so the scan runs against realistic surroundings.
// Positional = host file; skip the values that belong to --n / --min.
const flagValues = new Set([nIdx, minIdx].filter((i) => i >= 0).map((i) => args[i + 1]));
const hostFile = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
let host;
try {
  host = readFileSync(hostFile ?? "reference/needles/normal.log", "utf8").split("\n").slice(0, 120);
} catch {
  host = Array.from({ length: 120 }, (_, i) => `2026-07-27T09:${String(i % 60).padStart(2, "0")}:00Z relay INFO poll ok conn=${i}`);
}
if (host.length < 10) host = host.concat(Array.from({ length: 40 }, (_, i) => `worker INFO heartbeat seq ${i}`));

const rows = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  let caught = 0;
  const missed = [];
  for (let t = 0; t < N; t++) {
    const id = make();
    const lines = host.slice();
    const at = Math.floor(rnd() * lines.length);
    lines[at] = `${lines[at]} ref=${id} done`;
    // byte-exact recoverability is the contract: the id must be READABLE from
    // the sidecar text, whether shipped bare or inside its enclosing token.
    if (scanNeedles(lines.join("\n")).text.includes(id)) caught++;
    else if (missed.length < 1) missed.push(id);
  }
  rows.push({ shape, caught: `${caught}/${N}`, pct: Math.round((100 * caught) / N), missed: missed[0]?.slice(0, 28) ?? "" });
}
const mean = rows.reduce((a, r) => a + r.pct, 0) / rows.length;
const worst = rows.slice().sort((a, b) => a.pct - b.pct).slice(0, 3);
if (json) {
  console.log(JSON.stringify({ n: N, shapes: rows.length, meanPct: +mean.toFixed(1), rows }, null, 2));
} else {
  console.table(rows);
  console.log(`${rows.length} novel shapes x ${N} draws | mean catch rate ${mean.toFixed(1)}%`);
  console.log(`weakest: ${worst.map((w) => `${w.shape} ${w.pct}%`).join(", ")}`);
}
if (MIN !== null) {
  if (mean < MIN) {
    console.error(`FAIL: mean catch rate ${mean.toFixed(1)}% is below the required ${MIN}%`);
    process.exit(1);
  }
  console.log(`OK: mean catch rate ${mean.toFixed(1)}% >= ${MIN}%`);
}
