#!/usr/bin/env node
// Paired-run report: THE honest number — cost per successful task, measured
// tool-on vs tool-off. Same model, same seeded corpus, same success checks,
// N repeats. Everything else in reference/ measures input tokens on corpora;
// this is the one that measures whether the agent still finishes the job and
// what a finished job costs. We publish the harness, not a percentage: a
// savings number nobody can re-measure is the exact failure this repo exists
// to avoid (see the rakuen post "Token compression tools measure the wrong
// thing" — this script is its bar, applied to ourselves).
//
//   ANTHROPIC_API_KEY=... node reference/paired-report.mjs           # run it
//   node reference/paired-report.mjs --dry                           # plan only
//   PAIRED_RUNS=5 PAIRED_MODEL=claude-haiku-4-5 ... [--json out.jsonl]
//
// Arms:
//   off — the corpus is inlined in the prompt; no tanuki anywhere.
//   on  — the corpus is stashed (tanuki_stash) and the agent gets only the
//         ~300-token map + the tanuki tools; it fetches/images what it needs.
// Success is a byte-exact (or containment) check on the final answer, so a
// plausible-wrong-character failure counts as a FAILURE, not a save.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opsCorpus } from "./lib/corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const RUNS = Number(process.env.PAIRED_RUNS ?? 3);
const MODEL = process.env.PAIRED_MODEL; // undefined = SDK default, same for both arms
const MAX_TURNS = Number(process.env.PAIRED_MAXTURNS ?? 12);
// Comma-separated task names; default = all. Running one task is how you make
// this arm affordable enough to iterate on.
const ONLY = (process.env.PAIRED_TASKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Hard spend ceiling. The agent loop can thrash (EVALS §6) and an unattended
// run has already burned $4+ before anyone could stop it.
const BUDGET = Number(process.env.PAIRED_BUDGET ?? 0); // 0 = no ceiling
const DRY = process.argv.includes("--dry");
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : null;

// The fixture is shared with the other end-to-end harnesses (reference/lib):
// same seed, same 74514 chars, same planted answers, so every number this
// script has ever printed stays reproducible after the de-duplication.
const { text: LOG, answers: A } = opsCorpus();
const TASKS = [
  {
    name: "dominant-error-unit",
    q: "Which service unit produced the most ERROR lines in this log? Answer with the unit name only.",
    check: (s) => s.toLowerCase().includes(A.unit),
  },
  {
    name: "pinned-version",
    q: "What exact version was pinned after the failed canary rollback? Answer with the version string only.",
    check: (s) => s.includes(A.version),
  },
  {
    name: "upstream-502-request-id",
    q: "What is the request-id on the upstream 502 error line? Answer with the id only, verbatim.",
    check: (s) => s.includes(A.reqId),
  },
  {
    name: "digest-mismatch-present",
    q: "Does any ERROR line mention a digest mismatch? Answer yes or no.",
    check: (s) => /\byes\b/i.test(s),
  },
];

// ---- plan / dry run ---------------------------------------------------------
const PLAN = ONLY.length > 0 ? TASKS.filter((t) => ONLY.includes(t.name)) : TASKS;
if (PLAN.length === 0) {
  console.error(`no task matched PAIRED_TASKS=${ONLY.join(",")}; known: ${TASKS.map((t) => t.name).join(", ")}`);
  process.exit(2);
}
console.log(
  `paired-report: ${PLAN.length} task(s) x 2 arms x ${RUNS} run(s)` +
    (MODEL ? ` on ${MODEL}` : " on the SDK default model") +
    ` | maxTurns ${MAX_TURNS}` +
    (BUDGET > 0 ? ` | budget $${BUDGET.toFixed(2)}` : ""),
);
if (DRY) {
  for (const t of PLAN) console.log(`  task ${t.name}: ${t.q}`);
  console.log("dry run: no API calls made. Set ANTHROPIC_API_KEY and rerun without --dry.");
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. This harness makes real paired model runs;");
  console.error("we do not fabricate its numbers. Use --dry to see the plan.");
  process.exit(1);
}

// ---- arms -------------------------------------------------------------------
const ARMS = (process.env.PAIRED_ARMS || "off,on").split(",").map((a) => a.trim()).filter(Boolean);
const tmp = mkdtempSync(path.join(os.tmpdir(), "tanuki-paired-"));
process.env.TANUKI_STASH = path.join(tmp, "stash"); // hermetic; inherited by the MCP server
const logFile = path.join(tmp, "service.log");
writeFileSync(logFile, LOG);
const stashMap = execFileSync("node", [CLI, "stash", logFile], { encoding: "utf8" }).trim();

const { query } = await import("@anthropic-ai/claude-agent-sdk").catch(() => {
  console.error("@anthropic-ai/claude-agent-sdk is not installed (it is the harness's only requirement):");
  console.error("  npm i @anthropic-ai/claude-agent-sdk zod");
  process.exit(1);
});
const { withTanuki } = await import(path.join(ROOT, "dist", "agent.js"));

async function runOne(arm, task) {
  const base = { maxTurns: MAX_TURNS, ...(MODEL ? { model: MODEL } : {}), allowedTools: [] };
  const prompt =
    arm === "off"
      ? `Here is a service log:\n\n${LOG}\n\n${task.q}`
      : `A service log was parked with tanuki_stash. Its map:\n\n${stashMap}\n\n` +
        `Use the tanuki tools (tanuki_fetch with a query or line range; estimate/render if useful) to read only what you need, then answer.\n${task.q}`;
  // The `lazy` arm is the `on` arm with TANUKI_VERBATIM=lazy: the sidecar
  // becomes a one-line pointer instead of the carried strings. It is the same
  // agent, same tools, same prompt - only the sidecar policy differs, which is
  // the whole question (42% of a render's tokens, but does the agent then have
  // to make an extra round trip to get an exact id?).
  // The sidecar policy rides an explicit per-arm env, never ambient
  // process.env: mutating global state only stays arm-clean if the SDK spawns
  // a fresh MCP server per query(), and server reuse would silently couple the
  // arms - making the full-vs-lazy comparison unprovable. off/on pass no env
  // at all, so their spawned server is byte-identical to before.
  const options =
    arm === "off" ? base : arm === "lazy" ? withTanuki(base, { env: { TANUKI_VERBATIM: "lazy" } }) : withTanuki(base);
  let text = "";
  let usd = 0;
  // The three input classes differ by up to 12.5x in price ($3.00 fresh /
  // $3.75 cache-write / $0.30 cache-read per Mtok on Sonnet), so a single
  // summed number makes every cost conclusion unfalsifiable: a cached rerun
  // and a cold run look identical. Record them apart; sum only for display.
  // Output is the fourth class and the one no eval here had ever recorded:
  // $15.00/Mtok, 50x a cache read. Every dollar of it is a dollar no
  // input-side tool can touch, which is why it caps this repo's whole thesis.
  let fresh = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let err = null;
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "result") {
        text = m.subtype === "success" ? m.result : "";
        usd = m.total_cost_usd ?? 0;
        const u = m.usage ?? {};
        fresh = u.input_tokens ?? 0;
        cacheRead = u.cache_read_input_tokens ?? 0;
        cacheWrite = u.cache_creation_input_tokens ?? 0;
        output = u.output_tokens ?? 0;
      }
    }
  } catch (e) {
    // A hit turn-cap or SDK error is a FAILED task, not a crashed harness.
    err = e?.message ? String(e.message) : String(e);
  }
  return {
    ok: err === null && task.check(text),
    usd,
    fresh,
    cacheRead,
    cacheWrite,
    output,
    inputSide: fresh + cacheRead + cacheWrite,
    text: err ? `[error: ${err.slice(0, 80)}]` : text.slice(0, 200),
  };
}

