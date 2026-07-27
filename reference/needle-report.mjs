#!/usr/bin/env node
// Needle report: fidelity, not cost. Hide exact strings a person actually
// greps a log for (UUIDs, versions, request ids, hash prefixes, stack
// frames, base64 tokens, ms timestamps) inside seeded log noise, render
// pages at each font density, ask a vision model for the needles back
// VERBATIM, score exact match plus a char-to-char substitution tally.
//
//   node reference/needle-report.mjs            # writes pages + prompt
//   node reference/needle-report.mjs score <transcript.json>
//
// Reproducible by construction: the corpus and needle values come from a
// seeded LCG, so every machine renders byte-identical pages. The model half
// is yours to run: show each PNG to the model you care about with the
// prompt in prompt.txt, save its answers as JSON, then `score` it:
//
//   { "normal": ["<string it read>", ...], "tiny": [...] }
//
// Pass/fail is exact-match: a plausible wrong character is a miss, that
// silent failure is the whole point. On the misses we also tally char-to-
// char substitutions and split glyph-shape confusions (a bigger font helps)
// from value-drift (the model settled on a plausible value; a font won't).
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const OUT = path.join(HERE, "needles");

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");

/** 14 needles per density, 7 kinds x 2. Values differ per density so a
 *  reader cannot carry answers from one page to the next. base64 (mixed
 *  case, +/) and ms timestamps are the confusable-rich kinds that separate
 *  a too-small font from a model inventing a plausible value. */
function makeNeedles(r) {
  const uuid = () => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
  const semver = () => `${1 + ((r() * 20) | 0)}.${(r() * 30) | 0}.${(r() * 30) | 0}-rc.${1 + ((r() * 9) | 0)}`;
  const files = ["src/api/route.ts", "src/ingest/batch.ts", "lib/relay/frame.ts", "src/cache/lru.ts"];
  const frame = () => `${files[(r() * files.length) | 0]}:${100 + ((r() * 900) | 0)}:${1 + ((r() * 80) | 0)}`;
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64 = (n) => Array.from({ length: n }, () => B64[(r() * 64) | 0]).join("");
  const ms = () =>
    `${String((r() * 24) | 0).padStart(2, "0")}:${String((r() * 60) | 0).padStart(2, "0")}:` +
    `${String((r() * 60) | 0).padStart(2, "0")}.${String((r() * 1000) | 0).padStart(3, "0")}Z`;
  return [
    { kind: "uuid", value: uuid() }, { kind: "uuid", value: uuid() },
    { kind: "semver", value: semver() }, { kind: "semver", value: semver() },
    { kind: "hex12 id", value: hex(r, 12) }, { kind: "hex12 id", value: hex(r, 12) },
    { kind: "sha256:16", value: `sha256:${hex(r, 16)}` }, { kind: "sha256:16", value: `sha256:${hex(r, 16)}` },
    { kind: "frame", value: frame() }, { kind: "frame", value: frame() },
    { kind: "base64", value: b64(22) }, { kind: "base64", value: b64(22) },
    { kind: "ms", value: ms() }, { kind: "ms", value: ms() },
  ];
}

/** ~80 log lines (one page at both densities) with the needles embedded in
 *  lines shaped like the lines they would really live in. */
