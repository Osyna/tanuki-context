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
//   TASK_MODELS=a,b TASK_FONTS=default,tiny ...          # per-model density cliff
//
// Reproducible by construction: corpus, root-cause token and answers.json all
// come from a seeded LCG, so every rerun writes byte-identical fixtures.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskCorpus } from "./lib/corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const OUT = path.join(HERE, "task");
const MODEL = process.env.TASK_MODEL || "claude-haiku-4-5"; // one named public model, both arms
const SEEDS = (process.env.TASK_SEEDS || "11,23,37").split(",").map((s) => Number(s.trim()));
// Density cliff sweep: the image arm is rendered and scored once per font.
// `tiny` is a 4x6 cell against the default 5x8, i.e. 1.67x denser, so a reader
// that survives it costs ~40% fewer image tokens for the same content - which
// is the whole reason to care which readers survive it. Measured n=8 already:
// sonnet-4-5 and haiku-4-5 score 100% as text and 0% as images at the DEFAULT
// font, so they are expected to floor at every font, tiny included.
// "default" means "pass no --font flag"; anything else is passed through.
const FONTS = (process.env.TASK_FONTS || "default").split(",").map((s) => s.trim()).filter(Boolean);
const BASE_FONT = FONTS[0];

const QUESTION =
  "This service log has exactly one FATAL panic line - the root cause. Reply with ONLY " +
  "the component name in its `component=` field (the word after `component=`, drop any #id).";

// ---- generate fixtures + render both arms (one render, two representations) --
mkdirSync(OUT, { recursive: true });
const cases = [];
const answers = {};
for (const seed of SEEDS) {
  const { text, token } = taskCorpus(seed);
  const logFile = path.join(OUT, `seed-${seed}.log`);
  writeFileSync(logFile, text);
  // mirror needle-report's render call; verbatim.txt sidecar = the TEXT arm,
  // page*.png = the IMAGE arm. One render per font: the pages differ, the
  // sidecar does not, so the text arm is taken from the baseline font's dir.
  const pages = {};
  let textArm = text;
  for (const font of FONTS) {
    const dir = path.join(OUT, `seed-${seed}-${font}`);
    mkdirSync(dir, { recursive: true });
    const fontFlag = font === "default" ? [] : ["--font", font];
    execFileSync(CMD[0], [...CMD.slice(1), "render", logFile, "0", dir, ...fontFlag], { cwd: ROOT });
    pages[font] = readdirSync(dir).filter((p) => p.endsWith(".png")).sort().map((p) => path.join(dir, p));
    const sidecarPath = path.join(dir, "verbatim.txt");
    if (font === BASE_FONT && existsSync(sidecarPath)) textArm = readFileSync(sidecarPath, "utf8");
    console.log(`seed ${seed} font ${font}: ${pages[font].length} page(s) -> ${dir}`);
  }
  answers[seed] = { question: QUESTION, expected: token };
  cases.push({ seed, token, textArm, pages });
  console.log(`seed ${seed}: root cause = ${token}`);
}
writeFileSync(path.join(OUT, "answers.json"), JSON.stringify(answers, null, 2));

