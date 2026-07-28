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

// ---- seeded corpus (same LCG discipline as tiers/needle reports) ----------
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");

function corpus() {
  const r = lcg(41);
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const lines = [];
  for (let i = 0; i < 1200; i++) {
    const ts = `2026-07-27T${String(8 + ((i / 300) | 0)).padStart(2, "0")}:${String((i / 5) % 60 | 0).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = units[(r() * units.length) | 0];
    // ingest dominates the errors by construction (task 1's ground truth)
    if (r() < (u === "ingest" ? 0.09 : 0.015)) {
      lines.push(`${ts} ${u} ERROR request failed status=502 retry=${(r() * 3) | 0}`);
    } else {
      lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
    }
  }
  const reqId = hex(lcg(43), 12);
  const answers = { unit: "ingest", version: "9.4.1-rc.2", reqId };
  lines.splice(400, 0, `2026-07-27T08:40:00Z relay ERROR upstream 502 request-id=${reqId} peer=10.0.4.2:8443`);
  lines.splice(800, 0, `2026-07-27T09:10:00Z relay WARN rollback: pinned to ${answers.version} after failed canary`);
  lines.splice(801, 0, `2026-07-27T09:10:01Z relay ERROR digest mismatch, expected sha256:${hex(lcg(47), 16)}`);
  return { text: lines.join("\n") + "\n", answers };
}

const { text: LOG, answers: A } = corpus();
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
  const options = arm === "off" ? base : withTanuki(base);
  let text = "";
  let usd = 0;
  let inputSide = 0;
  let err = null;
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "result") {
        text = m.subtype === "success" ? m.result : "";
        usd = m.total_cost_usd ?? 0;
        const u = m.usage ?? {};
        inputSide = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
  } catch (e) {
    // A hit turn-cap or SDK error is a FAILED task, not a crashed harness.
    err = e?.message ? String(e.message) : String(e);
  }
  return { ok: err === null && task.check(text), usd, inputSide, text: err ? `[error: ${err.slice(0, 80)}]` : text.slice(0, 200) };
}

// ---- paired runs, task-major so arms interleave under identical conditions --
const rows = [];
let spent = 0;
outer: for (const task of PLAN) {
  for (let i = 0; i < RUNS; i++) {
    for (const arm of ["off", "on"]) {
      const r = await runOne(arm, task);
      rows.push({ task: task.name, arm, run: i + 1, ...r });
      console.log(`  ${task.name} ${arm} #${i + 1}: ${r.ok ? "PASS" : "FAIL"} $${r.usd.toFixed(4)} in=${r.inputSide}`);
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
function armStats(arm) {
  const rs = rows.filter((r) => r.arm === arm);
  const ok = rs.filter((r) => r.ok).length;
  const usd = rs.reduce((a, r) => a + r.usd, 0);
  const inTok = rs.reduce((a, r) => a + r.inputSide, 0);
  return { runs: rs.length, ok, usd, inTok, perSuccess: ok > 0 ? usd / ok : null };
}
const off = armStats("off");
const on = armStats("on");
const fmt = (s) =>
  `| ${s.runs} | ${s.ok} (${Math.round((100 * s.ok) / s.runs)}%) | $${s.usd.toFixed(4)} | ${s.inTok} | ${s.perSuccess === null ? "n/a (0 successes)" : `$${s.perSuccess.toFixed(4)}`} |`;
console.log("\n| arm | runs | successes | total $ | input-side tokens | cost per successful task |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
console.log(`| off (raw text) ${fmt(off)}`);
console.log(`| on (tanuki) ${fmt(on)}`);
console.log(
  "\nRead cost-per-success, not the token column: a cheap failure is not a saving. Rerun with PAIRED_RUNS=5+ before believing any single delta.",
);
