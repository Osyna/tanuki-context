#!/usr/bin/env node
// Retrieval precision: did tanuki hand the answer back, or only a picture of it?
//
//   node reference/retrieval-report.mjs                # measure, always exit 0
//   node reference/retrieval-report.mjs --min 60       # gate: fail under 60%
//   TANUKI_TS="bun src/cli.ts" node reference/retrieval-report.mjs
//   TANUKI_TS=target/release/tanuki-context node reference/retrieval-report.mjs
//
// Measured 8/12 = 66.7% on both engines (TS dist/cli.js and the rust binary),
// identical cell by cell: this is a property of the tool contract, not of a port.
//
// WHY THIS EXISTS. paired-report.mjs measures task success end to end, so a
// failure there has two indistinguishable causes: bad RETRIEVAL (tanuki handed
// back a slice that did not contain the answer) or bad REASONING (the model had
// the answer and blew it). Those want opposite fixes. The last paired run solved
// 4 of 6 and nobody could say which. This harness isolates the retrieval half:
// no model, no API key, ever. It asks only "after a plausible query, is the
// ground truth in the text the tool returned?"
//
// THE THREE OUTCOMES ARE THE WHOLE POINT.
//   TEXT   - ground truth appears in the concatenated TEXT blocks. Recoverable
//            by any model, byte-exact, no vision involved.
//   PIXELS - absent from the text, present in the slice the tool imaged. The
//            model must read it off a page, and read-back of exact strings is
//            measured at 0/14 even on frontier models (needle-report.mjs), with
//            2 of 5 tested models scoring 0% on imaged pages. So this is scored
//            as a MISS, not partial credit.
//   ABSENT - not in the slice at all. That strategy cannot answer, at any cost.
// Distinguishing PIXELS from ABSENT needs the slice bytes, which the tool does
// not return once it images them. The oracle for that is the engine itself, not
// a reimplementation: a query fetch's slice is exactly `distillLog(text, query,
// 2).distilled` (src/stash.ts fetchSlice), which is the SECOND text block of
// `tanuki_distill`; a line fetch's slice is exactly those corpus lines. Both
// oracles are model-free and cost nothing.
//
// Two traps this harness fell into first, both caught by its own controls and
// both worth naming because they are the ways this measurement fakes a pass:
//   1. Grepping the whole JSON reply scores every row TEXT and measures nothing
//      (three checks in this repo have already "passed" that way). Hence
//      lib/mcp.mjs splitting `text` from `images`, and hence taking only the
//      distilled block from the oracle - the stats block echoes the query, so
//      an exact-substring strategy would have vouched for itself.
//   2. A no-match query is NOT a zero baseline here: distill keeps every
//      error/warn line whatever the query, so a random hex string still hands
//      back both planted ids. That is measured and printed below rather than
//      assumed. The valid control is the near-miss decoy.