// ---- CRITICAL GUARD: no key -> print plan + fixtures, exit 0, no model call --
if (!process.env.ANTHROPIC_API_KEY) {
  console.log(
    `\ntask-report: ${cases.length} seed(s) x ${1 + FONTS.length} arm(s) (text | image at ${FONTS.join(", ")}) on ${MODEL}`,
  );
  console.log(`corpus:   ${OUT}/seed-<seed>.log  (+ seed-<seed>-<font>/ with verbatim.txt + page*.png)`);
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
const askImage = (c, model, font) =>
  ask(
    [
      ...c.pages[font].map((p) => ({
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
  // `errors` is transport, not comprehension. Scoring a 401 as a wrong answer
  // is how a dead API key renders as "every model is a weak reader" - which is
  // exactly the table that gets wired into the router. Keep them apart.
  const text = { n: 0, correct: 0, exact: 0, errors: 0 };
  const image = Object.fromEntries(FONTS.map((f) => [f, { n: 0, correct: 0, exact: 0, errors: 0 }]));
  const score = (bucket, answer, c, label) => {
    const correct = answer.includes(c.token);
    bucket.n++;
    bucket.correct += correct ? 1 : 0;
    bucket.exact += answer === c.token ? 1 : 0;
    console.log(
      `  seed ${c.seed} ${label}: ${correct ? "PASS" : "FAIL"}${answer === c.token ? " (exact)" : ""} <- ${answer.slice(0, 60)}`,
    );
  };
  console.log(`\n== ${model} ==`);
  for (const c of cases) {
    const arms = [["text", text, () => askText(c, model)]];
    for (const font of FONTS) arms.push([`image/${font}`, image[font], () => askImage(c, model, font)]);
    for (const [label, bucket, askFn] of arms) {
      let answer = "";
      try {
        answer = await askFn();
      } catch (e) {
        bucket.errors++;
        console.error(`  seed ${c.seed} ${label}: ERROR ${e.message}`);
        continue; // not a measurement - never scored
      }
      score(bucket, answer, c, label);
    }
  }
  profile.push({ model, text, image });
}

const pct = (a) => (a.n ? Math.round((100 * a.correct) / a.n) : 0);
console.log(`\n| model | n | text | image (${BASE_FONT}) | image exact | reader |`);
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
for (const p of profile) {
  // "capable" is the band's own premise: the page kept the task as solvable as
  // the text did. Anything materially below its own text arm is not. Judged at
  // the baseline font; the cliff table below shows what denser fonts cost.
  const base = p.image[BASE_FONT];
  const gap = pct(p.text) - pct(base);
  const verdict =
    base.n === 0
      ? `unrun (${base.errors} error(s))`
      : pct(base) >= 80 && gap <= 20
        ? "capable"
        : pct(base) === 0
          ? "cannot read pages"
          : "degraded";
  const cell = (b) => (b.n === 0 ? "unrun" : `${pct(b)}%`);
  console.log(`| ${p.model} | ${p.text.n} | ${cell(p.text)} | ${cell(base)} | ${base.exact} | ${verdict} |`);
}

// Density cliff: image-arm accuracy per font, one row per model. Reading left
// to right is reading the model off the cliff - the column where it stops
// tracking its own text arm is the densest font you may render for it.
console.log(`\n| model | text | ${FONTS.map((f) => `image ${f}`).join(" | ")} |`);
console.log(`| --- | ---: |${FONTS.map(() => " ---: |").join("")}`);
for (const p of profile) {
  const errs = FONTS.reduce((a, f) => a + p.image[f].errors, 0) + p.text.errors;
  const cells = FONTS.map((f) => (p.image[f].n === 0 ? "unrun" : `${pct(p.image[f])}%`)).join(" | ");
  console.log(`| ${p.model} | ${p.text.n === 0 ? "unrun" : `${pct(p.text)}%`} | ${cells} |${errs ? ` <- ${errs} error(s)` : ""}`);
}
console.log(
  "\nThe number that matters is image accuracy vs text accuracy on the SAME model: if image ~ text, the page render kept the task solvable. A model whose image arm collapses while its text arm holds is not the 'capable reader' the fidelity band assumes - keep its context as text or raise the font.",
);

// A run that could not reach the API is not a measurement of anything. Saying
// so loudly matters more here than elsewhere: this table decides which models
// the router refuses to send pages to, so a dead key must never be able to
// read out as "every model is a weak reader".
const errors = profile.reduce((a, p) => a + p.text.errors + FONTS.reduce((b, f) => b + p.image[f].errors, 0), 0);
if (errors > 0) {
  console.error(
    `\nNOT A MEASUREMENT: ${errors} call(s) failed in transport. Percentages above cover only calls that returned; ` +
      "cells with no successful call read 'unrun'. Fix the key/quota and rerun before believing any verdict.",
  );
  process.exit(1);
}
