// Crush report: replay committed real command outputs through `tanuki-context
// run` in BOTH engines and measure what the rtk-style rules remove.
//
// Method: each fixture in reference/crush/manifest.json is served by a shim
// executable named after the real tool (cargo, pytest, git, ...) that cats the
// fixture and exits with the recorded code. `run -- <cmd>` therefore sees the
// exact argv and bytes the real tool produced, and the rule table keys on the
// command name exactly as in production.
//
// Three claims, all checked here:
//   1. parity  - TS and Rust emit byte-identical stdout for every fixture
//   2. savings - chars removed vs the raw capture, per fixture and mean
//   3. non-vacuity - the same bytes replayed under a rule-less command name
//     (`replay`) must save LESS on at least half the success fixtures,
//     otherwise the rules are dead weight and this report is lying.
//
// $0, model-free. Usage: node reference/crush-report.mjs [--min N]
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIX = join(ROOT, "reference", "crush");
const TS = ["node", join(ROOT, "dist", "cli.js")];
const RUST = process.env.TANUKI_BIN ?? "/tmp/tanuki-rust/target/release/tanuki-context";
const minArg = process.argv.indexOf("--min");
const MIN = minArg !== -1 ? Number(process.argv[minArg + 1]) : null;

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
} catch {
  console.error("NOT A MEASUREMENT: reference/crush/manifest.json missing");
  process.exit(2);
}
const haveRust = spawnSync(RUST, ["--version"], { encoding: "utf8" }).status !== null;

// One generic shim body: cat the fixture named by env, exit with the recorded
// code. Copied under every tool name so PATH resolution does the routing.
const shimDir = mkdtempSync(join(tmpdir(), "crush-shim-"));
const shim = `#!/bin/sh\ncat "$CRUSH_FIXTURE"\nexit "$CRUSH_EXIT"\n`;

// Every arm gets a stash of its own unless the caller passes one: delta
// (src/delta.ts) compares a run with the previous run of the SAME command in
// the SAME stash, so a shared stash would turn fixtures that share an argv
// (pytest pass/fail, cargo test pairs, every `replay`) into delta runs.
let arms = 0;
function runArm(argv0, args, fixture, exit, engine, stashDir = null) {
  const shimPath = join(shimDir, argv0);
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  const stash = stashDir ?? join(shimDir, `stash-${++arms}`);
  mkdirSync(stash, { recursive: true });
  const cmd = engine === RUST ? [RUST] : TS;
  const r = spawnSync(cmd[0], [...cmd.slice(1), "run", "--", argv0, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      CRUSH_FIXTURE: join(FIX, fixture),
      CRUSH_EXIT: String(exit),
      TANUKI_STASH: stash,
    },
    maxBuffer: 1 << 28,
  });
  return { out: r.stdout ?? "", code: r.status };
}

// A routed output is either the (distilled) text or, when that is over the inline
// budget, only the stash map - smaller in chars, but it shows the model nothing.
const isMap = (out) => /\nstashed [0-9a-f]{12} · /.test(out);
const rows = [];
let parityFail = 0;
for (const f of manifest.fixtures) {
  if (f.skipped) continue;
  const raw = readFileSync(join(FIX, f.file), "utf8");
  const [argv0, ...args] = f.cmd;
  const ts = runArm(argv0, args, f.file, f.exit, "ts");
  const ruleLine = ts.out.split("\n")[0] ?? "";
  const rule = / · rule (\S+)/.exec(ruleLine)?.[1] ?? "-";
  // Non-vacuity arm: identical bytes, command name no rule matches.
  const base = runArm("replay", [], f.file, f.exit, "ts");
  if (haveRust) {
    const rs = runArm(argv0, args, f.file, f.exit, RUST);
    if (rs.out !== ts.out || rs.code !== ts.code) {
      parityFail++;
      console.error(`PARITY DIVERGED: ${f.file}`);
    }
  }
  rows.push({
    file: f.file,
    exit: f.exit,
    rule,
    rawChars: raw.length,
    outChars: ts.out.length,
    baseChars: base.out.length,
    savedPct: raw.length === 0 ? 0 : Math.round((1 - ts.out.length / raw.length) * 100),
    basePct: raw.length === 0 ? 0 : Math.round((1 - base.out.length / raw.length) * 100),
    codeOk: ts.code === f.exit,
    shows: `${isMap(ts.out) ? "map" : "text"}/${isMap(base.out) ? "map" : "text"}`,
  });
}