import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opsCorpus } from "./lib/corpus.mjs";
import { callTools } from "./lib/mcp.mjs";
import { hex, lcg, UNITS } from "./lib/rand.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TS = (process.env.TANUKI_TS ||
  (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");
const CMD = TS[0];
const ARGS = TS.slice(1);

const MIN = process.argv.includes("--min")
  ? Number(process.argv[process.argv.indexOf("--min") + 1])
  : null;
if (MIN !== null && !Number.isFinite(MIN)) {
  console.error("--min needs a percentage, e.g. --min 60");
  process.exit(2);
}

/** A harness that cannot reach its dependencies must say so, not print zeros. */
function notAMeasurement(why) {
  console.error(`NOT A MEASUREMENT: ${why}`);
  process.exit(1);
}

const { text: LOG, answers: A } = opsCorpus();

// Fixture guard. Every number below is a claim about THIS corpus; if the corpus
// moves, the precision figure silently means something else. These are the
// values reference/lib/corpus.mjs was verified at.
if (LOG.length !== 74514 || A.reqId !== "42440ce06042" || A.version !== "9.4.1-rc.2" || A.unit !== "ingest") {
  notAMeasurement(
    `opsCorpus() drifted: ${LOG.length} chars, reqId=${A.reqId}, version=${A.version}, unit=${A.unit}` +
      " (expected 74514 / 42440ce06042 / 9.4.1-rc.2 / ingest)",
  );
}

// ---- the answers and the strategies an agent would actually try -------------
// Planted at corpus lines 401 (request id) and 801 (pinned version); the unit
// answer is spread over the ERROR lines by construction. The line-range windows
// are 200 lines wide and each contains its answer's line, i.e. the BEST case for
// a bisecting agent - a wider window only images harder.
//
// `decoy` is a plausible-looking WRONG value: a different unit name, the next rc
// tag, the request id with its last nibble flipped. It rides the same replies as
// the real answer, so the control below costs no extra calls and proves the
// classifier matches returned bytes exactly rather than approximately - which is
// the silent-misread failure this whole repo is about.
const ANSWERS = [
  {
    key: "unit",
    truth: A.unit,
    decoy: "egress",
    label: `unit "${A.unit}" (dominant ERROR unit)`,
    exact: A.unit,
    near: "ERROR",
    alt: "502",
    lines: "1-200",
    // what an agent asking "which unit logs the most errors" would type
    words: "ERROR request failed",
  },
  {
    key: "version",
    truth: A.version,
    decoy: "9.4.1-rc.3",
    label: `version "${A.version}" (line 801)`,
    exact: A.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), // query is a regex
    near: "rollback",
    alt: "pinned",
    lines: "701-900",
    words: "pinned rollback canary",
  },
  {
    key: "reqId",
    truth: A.reqId,
    decoy: `${A.reqId.slice(0, -1)}3`,
    label: `request id "${A.reqId}" (line 401)`,
    exact: A.reqId,
    near: "request-id",
    alt: "502",
    lines: "301-500",
    words: "upstream 502 request-id",
  },
];
const STRATS = [
  { col: "exact-substring", kind: "query", pick: (a) => a.exact },
  { col: "near-keyword", kind: "query", pick: (a) => a.near },
  { col: "alt-keyword", kind: "query", pick: (a) => a.alt },
  { col: "line-range", kind: "lines", pick: (a) => a.lines },
  // 0.20: free-word relevance search (context-mode-shaped, integer-scored).
  // The words are what an agent would type WITHOUT knowing the exact string -
  // the same realism rule the near/alt keywords follow.
  { col: "find-words", kind: "find", pick: (a) => a.words },
];

const NOMATCH = hex(lcg(9001), 12); // deterministic useless query
for (const bad of [...ANSWERS.map((a) => a.decoy), NOMATCH]) {
  // A decoy or control string that happens to occur in the corpus turns its
  // control into a coin flip. Fail loudly instead.
  if (LOG.includes(bad)) notAMeasurement(`control string "${bad}" occurs in the corpus`);
}

// TANUKI_VERBATIM is inherited on purpose rather than pinned: the sidecar is
// what carries an id back as text at all, so a deployment that turns it off has
// a genuinely different retrieval precision and should be able to measure its
// own. The policy in effect is printed with the number, because a figure whose
// provenance is invisible is the failure this directory exists to avoid.
const POLICY = process.env.TANUKI_VERBATIM ?? "full (shipped default)";

// ---- stash the corpus, then run every (answer, strategy) pair ----------------
const stashDir = mkdtempSync(path.join(os.tmpdir(), "tanuki-retrieval-"));
const OPTS = {
  cwd: ROOT,
  env: {
    TANUKI_STASH: stashDir,
    TANUKI_EVENTS: path.join(stashDir, "events.jsonl"), // never touch the real log
  },
};

const stashed = await callTools(CMD, ARGS, [{ name: "tanuki_stash", arguments: { text: LOG } }], OPTS)
  .catch((e) => notAMeasurement(`could not spawn "${TS.join(" ")}": ${e.message}`));
const ID = /stashed ([0-9a-f]{12})/.exec(stashed[0].text)?.[1] ?? null;
if (ID === null) {
  notAMeasurement(
    `tanuki_stash returned no id (${JSON.stringify(stashed[0].error ?? stashed[0].text.slice(0, 200))})`,
  );
}

const pairs = ANSWERS.flatMap((a) => STRATS.map((s) => ({ a, s, arg: s.pick(a) })));
const queryPairs = pairs.filter((p) => p.s.kind === "query");
// Per-unit ERROR counts: the ONE route by which the aggregate answer can arrive
// as text at all (the `[query matched N of M lines]` marker). See below.
const countCalls = UNITS.map((u) => ({ name: "tanuki_fetch", arguments: { id: ID, query: `${u} ERROR` } }));
const calls = [
  ...pairs.map((p) => ({
    name: "tanuki_fetch",
    arguments:
      p.s.kind === "query" ? { id: ID, query: p.arg }
      : p.s.kind === "find" ? { id: ID, find: p.arg }
      : { id: ID, lines: p.arg },
  })),
  ...queryPairs.map((p) => ({ name: "tanuki_distill", arguments: { text: LOG, query: p.arg } })),
  ...countCalls,
  { name: "tanuki_fetch", arguments: { id: ID, query: NOMATCH } },
  { name: "tanuki_distill", arguments: { text: LOG, query: NOMATCH } },
];
const out = await callTools(CMD, ARGS, calls, OPTS);
let cur = 0;
const take = (n) => out.slice(cur, (cur += n));
const pairReplies = take(pairs.length);
const oracleReplies = take(queryPairs.length);
const countReplies = take(countCalls.length);
const [nomatchReply, nomatchOracle] = take(2);

