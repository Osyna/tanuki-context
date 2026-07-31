#!/usr/bin/env node
// Combined-route report: does the composed crush selection x imaging walk
// strictly beat the old router on the corpora where it fires?
//
// Method: deterministic corpora (thin/fat NDJSON rows, the control ops log,
// and a boundary case below CRUSH_MIN) are passed through `tanuki_estimate`
// with both engines when TANUKI_BIN is present. The call is model-free and
// $0. Each session gets its own TANUKI_STASH.
//
// Gates:
//   1. parity - TS and Rust emit byte-identical estimate JSON per corpus
//   2. thin500 - crush present AND composed best < route.tokens AND savedPct >= 90
//   3. fat60 - imageTokens * 4 < textTokens (imaging crushed rows is a real cut)
//   4. ops, boundary29 - no crush key (classifier boundary holds)
//   5. purity - estimate leaves stash empty; one crush:true call writes >= 1 entry
//   6. --min <pct> gates thin500 savedPct (default 60; npm script passes --min 90)
//
// Usage: node reference/combined-report.mjs [--min N]

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "./lib/mcp.mjs";
import { hex, lcg } from "./lib/rand.mjs";
import { opsCorpus } from "./lib/corpus.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const TS = ["node", join(ROOT, "dist", "cli.js")];
const RUST = process.env.TANUKI_BIN ?? "/tmp/tanuki-rust/target/release/tanuki-context";

const minArg = process.argv.indexOf("--min");
const MIN = minArg !== -1 ? Number(process.argv[minArg + 1]) : 60;
if (!Number.isFinite(MIN)) {
  console.error(`FAIL: --min ${process.argv[minArg + 1]} is not a number`);
  process.exit(1);
}

function notAMeasurement(why) {
  console.error(`NOT A MEASUREMENT: ${why}`);
  process.exit(1);
}

if (!existsSync(TS[1])) notAMeasurement(`${TS[1]} not found - run bun run build first`);

const haveRust = existsSync(RUST);

// ---- corpora ----------------------------------------------------------------
const CRUSH_MIN = 30; // src/table.ts

function thin500() {
  const r = lcg(1001);
  const lines = [];
  for (let i = 0; i < 500; i++) {
    const status = i % 50 === 0 ? "error" : "ok";
    const unit = ["api", "worker", "cache", "relay"][(r() * 4) | 0];
    lines.push(JSON.stringify({ id: hex(r, 8), seq: i, status, unit }));
  }
  return lines.join("\n") + "\n";
}

function fat60() {
  const r = lcg(2001);
  const lines = [];
  for (let i = 0; i < 60; i++) {
    const blob = Array.from({ length: 30 }, () => hex(r, 30)).join("");
    const status = i % 9 === 0 ? "error" : "ok";
    lines.push(JSON.stringify({ id: hex(r, 8), seq: i, status, blob }));
  }
  return lines.join("\n") + "\n";
}

function boundary29() {
  const r = lcg(3001);
  const lines = [];
  for (let i = 0; i < 29; i++) {
    lines.push(JSON.stringify({ id: hex(r, 8), seq: i, status: "ok" }));
  }
  return lines.join("\n") + "\n";
}

const CORPORA = [
  { name: "thin500", text: thin500() },
  { name: "fat60", text: fat60() },
  { name: "ops", text: opsCorpus().text },
  { name: "boundary29", text: boundary29() },
];

// ---- run both engines -------------------------------------------------------
const results = [];
let parityFail = 0;

for (const corpus of CORPORA) {
  const stashTs = mkdtempSync(join(tmpdir(), "tanuki-estimate-ts-"));
  const tsReply = await callTool(TS[0], TS.slice(1), "tanuki_estimate", { text: corpus.text }, {
    env: { TANUKI_STASH: stashTs },
  });
  if (tsReply.error) notAMeasurement(`TS engine failed on ${corpus.name}: ${tsReply.error.message}`);
  const tsData = tsReply.json;
  if (!tsData) notAMeasurement(`TS engine returned non-JSON on ${corpus.name}`);

  let rustData = null;
  if (haveRust) {
    const stashRust = mkdtempSync(join(tmpdir(), "tanuki-estimate-rust-"));
    const rustReply = await callTool(RUST, [], "tanuki_estimate", { text: corpus.text }, {
      env: { TANUKI_STASH: stashRust },
    });
    if (rustReply.error) notAMeasurement(`Rust engine failed on ${corpus.name}: ${rustReply.error.message}`);
    rustData = rustReply.json;
    if (!rustData) notAMeasurement(`Rust engine returned non-JSON on ${corpus.name}`);

    const tsJson = JSON.stringify(tsData);
    const rustJson = JSON.stringify(rustData);
    if (tsJson !== rustJson) {
      console.error(`FAIL: parity broken on ${corpus.name}`);
      console.error(`TS:   ${tsJson.slice(0, 200)}...`);
      console.error(`Rust: ${rustJson.slice(0, 200)}...`);
      parityFail++;
    }
    rmSync(stashRust, { recursive: true, force: true });
  }

  results.push({ name: corpus.name, data: tsData });
  rmSync(stashTs, { recursive: true, force: true });
}