// Delta (T6): each manifest `pair` runs its `run: 1` then `run: 2` through ONE
// stash per engine. Claims: parity, the second run leads with a delta block,
// and its output is smaller than the same run alone (`solo`, the row above).
const pairRows = [];
let pairFail = 0;
for (const name of new Set(manifest.fixtures.filter((f) => f.pair).map((f) => f.pair))) {
  const [a, b] = [1, 2].map((n) => manifest.fixtures.find((f) => f.pair === name && f.run === n));
  const pair = (engine) => {
    const stash = join(shimDir, `pair-${++arms}`);
    runArm(a.cmd[0], a.cmd.slice(1), a.file, a.exit, engine, stash);
    return runArm(b.cmd[0], b.cmd.slice(1), b.file, b.exit, engine, stash);
  };
  const ts = pair("ts");
  if (haveRust) {
    const rs = pair(RUST);
    if (rs.out !== ts.out || rs.code !== ts.code) {
      pairFail++;
      console.error(`PARITY DIVERGED: delta pair ${name}`);
    }
  }
  const raw = readFileSync(join(FIX, b.file), "utf8").length;
  const solo = rows.find((r) => r.file === b.file).outChars;
  const lines = ts.out.split("\n");
  const head = lines.find((l) => l.startsWith("[tanuki delta]")) ?? "";
  if (head === "") pairFail++;
  pairRows.push({ name, raw, solo, delta: ts.out.length, head, saved: Math.round((1 - ts.out.length / raw) * 100), soloSaved: Math.round((1 - solo / raw) * 100), pointers: lines.filter((l) => l.startsWith("(same as previous run:")).length });
}
rmSync(shimDir, { recursive: true, force: true });

console.log("fixture                      exit rule                    raw ->   out   saved  distill-only  shows(rule/base)");
for (const r of rows) {
  console.log(
    `${r.file.padEnd(28)} ${String(r.exit).padStart(4)} ${r.rule.padEnd(20)} ${String(r.rawChars).padStart(6)} -> ${String(r.outChars).padStart(5)}  ${String(r.savedPct + "%").padStart(5)}  ${String(r.basePct + "%").padStart(5)}  ${r.shows.padStart(9)}${r.codeOk ? "" : "  EXIT-CODE LOST"}`,
  );
}

// `table` and `ndjson` read the SHAPE of the bytes, not the command name, so
// the rule-less `replay` arm gets them too and cannot be the baseline: their
// proof is the saved% vs the raw capture and the planted-answer tests.
const content = (r) => /(^|\+)(table|ndjson)(\+|$)/.test(r.rule);
const success = rows.filter((r) => r.exit === 0 && r.rule !== "-" && !content(r));
const beats = success.filter((r) => r.savedPct > r.basePct).length;
// Chars-weighted, not a mean of percentages: `run` prints a fixed ~70-char
// header, so tiny fixtures (npm's 21-char "up to date") go deeply negative
// and a plain mean reports the header tax, not the rules. Weighted by raw
// size, the number answers the question a user has: of the bytes real
// commands produced, how many reached the model?
const rawSum = rows.reduce((a, r) => a + r.rawChars, 0);
const outSum = rows.reduce((a, r) => a + r.outChars, 0);
const weighted = rawSum === 0 ? 0 : Math.round((1 - outSum / rawSum) * 100);
const codeLost = rows.filter((r) => !r.codeOk).length;
console.log(`\nweighted saved ${weighted}% (${rawSum} -> ${outSum} chars over ${rows.length} fixtures) · rules beat distill-only on ${beats}/${success.length} success fixtures (shape rules table/ndjson excluded: they fire under \`replay\` too)`);

if (pairRows.length > 0) {
  console.log("\ndelta: second run of the same command, one stash    raw2 -> solo -> delta   saved (solo)  pointers");
  for (const p of pairRows) {
    console.log(`${p.name.padEnd(51)} ${String(p.raw).padStart(5)} -> ${String(p.solo).padStart(4)} -> ${String(p.delta).padStart(5)}   ${String(p.saved + "%").padStart(4)} (${p.soloSaved}%)  ${p.pointers}`);
    console.log(`  ${p.head}`);
  }
}

if (!haveRust) console.log("(rust engine absent - single-engine numbers, no parity claim)");
let fail = false;
if (parityFail > 0 || pairFail > 0) fail = true;
if (codeLost > 0) { console.error(`FAIL: exit code not passed through on ${codeLost} fixtures`); fail = true; }
if (success.length > 0 && beats * 2 < success.length) {
  console.error(`FAIL: rules beat plain distill on only ${beats}/${success.length} success fixtures - rules are dead weight`);
  fail = true;
}
if (MIN !== null && weighted < MIN) { console.error(`FAIL: weighted ${weighted}% < --min ${MIN}%`); fail = true; }
process.exit(fail ? 1 : 0);