// ---- classify ---------------------------------------------------------------
// toolDistill returns [stats JSON, distilled]; the stats echo the query, so only
// the distilled block is the slice. Concatenating both made every exact-
// substring strategy vouch for itself.
const LINES = LOG.split("\n");
const SLICES = pairs.map((p) => {
  if (p.s.kind === "lines") {
    const [lo, hi] = p.arg.split("-").map(Number);
    return LINES.slice(lo - 1, hi).join("\n");
  }
  if (p.s.kind === "find") {
    // find returns its windows as the reply text itself; the windows ARE the
    // slice. If a future change images them, truth lands PIXELS via classify.
    return pairReplies[pairs.indexOf(p)].text;
  }
  const blocks = oracleReplies[queryPairs.indexOf(p)].blocks.filter((b) => b.type === "text");
  return blocks.length < 2 ? "" : blocks[1].text;
});

function classify(truth, reply, slice) {
  if (reply.error !== null) return { verdict: "ERROR", note: reply.error.message ?? "tool error" };
  if (reply.text.includes(truth)) return { verdict: "TEXT", note: "" };
  if (slice.includes(truth)) {
    if (reply.images.length > 0) {
      return { verdict: "PIXELS", note: `in the slice, only on ${reply.images.length} page(s)` };
    }
    // Contradiction: a fetch that does not image returns the slice as text, so
    // either the oracle and the fetch disagree about the slice, or the block
    // split broke. Never report a number derived from this.
    return { verdict: "BUG", note: "in the slice but neither text nor pixels" };
  }
  return { verdict: "ABSENT", note: "not in the slice" };
}

const results = pairs.map((p, i) => ({ ...p, ...classify(p.a.truth, pairReplies[i], SLICES[i]) }));
const decoys = pairs.map((p, i) => ({ ...p, ...classify(p.a.decoy, pairReplies[i], SLICES[i]) }));

// ---- report -----------------------------------------------------------------
console.log(
  `retrieval-report: model-free retrieval precision, engine "${TS.join(" ")}"\n` +
    `corpus opsCorpus() ${LOG.length} chars / ${LINES.length} lines, stash ${ID}\n` +
    `verbatim sidecar policy: ${POLICY}; no API key used or needed`,
);
console.log(`\n| answer | ${STRATS.map((s) => s.col).join(" | ")} |`);
console.log(`| --- | ${STRATS.map(() => "---").join(" | ")} |`);
for (const a of ANSWERS) {
  const cells = STRATS.map((s) => results.find((r) => r.a === a && r.s === s).verdict);
  console.log(`| ${a.label} | ${cells.join(" | ")} |`);
}

const texts = results.filter((r) => r.verdict === "TEXT").length;
const precision = (100 * texts) / results.length;
console.log(
  `\nretrieval precision = ${texts}/${results.length} pairs carried as TEXT = ${precision.toFixed(1)}%`,
);
console.log(
  "PIXELS is counted as a miss on purpose: read-back of exact strings off a page is 0/14 measured,\n" +
    "and 2 of 5 tested models score 0% on imaged pages. A page is not a retrieval.",
);

const misses = results.filter((r) => r.verdict !== "TEXT");
if (misses.length === 0) {
  console.log("\nno misses: every (answer, strategy) pair came back as text.");
} else {
  console.log(`\nnot recoverable as text (${misses.length} pair(s)) - this list is the deliverable:`);
  for (const m of misses) {
    console.log(
      `  ${m.a.key.padEnd(8)} ${m.s.col.padEnd(16)} ${m.verdict.padEnd(7)} ` +
        `${m.s.kind}=${m.arg}  ${m.note}`,
    );
  }
}

// ---- controls, printed as lines, not just asserted --------------------------
let failures = 0;
const control = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
};
console.log("\ncontrols (a check that cannot fail is a bug):");

