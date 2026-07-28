#!/usr/bin/env node
// Task-quality report: the claim customers actually buy. Read-back fidelity
// (needle-report.mjs) asks "can the model still SEE the bytes on a page?".
// This asks the harder question: can the model still DO THE JOB when the
// context is IMAGE pages instead of TEXT? Same model, same seeded corpus,
// two arms:
//
//   ARM A (text)  — the corpus is handed to the model as text.
//   ARM B (image) — the corpus is handed to the model as tanuki PNG pages.
//
// We inject exactly one root-cause line (a distinctive failure token buried
// in plausible log noise), ask both arms to name the root cause, and score
// substring/exact. Measures: task success on text pages vs image pages, same
// model, same corpus. A cheap wrong answer is a FAILURE, not a save.
//
//   node reference/task-report.mjs                       # no key: plan + fixtures, exit 0
//   ANTHROPIC_API_KEY=... node reference/task-report.mjs # run both arms, score
//   TASK_MODEL=claude-haiku-4-5 TASK_SEEDS=11,23,37 ...  # override model / seeds
//
// Reproducible by construction: corpus, root-cause token and answers.json all
// come from a seeded LCG, so every rerun writes byte-identical fixtures.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const OUT = path.join(HERE, "task");
const MODEL = process.env.TASK_MODEL || "claude-haiku-4-5"; // one named public model, both arms
const SEEDS = (process.env.TASK_SEEDS || "11,23,37").split(",").map((s) => Number(s.trim()));

// ---- seeded corpus (same LCG discipline as needle/paired reports) ----------
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");

/** ~120 lines of plausible noise with exactly ONE root-cause line injected.
 *  The failure carries a distinctive, seed-unique token so scoring a model's
 *  answer is unambiguous: substring match on that token or bust. */
function corpus(seed) {
  const r = lcg(seed);
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const comps = ["frame-allocator", "wal-compactor", "shard-router", "quota-reaper", "vclock-merger", "bloom-indexer", "lease-broker", "chunk-scrubber"];
  const reasons = ["disk write failed errno=ENOSPC", "deadlock acquiring lease table", "checksum mismatch on replay", "heap arena corruption detected", "fd table exhausted"];
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const ts = `2026-07-27T09:${String(10 + ((i / 6) | 0)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = units[(r() * units.length) | 0];
    if (r() < 0.06) {
      lines.push(`${ts} ${u} WARN retry status=502 backoff=${1 + ((r() * 8) | 0)}s conn=${(r() * 9) | 0}`);
    } else {
      lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
    }
  }
  // the one root cause: a seed-varying READABLE component name (this tests
  // comprehension, not needle transcription - the random hex id stays on the
  // line for realism, but the scored answer is the legible component word).
  const comp = comps[(r() * comps.length) | 0];
  const reason = reasons[(r() * reasons.length) | 0];
  const token = comp;
  const at = 8 + ((r() * 100) | 0);
  const line = 100 + ((r() * 900) | 0);
  lines.splice(
    at,
    0,
    `2026-07-27T09:30:00Z relay FATAL panic: ${reason} component=${comp}#${hex(r, 6)} at lib/relay/${comp}.rs:${line}`,
  );
  return { text: lines.join("\n") + "\n", token };
}

const QUESTION =
  "This service log has exactly one FATAL panic line - the root cause. Reply with ONLY " +
  "the component name in its `component=` field (the word after `component=`, drop any #id).";

// ---- generate fixtures + render both arms (one render, two representations) --
mkdirSync(OUT, { recursive: true });
const cases = [];
const answers = {};
for (const seed of SEEDS) {
  const { text, token } = corpus(seed);
  const logFile = path.join(OUT, `seed-${seed}.log`);
  writeFileSync(logFile, text);
  const dir = path.join(OUT, `seed-${seed}`);
  mkdirSync(dir, { recursive: true });
  // mirror needle-report's render call; verbatim.txt sidecar = the TEXT arm,
  // page*.png = the IMAGE arm.
  execFileSync(CMD[0], [...CMD.slice(1), "render", logFile, "0", dir], { cwd: ROOT });
  const pages = readdirSync(dir).filter((p) => p.endsWith(".png")).sort();
  const sidecarPath = path.join(dir, "verbatim.txt");
  const textArm = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : text;
  answers[seed] = { question: QUESTION, expected: token };
  cases.push({ seed, token, textArm, pages: pages.map((p) => path.join(dir, p)) });
  console.log(`seed ${seed}: ${pages.length} page(s) -> ${dir} · root cause = ${token}`);
}
writeFileSync(path.join(OUT, "answers.json"), JSON.stringify(answers, null, 2));