function corpus(r, needles) {
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const lines = [];
  for (let i = 0; i < 80; i++) {
    const ts = `2026-07-27T09:${String(10 + ((i / 4) | 0)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = units[(r() * units.length) | 0];
    lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
  }
  const carriers = [
    (n) => `ERROR request failed session=${n}`,
    (n) => `ERROR request failed session=${n}`,
    (n) => `WARN rollback: pinned to ${n} after failed canary`,
    (n) => `INFO upgraded runtime to ${n}`,
    (n) => `ERROR upstream 502 request-id=${n}`,
    (n) => `WARN retry exhausted request-id=${n}`,
    (n) => `INFO image digest ${n} verified`,
    (n) => `ERROR digest mismatch, expected ${n}`,
    (n) => `    at handler (${n})`,
    (n) => `    at flush (${n})`,
    (n) => `INFO issued session token=${n}`,
    (n) => `DEBUG auth: bearer ${n} accepted`,
    (n) => `WARN slow span start=${n} over budget`,
    (n) => `INFO checkpoint written at ${n}`,
  ];
  const r2 = lcg(101);
  needles.forEach((n, i) => {
    const at = 4 + ((r2() * 72) | 0);
    lines.splice(at, 0, `2026-07-27T09:30:00Z relay ${carriers[i](n.value)}`);
  });
  return lines.join("\n") + "\n";
}

const DENSITIES = [
  { name: "normal", seed: 11, flags: [] },
  { name: "tiny", seed: 23, flags: ["--font", "tiny"] },
];

function gen() {
  mkdirSync(OUT, { recursive: true });
  const answers = {};
  for (const d of DENSITIES) {
    const needles = makeNeedles(lcg(d.seed));
    answers[d.name] = needles;
    const f = path.join(OUT, `${d.name}.log`);
    writeFileSync(f, corpus(lcg(d.seed + 1), needles));
    const dir = path.join(OUT, d.name);
    mkdirSync(dir, { recursive: true });
    execFileSync(CMD[0], [...CMD.slice(1), "render", f, "0", dir, ...d.flags], { cwd: ROOT });
    const pages = readdirSync(dir).filter((p) => p.endsWith(".png"));
    // The fix under test: `render` ships a ·verbatim· text sidecar next to
    // the pages (default on). Coverage = seeded needles present byte-exact.
    const sidecarPath = path.join(dir, "verbatim.txt");
    const sidecar = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : "";
    const covered = needles.filter((n) => sidecar.includes(n.value)).length;
    console.log(`${d.name}: ${pages.length} page(s) -> ${dir} · sidecar covers ${covered}/${needles.length} needles as text`);
  }
  writeFileSync(path.join(OUT, "answers.json"), JSON.stringify(answers, null, 2));
  writeFileSync(path.join(OUT, "prompt.txt"),
    "This image is a rendered log. Transcribe VERBATIM every value of these kinds you can read:\n" +
    "UUIDs, semver versions (x.y.z-rc.n), 12-char hex ids, sha256:<hex> digests, file paths with :line:col, base64 tokens (mixed case, may include + or /), and HH:MM:SS.mmm timestamps.\n" +
    "Return them as a JSON array of strings, nothing else.\n");
  console.log(`prompt -> ${path.join(OUT, "prompt.txt")}`);
  console.log(`ground truth sealed in answers.json - do not open before transcribing.`);
}

function score(transcriptPath) {
  const answers = JSON.parse(readFileSync(path.join(OUT, "answers.json"), "utf8"));
  const got = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const kinds = ["uuid", "semver", "hex12 id", "sha256:16", "frame", "base64", "ms"];
  // small-font / OCR confusable classes; base64 mixes case on purpose, so
  // case-similar letters count as glyph confusions too.
  const CONFUSABLE = ["0OoQD", "1lI|i7", "2Zz", "5Ss", "6bG", "8B", "9gq", "cC", "kK", "pP", "uU", "vV", "wW", "xX"];
  const cc = new Map();
  CONFUSABLE.forEach((g, i) => { for (const c of g) if (!cc.has(c)) cc.set(c, i); });
  const conf = (a, b) => a !== b && cc.has(a) && cc.get(a) === cc.get(b);
  const lev = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  };
  const rows = [["density", ...kinds, "total"]];
  const subs = new Map(); // "e->g" -> count, across every near-miss
  const tally = { glyph: 0, drift: 0, gone: 0 };
  for (const d of DENSITIES) {
    // containment: did the model reproduce the exact needle bytes anywhere in
    // its answer? Robust to array | prose | markdown - real models don't emit
    // a clean JSON array. `cands` = loose tokens for the substitution tally.
    const hay = Array.isArray(got[d.name]) ? got[d.name].join("\n") : String(got[d.name] ?? "");
    const cands = hay.split(/[\s=,"'()\[\]{}]+/).filter(Boolean);
    const by = {};
    let hit = 0;
    for (const n of answers[d.name]) {
      const ok = hay.includes(n.value);
      by[n.kind] = (by[n.kind] ?? "") + (ok ? "O" : "X");
      hit += ok;
      if (ok) continue;
      // the model's closest attempt at this needle, if any is close enough
      let best = null;
      let bd = Infinity;
      for (const c of cands) {
        const dd = lev(n.value, c);
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (best === null || bd > Math.max(2, Math.ceil(n.value.length * 0.34))) {
        tally.gone++;
        continue;
      }
      if (best.length === n.value.length) {
        let allConf = true;
        for (let i = 0; i < best.length; i++) {
          const e = n.value[i];
          const g = best[i];
          if (e === g) continue;
          subs.set(`${e}->${g}`, (subs.get(`${e}->${g}`) ?? 0) + 1);
          if (!conf(e, g)) allConf = false;
        }
        tally[allConf ? "glyph" : "drift"]++;
      } else {
        tally.drift++; // a dropped/added char: segmentation, not a clean sub
      }
    }
    rows.push([d.name, ...kinds.map((k) => `${[...(by[k] ?? "")].filter((c) => c === "O").length}/2`), `${hit}/${answers[d.name].length}`]);
  }
  console.log(rows.map((r) => `| ${r.join(" | ")} |`).join("\n"));
  console.log("\nO = byte-exact, X = anything else (including one plausible wrong character).");
  const misses = tally.glyph + tally.drift + tally.gone;
  if (misses === 0) {
    console.log("\nno misses to diagnose.");
    return;
  }
  console.log(`\nmisses ${misses}: ${tally.glyph} glyph-shape · ${tally.drift} value-drift · ${tally.gone} no-attempt`);
  const top = [...subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) console.log("top substitutions (expected -> read): " + top.map(([k, v]) => `${k}×${v}`).join("  "));
  console.log(
    tally.glyph >= tally.drift
      ? "verdict: mostly glyph-shape — a bigger font (drop --font tiny, or a higher-res tier) should recover these."
      : "verdict: mostly value-drift — the model is inventing plausible values a bigger font won't fix; keep these as text.",
  );
}

if (process.argv[2] === "score") score(process.argv[3]);
else gen();
