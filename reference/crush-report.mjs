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

function runArm(argv0, args, fixture, exit, engine) {
  const shimPath = join(shimDir, argv0);
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  const stash = join(shimDir, `stash-${engine === RUST ? "rs" : "ts"}`);
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
  });
}
rmSync(shimDir, { recursive: true, force: true });

console.log("fixture                 exit rule         raw ->  out   saved  distill-only");
for (const r of rows) {
  console.log(
    `${r.file.padEnd(23)} ${String(r.exit).padStart(4)} ${r.rule.padEnd(12)} ${String(r.rawChars).padStart(6)} -> ${String(r.outChars).padStart(5)}  ${String(r.savedPct + "%").padStart(5)}  ${String(r.basePct + "%").padStart(5)}${r.codeOk ? "" : "  EXIT-CODE LOST"}`,
  );
}

const success = rows.filter((r) => r.exit === 0 && r.rule !== "-");
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
console.log(`\nweighted saved ${weighted}% (${rawSum} -> ${outSum} chars over ${rows.length} fixtures) · rules beat distill-only on ${beats}/${success.length} success fixtures`);

if (!haveRust) console.log("(rust engine absent - single-engine numbers, no parity claim)");
let fail = false;
if (parityFail > 0) fail = true;
if (codeLost > 0) { console.error(`FAIL: exit code not passed through on ${codeLost} fixtures`); fail = true; }
if (success.length > 0 && beats * 2 < success.length) {
  console.error(`FAIL: rules beat plain distill on only ${beats}/${success.length} success fixtures - rules are dead weight`);
  fail = true;
}
if (MIN !== null && weighted < MIN) { console.error(`FAIL: weighted ${weighted}% < --min ${MIN}%`); fail = true; }
process.exit(fail ? 1 : 0);
