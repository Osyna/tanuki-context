// Is `textTokens(chars) = chars / 4` true for the content tanuki actually
// routes? That one line in src/serde.ts is the denominator of every decision
// the router makes - the imaging gate (`cost > rawTok * ratio`), the minimum
// saving, the fidelity band's ratio, and the whole saved-token ledger.
//
// The error, if any, is ONE-SIDED and therefore not self-cancelling: image
// tokens come from pixel geometry (w*h/750, exact), text tokens from chars/4.
// Understate the text side and every text-vs-image comparison tilts toward
// text: tanuki declines wins it should take, and under-reports the wins it
// does take.
//
// Offline evidence says it is wrong for logs. Counting maximal character-class
// runs (a rough proxy for BPE boundaries, calibrated on prose where it
// overcounts ~34%) puts real logs near 2.3-2.9 chars/token against the assumed
// 4.0 - i.e. chars/4 understates by 1.4-1.7x. But a proxy is not a tokenizer,
// and this project does not ship a constant fitted to an approximation. This
// harness gets the real number.
//
// It uses /v1/messages/count_tokens, which is NOT billed - only rate-limited.
// So this is a zero-cost measurement; it needs a working key, not budget.
//
//   node reference/tokenizer-report.mjs                 # no key: plan, exit 0
//   ANTHROPIC_API_KEY=... node reference/tokenizer-report.mjs /var/log/*.log
//
// env: TOK_MODEL (default claude-sonnet-4-5)

import fs from "node:fs";
import path from "node:path";

const MODEL = process.env.TOK_MODEL || "claude-sonnet-4-5";
const ASSUMED = 4.0; // src/serde.ts textTokens()

// Same character-class proxy used to find the bias offline, kept here so the
// fitted alternative can be compared against the constant on identical input.
const classRuns = (s) => (s.match(/[a-z]+|[A-Z][a-z]*|[0-9]+|[^\sA-Za-z0-9]|\s+/g) ?? []).length;

// A representative spread when no corpus is given. Real logs are the point,
// but these make the harness runnable anywhere and show the shape of the error
// across content types rather than one number for everything.
const SAMPLES = [
  ["prose", Array.from({ length: 40 }, () => "The router compares estimated token counts before it decides anything, so an estimate that is wrong quietly makes the decision wrong too.").join(" ")],
  ["service-log", Array.from({ length: 400 }, (_, i) => `2026-07-27T08:${String(i % 60).padStart(2, "0")}:0${i % 10}Z worker-${i % 5} INFO poll ok req=7f3a${((i * 2654435761) >>> 0).toString(16).slice(0, 8)} conn=${i % 40}/64 latency=${i % 900}ms`).join("\n")],
  ["json", JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, host: `node-${i % 12}.eu-west-1`, status: i % 7 === 0 ? "degraded" : "ok", latencyMs: i % 900, hash: ((i * 2654435761) >>> 0).toString(16) })), null, 2)],
  ["stack-trace", Array.from({ length: 120 }, (_, i) => `  at com.example.svc.Handler$Inner.process(Handler.java:${100 + i})`).join("\n")],
  ["source-code", fs.existsSync("src/serde.ts") ? fs.readFileSync("src/serde.ts", "utf8") : "const x = 1;"],
];

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const corpus = files.length
  ? files.map((f) => [path.basename(f), fs.readFileSync(f, "utf8")])
  : SAMPLES;

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`\ntokenizer-report: ${corpus.length} sample(s) against ${MODEL} via /v1/messages/count_tokens`);
  console.log("counting tokens is NOT billed - this measurement is free, it just needs a key.\n");
  for (const [name, text] of corpus) {
    console.log(`  ${name.padEnd(14)} ${String(text.length).padStart(8)} chars | chars/4 = ${String(Math.round(text.length / 4)).padStart(7)} | class-run proxy = ${String(classRuns(text)).padStart(7)}`);
  }
  console.log("\nno key: unrun. Set ANTHROPIC_API_KEY and rerun to get real counts.");
  process.exit(0);
}

const API = "https://api.anthropic.com/v1/messages/count_tokens";
const HEADERS = {
  "content-type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
};

async function countTokens(text) {
  const res = await fetch(API, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).input_tokens;
}

// Every request carries a fixed envelope (role framing, BOS-ish overhead).
// Measure it once on a single character and subtract, or short samples read as
// far worse than they are.
let overhead = 0;
try {
  overhead = (await countTokens("x")) - 1;
} catch (e) {
  console.error(`NOT A MEASUREMENT: could not reach the API (${e.message})`);
  process.exit(1);
}
console.log(`envelope overhead: ${overhead} tokens (subtracted from every count below)\n`);

const rows = [];
let errors = 0;
for (const [name, text] of corpus) {
  try {
    const tok = (await countTokens(text)) - overhead;
    rows.push({ name, chars: text.length, tok, runs: classRuns(text) });
  } catch (e) {
    errors++;
    console.error(`  ${name}: ERROR ${e.message}`);
  }
}

console.log("| sample | chars | real tokens | chars/token | chars/4 says | error |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  const est = Math.round(r.chars / ASSUMED);
  const err = (100 * (est / r.tok - 1)).toFixed(0);
  console.log(`| ${r.name} | ${r.chars} | ${r.tok} | ${(r.chars / r.tok).toFixed(2)} | ${est} | ${err > 0 ? "+" : ""}${err}% |`);
}

if (rows.length > 0) {
  const totC = rows.reduce((a, r) => a + r.chars, 0);
  const totT = rows.reduce((a, r) => a + r.tok, 0);
  const totR = rows.reduce((a, r) => a + r.runs, 0);
  console.log(`\npooled: ${(totC / totT).toFixed(2)} chars/token vs the assumed ${ASSUMED.toFixed(2)}`);
  console.log(`  chars/4 is off by ${(100 * (totC / ASSUMED / totT - 1)).toFixed(1)}% overall`);
  console.log(`  a class-run fit would be tokens ~= runs * ${(totT / totR).toFixed(3)}`);
  // Per-sample spread decides whether ONE constant can work at all: if logs and
  // prose disagree sharply, the fix is a shape-aware estimator, not a new number.
  const ratios = rows.map((r) => r.chars / r.tok);
  console.log(`  per-sample spread: ${Math.min(...ratios).toFixed(2)} - ${Math.max(...ratios).toFixed(2)} chars/token`);
  console.log(
    Math.max(...ratios) / Math.min(...ratios) > 1.35
      ? "  => one constant cannot fit this spread; use the class-run fit, not a retuned divisor."
      : "  => the spread is tight; retuning the single divisor is enough.",
  );
  console.log("\nThe error is one-sided (image tokens are exact pixel geometry), so a negative");
  console.log("figure above means tanuki DECLINES wins it should take and under-reports the rest.");
}

if (errors > 0) {
  console.error(`\nNOT A MEASUREMENT: ${errors} sample(s) failed in transport.`);
  process.exit(1);
}
