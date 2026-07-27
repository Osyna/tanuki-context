#!/usr/bin/env node
// Needle report: fidelity, not cost. Hide exact strings a person actually
// greps a log for (UUIDs, versions, request ids, hash prefixes, stack
// frames) inside seeded log noise, render pages at each font density, ask a
// vision model for the needles back VERBATIM, score exact match.
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
// Scoring is exact-match only. A plausible wrong character is a miss - that
// silent failure mode is the whole point of the test.
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

/** 10 needles per density, 5 kinds x 2. Values differ per density so a
 *  reader cannot carry answers from one page to the next. */
function makeNeedles(r) {
  const uuid = () => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
  const semver = () => `${1 + ((r() * 20) | 0)}.${(r() * 30) | 0}.${(r() * 30) | 0}-rc.${1 + ((r() * 9) | 0)}`;
  const files = ["src/api/route.ts", "src/ingest/batch.ts", "lib/relay/frame.ts", "src/cache/lru.ts"];
  const frame = () => `${files[(r() * files.length) | 0]}:${100 + ((r() * 900) | 0)}:${1 + ((r() * 80) | 0)}`;
  return [
    { kind: "uuid", value: uuid() }, { kind: "uuid", value: uuid() },
    { kind: "semver", value: semver() }, { kind: "semver", value: semver() },
    { kind: "hex12 id", value: hex(r, 12) }, { kind: "hex12 id", value: hex(r, 12) },
    { kind: "sha256:16", value: `sha256:${hex(r, 16)}` }, { kind: "sha256:16", value: `sha256:${hex(r, 16)}` },
    { kind: "frame", value: frame() }, { kind: "frame", value: frame() },
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
    console.log(`${d.name}: ${pages.length} page(s) -> ${dir}`);
  }
  writeFileSync(path.join(OUT, "answers.json"), JSON.stringify(answers, null, 2));
  writeFileSync(path.join(OUT, "prompt.txt"),
    "This image is a rendered log. Transcribe VERBATIM every value of these kinds you can read:\n" +
    "UUIDs, semver versions (x.y.z-rc.n), 12-char hex ids, sha256:<hex> digests, file paths with :line:col.\n" +
    "Return them as a JSON array of strings, nothing else.\n");
  console.log(`prompt -> ${path.join(OUT, "prompt.txt")}`);
  console.log(`ground truth sealed in answers.json - do not open before transcribing.`);
}

function score(transcriptPath) {
  const answers = JSON.parse(readFileSync(path.join(OUT, "answers.json"), "utf8"));
  const got = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const kinds = ["uuid", "semver", "hex12 id", "sha256:16", "frame"];
  const rows = [["density", ...kinds, "total"]];
  for (const d of DENSITIES) {
    const set = new Set(got[d.name] ?? []);
    const by = {};
    let hit = 0;
    for (const n of answers[d.name]) {
      const ok = set.has(n.value);
      by[n.kind] = (by[n.kind] ?? "") + (ok ? "O" : "X");
      hit += ok;
    }
    rows.push([d.name, ...kinds.map((k) => `${[...by[k]].filter((c) => c === "O").length}/2`), `${hit}/10`]);
  }
  console.log(rows.map((r) => `| ${r.join(" | ")} |`).join("\n"));
  console.log("\nO = byte-exact, X = anything else (including one plausible wrong character).");
}

if (process.argv[2] === "score") score(process.argv[3]);
else gen();