// The useless strategy. Same 12 replies, but scored against a plausible-looking
// wrong value, so every cell must be ABSENT. If this ever scores above zero the
// classifier has started matching approximately and the precision figure above
// is measuring nothing.
const decoyTexts = decoys.filter((r) => r.verdict === "TEXT").length;
const decoyPixels = decoys.filter((r) => r.verdict === "PIXELS").length;
control(
  `useless strategy (near-miss decoys ${ANSWERS.map((a) => `"${a.decoy}"`).join(", ")}) scores 0`,
  decoyTexts === 0 && decoyPixels === 0,
  `${decoyTexts}/${decoys.length} TEXT, ${decoyPixels} PIXELS - both must be 0`,
);
const pixels = results.filter((r) => r.verdict === "PIXELS").length;
control(
  "the TEXT/PIXELS split actually fires",
  pixels > 0,
  `${pixels} pair(s) scored PIXELS; 0 would mean the split collapsed and every row is being read as text`,
);
const broken = results.concat(decoys).filter((r) => r.verdict === "BUG" || r.verdict === "ERROR");
control(
  "no contradictions between fetch and oracle",
  broken.length === 0,
  broken.map((r) => `${r.a.key}/${r.s.col}: ${r.note}`).join("; "),
);

// The control the obvious design would have used, and the measurement that says
// why it is invalid: a random-hex query matches ZERO lines and the slice STILL
// contains every planted answer, because distill keeps every error/warn line
// regardless of query. Anyone using a no-match query as their zero baseline would
// have "proved" their harness worked while measuring nothing.
//
// The assertion is on the slice, not on the returned text, so it states an engine
// fact and holds under any sidecar policy; where the answers actually LANDED is
// reported beside it.
const nomatch = /query matched (\d+) of (\d+) lines/.exec(nomatchReply.text);
const nomatchBlocks = nomatchOracle.blocks.filter((b) => b.type === "text");
const nomatchSlice = nomatchBlocks.length < 2 ? "" : nomatchBlocks[1].text;
const nomatchLanded = ANSWERS.map(
  (a) => `${a.key}=${classify(a.truth, nomatchReply, nomatchSlice).verdict}`,
);
control(
  `no-match query "${NOMATCH}" matched ${nomatch?.[1] ?? "?"} of ${nomatch?.[2] ?? "?"} lines,` +
    ` slice still carries all ${ANSWERS.length} answers`,
  nomatch?.[1] === "0" && ANSWERS.every((a) => nomatchSlice.includes(a.truth)),
  `landed as ${nomatchLanded.join(" ")} - distill keeps error/warn lines whatever the query, so a\n` +
    "        no-match query is NOT a zero baseline here. The near-miss decoy control above is.",
);

// ---- the counting route -----------------------------------------------------
// The unit answer is an aggregate, not a string: no sidecar carries the word
// "ingest" because it is not an id, hash, version or path. The only text tanuki
// returns that can settle it is the query marker's raw match count, so measure
// whether that route actually ranks the units correctly.
const counts = UNITS.map((u, i) => {
  const m = /query matched (\d+) of (\d+) lines/.exec(countReplies[i].text);
  return { unit: u, n: m === null ? -1 : Number(m[1]) };
}).sort((x, y) => y.n - x.n);
console.log(
  "\ncounting route for the aggregate answer (`[query matched N of M lines]`, the only text\n" +
    "evidence that can settle a \"which unit logged the most errors\" question):",
);
console.log(`  ${counts.map((c) => `${c.unit}=${c.n}`).join("  ")}`);
control(
  `the match-count marker ranks "${A.unit}" first`,
  counts[0].unit === A.unit && counts[0].n > counts[1].n,
  `${counts[0].unit}=${counts[0].n} over ${counts[1].unit}=${counts[1].n}; if the marker ever stops reporting raw\n` +
    "        counts this flips, and the unit question stops being answerable from text at all",
);

// ---- gate -------------------------------------------------------------------
if (failures > 0) {
  console.log(`\n${failures} control FAILURE(S): the numbers above are not trustworthy.`);
  process.exit(1);
}
if (MIN !== null && precision < MIN) {
  console.log(`\nFAIL: retrieval precision ${precision.toFixed(1)}% < --min ${MIN}%`);
  process.exit(1);
}
console.log(
  MIN === null
    ? "\nno --min given: measured only. Pass --min <pct> to gate a release on this."
    : `\nPASS: retrieval precision ${precision.toFixed(1)}% >= --min ${MIN}%`,
);