// ---- CRITICAL GUARD: no key -> print plan + fixtures, exit 0, no model call --
if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`\ntask-report: ${cases.length} seed(s) x 2 arms (text | image) on ${MODEL}`);
  console.log(`corpus:   ${OUT}/seed-<seed>.log  (+ verbatim.txt + page*.png per seed)`);
  console.log(`answers:  ${path.join(OUT, "answers.json")}`);
  console.log(`question: ${QUESTION}`);
  for (const c of cases) console.log(`  seed ${c.seed} expected: ${c.token}`);
  console.log("no key: unrun. Set ANTHROPIC_API_KEY and rerun to score both arms.");
  process.exit(0);
}

// ---- model path (fully behind the key check) --------------------------------
const API = "https://api.anthropic.com/v1/messages";
const HEADERS = {
  "content-type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
};

async function ask(content, model) {
  const res = await fetch(API, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const blocks = data.content || [];
  const txt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return txt || blocks.map((b) => b.thinking || "").join("").trim(); // thinking fallback if truncated
}

const askText = (c, model) => ask([{ type: "text", text: `${c.textArm}\n\n${QUESTION}` }], model);
const askImage = (c, model) =>
  ask(
    [
      ...c.pages.map((p) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: readFileSync(p).toString("base64") },
      })),
      { type: "text", text: QUESTION },
    ],
    model,
  );

// substring is the pass bar; exact is reported alongside as the stricter signal.
// TASK_MODELS profiles several readers in one run: the fidelity band in
// `estimate` is calibrated to a CAPABLE reader, and which models qualify is a
// measured question, not an assumption (EVALS §3).
const MODELS = (process.env.TASK_MODELS || MODEL).split(",").map((s) => s.trim()).filter(Boolean);
const profile = [];
for (const model of MODELS) {
  const stats = { text: { n: 0, correct: 0, exact: 0 }, image: { n: 0, correct: 0, exact: 0 } };
  console.log(`\n== ${model} ==`);
  for (const c of cases) {
    for (const [arm, askFn] of [["text", askText], ["image", askImage]]) {
      let answer = "";
      try {
        answer = await askFn(c, model);
      } catch (e) {
        console.error(`  seed ${c.seed} ${arm}: ERROR ${e.message}`);
      }
      const correct = answer.includes(c.token);
      const exact = answer === c.token;
      stats[arm].n++;
      stats[arm].correct += correct ? 1 : 0;
      stats[arm].exact += exact ? 1 : 0;
      console.log(`  seed ${c.seed} ${arm}: ${correct ? "PASS" : "FAIL"}${exact ? " (exact)" : ""} <- ${answer.slice(0, 60)}`);
    }
  }
  profile.push({ model, ...stats });
}

const pct = (a) => (a.n ? Math.round((100 * a.correct) / a.n) : 0);
console.log("\n| model | n | text | image | image exact | reader |");
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
for (const p of profile) {
  // "capable" is the band's own premise: the page kept the task as solvable as
  // the text did. Anything materially below its own text arm is not.
  const gap = pct(p.text) - pct(p.image);
  const verdict = p.image.n === 0 ? "n/a" : pct(p.image) >= 80 && gap <= 20 ? "capable" : pct(p.image) === 0 ? "cannot read pages" : "degraded";
  console.log(`| ${p.model} | ${p.text.n} | ${pct(p.text)}% | ${pct(p.image)}% | ${p.image.exact} | ${verdict} |`);
}
console.log(
  "\nThe number that matters is image accuracy vs text accuracy on the SAME model: if image ~ text, the page render kept the task solvable. A model whose image arm collapses while its text arm holds is not the 'capable reader' the fidelity band assumes - keep its context as text or raise the font.",
);
