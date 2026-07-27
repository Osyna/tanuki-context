#!/usr/bin/env node
// Tier report: the lossy-tier sell, measured. Levels 2-4, `--font tiny`,
// `--distill`, `--codebook` are NOT byte-lossless - they trade fidelity for
// tokens. This asks: does cranking them keep the TASK solvable while cutting
// tokens? Same seeded root-cause task as task-report.mjs, rendered at each
// tier; we record image-tokens (the saving, deterministic) and task success
// (the cost, per model). The pitch: reach for the lossy tiers when the model
// must UNDERSTAND the context, not transcribe it byte-exact.
//
//   node reference/tier-report.mjs                                  # no key: token-saving table (deterministic)
//   ANTHROPIC_API_KEY=... TIER_MODEL=claude-opus-5 node reference/tier-report.mjs   # + task success per tier
//   TIER_SEEDS=11,23,37 ...                                         # override seeds
//
// Reproducible by construction: corpus + answers from a seeded LCG.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const OUT = path.join(HERE, "tier");
const MODEL = process.env.TIER_MODEL || "claude-opus-4-8";
const SEEDS = (process.env.TIER_SEEDS || "11,23").split(",").map((s) => Number(s.trim()));
const key = process.env.ANTHROPIC_API_KEY;

// ---- seeded corpus: identical shape to task-report.mjs (one FATAL line) ----
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");
function corpus(seed) {
  const r = lcg(seed);
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const comps = ["frame-allocator", "wal-compactor", "shard-router", "quota-reaper", "vclock-merger", "bloom-indexer", "lease-broker", "chunk-scrubber"];
  const reasons = ["disk write failed errno=ENOSPC", "deadlock acquiring lease table", "checksum mismatch on replay", "heap arena corruption detected", "fd table exhausted"];
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const ts = `2026-07-27T09:${String(10 + ((i / 6) | 0)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = units[(r() * units.length) | 0];
    if (r() < 0.06) lines.push(`${ts} ${u} WARN retry status=502 backoff=${1 + ((r() * 8) | 0)}s conn=${(r() * 9) | 0}`);
    else lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
  }
  const comp = comps[(r() * comps.length) | 0];
  const reason = reasons[(r() * reasons.length) | 0];
  const at = 8 + ((r() * 100) | 0);
  const line = 100 + ((r() * 900) | 0);
  lines.splice(at, 0, `2026-07-27T09:30:00Z relay FATAL panic: ${reason} component=${comp}#${hex(r, 6)} at lib/relay/${comp}.rs:${line}`);
  return { text: lines.join("\n") + "\n", token: comp };
}
const QUESTION =
  "This service log has exactly one FATAL panic line - the root cause. Reply with ONLY " +
  "the component name in its `component=` field (the word after `component=`, drop any #id).";

// lossless (L0) -> aggressive lossy. distill keeps error/FATAL lines verbatim,
// so it should stay solvable; L4 caveman telegraphs prose and is the boundary.
const CONFIGS = [
  { name: "L0 normal (near-lossless)", flags: ["0"] },
  { name: "L0 tiny", flags: ["0", "--font", "tiny"] },
  { name: "distill", flags: ["0", "--distill"] },
  { name: "distill tiny", flags: ["0", "--distill", "--font", "tiny"] },
  { name: "distill+codebook tiny", flags: ["0", "--distill", "--codebook", "--font", "tiny"] },
  { name: "L4 caveman", flags: ["4"] },
  { name: "L4 caveman tiny", flags: ["4", "--font", "tiny"] },
];

async function ask(pages) {
  const content = pages.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(p).toString("base64") } }));
  content.push({ type: "text", text: QUESTION });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (j.error) return { text: "", note: j.error.type };
  const blocks = j.content ?? [];
  const txt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { text: txt || blocks.map((b) => b.thinking ?? "").join(""), note: j.stop_reason };
}

mkdirSync(OUT, { recursive: true });
const cases = SEEDS.map((seed) => { const { text, token } = corpus(seed); const f = path.join(OUT, `seed-${seed}.log`); writeFileSync(f, text); return { seed, token, f }; });

const rows = [];
for (const cfg of CONFIGS) {
  let imgTok = 0, rawTok = 0, pages = 0, correct = 0, asked = 0;
  for (const c of cases) {
    const dir = path.join(OUT, `${c.seed}-${cfg.name.replace(/\W+/g, "_")}`);
    mkdirSync(dir, { recursive: true });
    const out = JSON.parse(execFileSync(CMD[0], [...CMD.slice(1), "render", c.f, cfg.flags[0], dir, ...cfg.flags.slice(1)], { encoding: "utf8", cwd: ROOT }));
    imgTok += out.imageTokens; rawTok += out.rawTextTokens; pages += out.pages;
    if (key) {
      const pngs = readdirSync(dir).filter((p) => p.endsWith(".png")).sort().map((p) => path.join(dir, p));
      let ans = { text: "" };
      try { ans = await ask(pngs); } catch (e) { console.error(`  ${cfg.name} seed ${c.seed}: ${e.message}`); }
      asked++;
      if (ans.text.includes(c.token)) correct++;
      console.error(`  ${cfg.name} seed ${c.seed}: ${ans.text.includes(c.token) ? "PASS" : "FAIL"} (${out.imageTokens} img-tok, ${out.pages}p) <- ${ans.text.slice(0, 60).replace(/\n/g, " ")}`);
    }
  }
  rows.push({ name: cfg.name, imgTok, rawTok, pages, correct, asked });
}

console.log(`\n# lossy-tier sweep on ${MODEL} (seeds ${SEEDS.join(",")}) - same root-cause task per tier`);
console.log("\n| tier | image-tokens | vs raw text | pages | task solved |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  const cut = r.rawTok ? Math.round((100 * (r.rawTok - r.imgTok)) / r.rawTok) : 0;
  const task = key ? `${r.correct}/${r.asked}` : "-";
  console.log(`| ${r.name} | ${r.imgTok} | -${cut}% | ${r.pages} | ${task} |`);
}
if (!key) console.log("\nno key: token-saving column is deterministic; set ANTHROPIC_API_KEY for the task-solved column.");
else console.log("\nRead down the table: image-tokens fall as the tier gets lossier; task stays solved while the FATAL line survives (distill keeps it verbatim), and breaks where caveman telegraphs it away. Rerun with more TIER_SEEDS.");