// ---- print table ------------------------------------------------------------
console.log("corpus       rawTok  pick      route  crush.text  crush.img  best  saved%");
for (const r of results) {
  const d = r.data;
  const rawTok = d.rawTextTokens;
  const pick = d.route.pick;
  const routeTok = d.route.tokens;
  const crushText = d.recommend.crush?.textTokens ?? "-";
  const crushImg = d.recommend.crush?.imageTokens ?? "-";
  const composedBest = d.recommend.crush ? Math.min(d.recommend.crush.textTokens, d.recommend.crush.imageTokens) : "-";
  const savedPct = d.recommend.crush?.savedPct ?? "-";
  console.log(
    `${r.name.padEnd(12)} ${String(rawTok).padStart(6)}  ${pick.padEnd(8)}  ${String(routeTok).padStart(5)}  ${String(crushText).padStart(10)}  ${String(crushImg).padStart(9)}  ${String(composedBest).padStart(4)}  ${String(savedPct).padStart(6)}`,
  );
}

// ---- gates ------------------------------------------------------------------
console.log();
let fail = false;

if (haveRust) {
  if (parityFail > 0) {
    console.log(`FAIL: parity broken on ${parityFail} corpus(es)`);
    fail = true;
  } else {
    console.log("PASS: engines byte-identical on all corpora");
  }
} else {
  console.log("n/a (single engine - nothing was compared)");
}

const thin500Result = results.find((r) => r.name === "thin500")?.data;
if (!thin500Result) notAMeasurement("thin500 result missing");
if (!thin500Result.recommend.crush) {
  console.log("FAIL: thin500 crush absent");
  fail = true;
} else {
  const composedBest = Math.min(thin500Result.recommend.crush.textTokens, thin500Result.recommend.crush.imageTokens);
  if (composedBest >= thin500Result.route.tokens) {
    console.log(`FAIL: thin500 composed ${composedBest} >= route ${thin500Result.route.tokens}`);
    fail = true;
  } else if (thin500Result.recommend.crush.savedPct < MIN) {
    console.log(`FAIL: thin500 savedPct ${thin500Result.recommend.crush.savedPct}% < --min ${MIN}%`);
    fail = true;
  } else {
    console.log(`PASS: thin500 crush present, ${composedBest} < ${thin500Result.route.tokens}, savedPct ${thin500Result.recommend.crush.savedPct}% >= ${MIN}%`);
  }
}

const fat60Result = results.find((r) => r.name === "fat60")?.data;
if (!fat60Result) notAMeasurement("fat60 result missing");
if (!fat60Result.recommend.crush) {
  console.log("FAIL: fat60 crush absent");
  fail = true;
} else {
  const imgTok = fat60Result.recommend.crush.imageTokens;
  const txtTok = fat60Result.recommend.crush.textTokens;
  if (imgTok * 4 >= txtTok) {
    console.log(`FAIL: fat60 imageTokens * 4 = ${imgTok * 4} >= textTokens ${txtTok}`);
    fail = true;
  } else {
    console.log(`PASS: fat60 imageTokens * 4 = ${imgTok * 4} < textTokens ${txtTok}`);
  }
}

const opsResult = results.find((r) => r.name === "ops")?.data;
const boundary29Result = results.find((r) => r.name === "boundary29")?.data;
if (!opsResult || !boundary29Result) notAMeasurement("ops or boundary29 result missing");
if (opsResult.recommend.crush || boundary29Result.recommend.crush) {
  console.log(`FAIL: crush present in control (ops: ${!!opsResult.recommend.crush}, boundary29: ${!!boundary29Result.recommend.crush})`);
  fail = true;
} else {
  console.log("PASS: ops and boundary29 have no crush key");
}

// ---- purity -----------------------------------------------------------------
const stashPure = mkdtempSync(join(tmpdir(), "tanuki-pure-"));
const pureReply = await callTool(TS[0], TS.slice(1), "tanuki_estimate", { text: thin500() }, {
  env: { TANUKI_STASH: stashPure },
});
if (pureReply.error) notAMeasurement(`purity check failed: ${pureReply.error.message}`);
const pureEntries = readdirSync(stashPure).length;
if (pureEntries !== 0) {
  console.log(`FAIL: estimate wrote ${pureEntries} stash entries (purity broken)`);
  fail = true;
} else {
  const crushReply = await callTool(TS[0], TS.slice(1), "tanuki_estimate", { text: thin500(), crush: true }, {
    env: { TANUKI_STASH: stashPure },
  });
  if (crushReply.error) notAMeasurement(`crush:true call failed: ${crushReply.error.message}`);
  const crushEntries = readdirSync(stashPure).length;
  if (crushEntries < 1) {
    console.log(`FAIL: crush:true wrote ${crushEntries} entries (non-vacuity broken)`);
    fail = true;
  } else {
    console.log(`PASS: estimate pure (0 entries), crush:true wrote ${crushEntries} (non-vacuity)`);
  }
}
rmSync(stashPure, { recursive: true, force: true });

process.exit(fail ? 1 : 0);