// ---- paired runs, task-major so arms interleave under identical conditions --
const rows = [];
let spent = 0;
outer: for (const task of PLAN) {
  for (let i = 0; i < RUNS; i++) {
    for (const arm of ARMS) {
      const r = await runOne(arm, task);
      rows.push({ task: task.name, arm, run: i + 1, ...r });
      console.log(
        `  ${task.name} ${arm} #${i + 1}: ${r.ok ? "PASS" : "FAIL"} $${r.usd.toFixed(4)} ` +
          `in=${r.inputSide} (fresh ${r.fresh} / write ${r.cacheWrite} / read ${r.cacheRead}) out=${r.output}`,
      );
      if (JSON_OUT) appendFileSync(JSON_OUT, JSON.stringify(rows.at(-1)) + "\n");
      spent += r.usd;
      if (BUDGET > 0 && spent >= BUDGET) {
        console.log(`\n[stopped: spent $${spent.toFixed(4)} >= budget $${BUDGET.toFixed(2)}; the table below covers completed runs only]`);
        break outer;
      }
    }
  }
}

// ---- the table ---------------------------------------------------------------
// Published Anthropic list prices for Sonnet, $ per Mtok. Stated here rather
// than buried in a helper, because every dollar figure below is derived from
// these four numbers - and output at $15.00 is 50x a cache read at $0.30.
const USD_PER_MTOK = { fresh: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 };
function statsOf(rs) {
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
  const ok = rs.filter((r) => r.ok).length;
  const usd = sum((r) => r.usd);
  const fresh = sum((r) => r.fresh);
  const cacheRead = sum((r) => r.cacheRead);
  const cacheWrite = sum((r) => r.cacheWrite);
  const output = sum((r) => r.output);
  const inTok = fresh + cacheRead + cacheWrite;
  // The share is MODELED from the list prices above, not taken from
  // total_cost_usd: the SDK reports one opaque dollar figure that cannot be
  // split into an output share at all. The two will not match to the cent
  // (discounts, other models), so `total $` stays the SDK's number and the
  // share stays explicitly derived. Both are shown; neither is laundered.
  const outUsd = (output * USD_PER_MTOK.output) / 1e6;
  const inUsd =
    (fresh * USD_PER_MTOK.fresh + cacheWrite * USD_PER_MTOK.cacheWrite + cacheRead * USD_PER_MTOK.cacheRead) / 1e6;
  return {
    runs: rs.length,
    ok,
    usd,
    fresh,
    cacheRead,
    cacheWrite,
    output,
    inTok,
    perSuccess: ok > 0 ? usd / ok : null,
    // null, not 0: nothing billed means the share is unknown, and printing 0%
    // would read as "output is free" - the most flattering lie available here.
    outSharePct: outUsd + inUsd === 0 ? null : (100 * outUsd) / (outUsd + inUsd),
  };
}
const armStats = (arm) => statsOf(rows.filter((r) => r.arm === arm));
const off = armStats("off");
const on = armStats("on");
const fmt = (s) =>
  `| ${s.runs} | ${s.runs === 0 ? "n/a" : `${s.ok} (${Math.round((100 * s.ok) / s.runs)}%)`} | $${s.usd.toFixed(4)} | ` +
  `${s.fresh} | ${s.cacheWrite} | ${s.cacheRead} | ` +
  `${s.inTok === 0 ? "n/a" : `${Math.round((100 * s.cacheRead) / s.inTok)}%`} | ${s.inTok} | ` +
  `${s.output} | ${s.outSharePct === null ? "n/a" : `${s.outSharePct.toFixed(1)}%`} | ` +
  `${s.perSuccess === null ? "n/a (0 successes)" : `$${s.perSuccess.toFixed(4)}`} |`;
console.log(
  "\n| arm | runs | successes | total $ | fresh in | cache write | cache read | cache hit | input-side tokens | output tok | output $ share | cost per successful task |",
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
console.log(`| off (raw text) ${fmt(off)}`);
console.log(`| on (tanuki) ${fmt(on)}`);
for (const a of ARMS) if (a !== "off" && a !== "on") console.log(`| ${a} ${fmt(armStats(a))}`);
console.log(
  "\nRead cost-per-success, not the token column: a cheap failure is not a saving. Rerun with PAIRED_RUNS=5+ before believing any single delta.",
);
console.log(
  "The three input classes are priced 12.5x apart (fresh / cache-write / cache-read), so compare arms at the same cache hit rate or the token columns say nothing about spend.",
);

// ---- the ceiling -------------------------------------------------------------
// The bound belongs to the UNTOOLED bill, since that is the bill an input-side
// tool proposes to cut; fall back to every recorded row if the off arm was not
// run (PAIRED_ARMS) and name which basis was used.
const ceiling =
  off.runs > 0
    ? { label: "the off (raw text) arm", s: off }
    : { label: `arms ${ARMS.join("+")} combined`, s: statsOf(rows) };
// A check that cannot fail is a bug. If output_tokens ever stops arriving, the
// share reads 0% and the ceiling reads "an input-side tool can save 100% of
// the bill" - precisely the conclusion this repo would most like to hear. So
// refuse to print a ceiling at all rather than print a zero-shaped one.
if (ceiling.s.outSharePct === null || (ceiling.s.inTok > 0 && ceiling.s.output === 0)) {
  console.error(
    ceiling.s.outSharePct === null
      ? "\nNOT A MEASUREMENT: no tokens were billed on any run, so there is no spend to take a share of. Every run failed - check ANTHROPIC_API_KEY and rerun."
      : "\nNOT A MEASUREMENT: input tokens arrived but output_tokens was 0 on every run, so the SDK usage shape changed. No output share, no ceiling.",
  );
  process.exit(1);
}
console.log(
  `\nOutput is ${ceiling.s.outSharePct.toFixed(1)}% of modeled spend on ${ceiling.label}, so no input-side tool - tanuki included - can ever cut more than ${(100 - ceiling.s.outSharePct).toFixed(1)}% of this bill.`,
);
