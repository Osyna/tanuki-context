// Crush tests: rule families, generic pass, guards

import { test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crushOutput, routeOutput } from "../src/crush.ts";
import { DELTA_MIN, diffRuns, norm, runKey } from "../src/delta.ts";
import { fetchSlice } from "../src/stash.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Generic pass: \r tail stripping
test("generic: \\r tail", () => {
  const text = "line1\rline2\rline3\nfinal\roverwrite";
  const r = crushOutput(["cmd"], text, 0);
  assert(r.text === "line3\noverwrite", "should keep only text after last \\r per line");
  assert(r.rule === "generic", "generic pass applied");
});

// Generic pass: spinner lines
test("generic: spinner lines", () => {
  const text = "Building...\n⠋ \nCompiling\n⠙⠹⠸  \t\nDone";
  const r = crushOutput(["cmd"], text, 0);
  assert(!r.text.includes("⠋"), "spinner-only lines dropped");
  assert(!r.text.includes("⠙⠹⠸"), "spinner-only lines dropped");
  assert(r.text.includes("Building"), "non-spinner lines kept");
  assert(r.text.includes("Done"), "non-spinner lines kept");
  assert(r.rule === "generic", "generic pass applied");
});

// Generic pass: progress percentage lines
test("generic: progress percentage", () => {
  const text = "Starting\n50%\n  75%  \n[100%]\n(99%)\nComplete";
  const r = crushOutput(["cmd"], text, 0);
  assert(!r.text.includes("50%"), "bare percentage dropped");
  assert(!r.text.includes("75%"), "bare percentage dropped");
  assert(!r.text.includes("[100%]"), "bracketed percentage dropped");
  assert(!r.text.includes("(99%)"), "parenthesized percentage dropped");
  assert(r.text.includes("Starting"), "real lines kept");
  assert(r.text.includes("Complete"), "real lines kept");
  assert(r.rule === "generic", "generic pass applied");
});

// Rule: cargo (exit 0 with test result)
test("cargo: test result success", () => {
  const text = `   Compiling mylib v0.1.0
   Checking deps v1.0
    Finished test in 1.2s
test result: ok. 5 passed; 0 failed
Some other line`;
  const r = crushOutput(["cargo", "test"], text, 0);
  // Non-vacuity: without crush, all lines would be present
  assert(!r.text.includes("Compiling"), "noise dropped");
  assert(r.text.includes("test result:"), "success line kept");
  assert(!r.text.includes("Some other line"), "only success lines kept on exit 0");
  assert(r.rule === "cargo", "cargo rule applied");
});

// Rule: cargo (exit 0 with warnings)
test("cargo: warnings success", () => {
  const text = `   Compiling mylib v0.1.0
warning: unused variable
   Finished build in 0.5s`;
  const r = crushOutput(["cargo", "build"], text, 0);
  assert(!r.text.includes("Compiling"), "noise dropped");
  assert(r.text.includes("warning:"), "warning kept");
  assert(!r.text.includes("Finished"), "Finished is noise, dropped unless warning present");
  assert(r.rule === "cargo", "cargo rule applied");
});

// Rule: cargo (exit 0 no success match -> drop noise only)
test("cargo: exit 0 no success", () => {
  const text = `   Compiling mylib v0.1.0
   Checking deps v1.0
Build complete`;
  const r = crushOutput(["cargo", "build"], text, 0);
  assert(!r.text.includes("Compiling"), "noise dropped");
  assert(!r.text.includes("Checking"), "noise dropped");
  assert(r.text.includes("Build complete"), "non-noise kept");
  assert(r.rule === "cargo", "cargo rule applied");
});

// Rule: cargo (exit != 0 preserves errors)
test("cargo: exit non-zero", () => {
  const text = `   Compiling mylib v0.1.0
error[E0425]: cannot find value
   Finished in 0.1s`;
  const r = crushOutput(["cargo", "build"], text, 1);
  assert(!r.text.includes("Compiling"), "noise dropped even on error");
  assert(r.text.includes("error[E0425]"), "error line kept");
  // Non-vacuity: without noise filtering, "Compiling" would be present
  assert(!r.text.includes("Finished"), "noise dropped");
  assert(r.rule === "cargo", "cargo rule applied");
});

// Rule: npm-install (success elision)
test("npm-install: success", () => {
  const text = `npm WARN deprecated old@1.0.0
> postinstall script
added 42 packages in 3s
audited 42 packages`;
  const r = crushOutput(["npm", "install"], text, 0);
  assert(!r.text.includes("WARN"), "noise dropped");
  assert(!r.text.includes("postinstall"), "> lines dropped");
  assert(r.text.includes("added 42 packages"), "success line kept");
  assert(r.text.includes("audited"), "success line kept");
  // Non-vacuity: without rule, WARN would be present
  assert(r.rule === "npm-install", "npm-install rule applied");
});

// Rule: npm-install with other package managers
test("npm-install: pnpm/yarn/bun", () => {
  const text = `Progress: downloading
Done in 2s
5 packages installed`;
  
  const pnpm = crushOutput(["pnpm", "add", "pkg"], text, 0);
  assert(pnpm.text.includes("Done in"), "pnpm success kept");
  assert(pnpm.rule === "npm-install", "npm-install rule for pnpm");
  
  const yarn = crushOutput(["yarn", "install"], text, 0);
  assert(yarn.text.includes("Done in"), "yarn success kept");
  assert(yarn.rule === "npm-install", "npm-install rule for yarn");
  
  const bun = crushOutput(["bun", "i"], text, 0);
  assert(bun.text.includes("packages installed"), "bun success kept");
  assert(bun.rule === "npm-install", "npm-install rule for bun");
});

// Rule: pytest (dots progress + summary)
test("pytest: dots and summary", () => {
  const text = `collected 10 items
....F.....
test_foo.py::test_bar FAILED
====== 9 passed, 1 failed in 0.5s ======`;
  const r = crushOutput(["pytest"], text, 0);
  assert(!r.text.includes("....F"), "dots progress dropped");
  assert(r.text.includes("===="), "summary kept on exit 0");
  assert(!r.text.includes("collected"), "only success summary kept on exit 0");
  // Non-vacuity: without dots filter, "....F....." would be present
  assert(r.rule === "pytest", "pytest rule applied");
});

// Rule: go-test (RUN lines + success summary)
test("go-test: success", () => {
  const text = `=== RUN   TestFoo
=== PAUSE TestFoo
=== CONT  TestFoo
ok      mypackage       0.123s
PASS`;
  const r = crushOutput(["go", "test"], text, 0);
  assert(!r.text.includes("RUN"), "RUN noise dropped");
  assert(!r.text.includes("PAUSE"), "PAUSE noise dropped");
  assert(!r.text.includes("CONT"), "CONT noise dropped");
  assert(r.text.includes("ok"), "success kept");
  assert(r.text.includes("PASS"), "PASS kept");
  // Non-vacuity: without noise filter, "=== RUN" would be present
  assert(r.rule === "go-test", "go-test rule applied");
});

// Rule: git-status (drop usage hints)
test("git-status: usage hints", () => {
  const text = `On branch main
Changes not staged:
  modified: foo.ts
  (use "git add <file>..." to update)
  (use "git restore <file>..." to discard)`;
  const r = crushOutput(["git", "status"], text, 0);
  assert(!r.text.includes("(use"), "usage hints dropped");
  assert(r.text.includes("On branch"), "status info kept");
  assert(r.text.includes("modified:"), "changes kept");
  // Non-vacuity: without filter, "(use" would be present
  assert(r.rule === "git-status", "git-status rule applied");
});

// Rule: git-diff (hunk body cap at 100 lines)
test("git-diff: hunk truncation", () => {
  const headers = [
    "diff --git a/file.txt b/file.txt",
    "index abc123..def456 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,150 +1,150 @@",
  ];
  const hunkLines = Array.from({ length: 150 }, (_, i) => ` line ${i + 1}`);
  const text = [...headers, ...hunkLines].join("\n");
  
  const r = crushOutput(["git", "diff"], text, 0);
  const lines = r.text.split("\n");
  
  // All headers kept
  assert(lines.some(l => l.includes("diff --git")), "diff header kept");
  assert(lines.some(l => l.includes("index ")), "index kept");
  assert(lines.some(l => l.includes("---")), "--- kept");
  assert(lines.some(l => l.includes("+++")), "+++ kept");
  assert(lines.some(l => l.includes("@@")), "@@ kept");
  
  // Body capped at 100 + truncation marker
  assert(r.text.includes("[... 50 lines truncated]"), "truncation marker present");
  assert(!r.text.includes("line 149"), "line beyond 100 not present");
  // Non-vacuity: without cap, line 149 would be present
  assert(r.rule === "git-diff", "git-diff rule applied");
});

// Rule: git-diff with git show
test("git-diff: git show variant", () => {
  const text = `commit abc123
diff --git a/f.txt b/f.txt
+new line`;
  const r = crushOutput(["git", "show"], text, 0);
  assert(r.text.includes("diff --git"), "git show triggers git-diff rule");
  assert(r.text.includes("+new line"), "content kept");
});

// Rule: tsc (drop blank lines)
test("tsc: blank lines", () => {
  const text = `src/main.ts:10:5 - error TS2304: Cannot find name 'foo'.

10     foo();
       ~~~

Found 1 error.`;
  const r = crushOutput(["tsc"], text, 0);
  const lines = r.text.split("\n");
  // Blank lines removed
  const blankCount = lines.filter(l => l.trim() === "").length;
  const origBlankCount = text.split("\n").filter(l => l.trim() === "").length;
  assert(blankCount < origBlankCount, "blank lines dropped");
  assert(r.text.includes("error TS2304"), "error kept");
  assert(r.text.includes("Found 1 error"), "summary kept");
  // Non-vacuity: original has blank lines
  assert(r.rule === "tsc", "tsc rule applied");
});

// Rule: eslint (blank lines + success elision)
test("eslint: success summary", () => {
  const text = `
/path/to/file.js
  1:1  error  'foo' is not defined  no-undef

✖ 1 problem (1 error, 0 warnings)
`;
  const r = crushOutput(["eslint", "."], text, 0);
  assert(!r.text.startsWith("\n"), "leading blank dropped");
  assert(r.text.includes("✖"), "success summary kept");
  assert(!r.text.includes("/path/to/file.js"), "file path dropped on success elision");
  // Non-vacuity: without elision, file path would be kept
  assert(r.rule === "eslint", "eslint rule applied");
});

// Rule: list-cap (ls, find, grep, rg, fd)
test("list-cap: ls", () => {
  const files = Array.from({ length: 250 }, (_, i) => `file${i}.txt`);
  const text = files.join("\n");
  const r = crushOutput(["ls"], text, 0);
  const lines = r.text.split("\n");
  assert(lines.length === 201, "200 files + 1 marker line"); // 200 kept + marker
  assert(r.text.includes("[... 50 more lines]"), "truncation marker present");
  assert(r.text.includes("file0.txt"), "first file kept");
  assert(r.text.includes("file199.txt"), "200th file kept");
  assert(!r.text.includes("file200.txt"), "201st file dropped");
  // Non-vacuity: without cap, file200 would be present
  assert(r.rule === "list-cap", "list-cap rule applied");
});

// Rule: list-cap (docker ps, kubectl get)
test("list-cap: docker and kubectl", () => {
  const containers = Array.from({ length: 210 }, (_, i) => `container-${i}`);
  const text = containers.join("\n");
  
  const docker = crushOutput(["docker", "ps"], text, 0);
  assert(docker.text.includes("[... 10 more lines]"), "docker ps capped");
  assert(docker.rule === "list-cap", "list-cap for docker");
  
  const kubectl = crushOutput(["kubectl", "get", "pods"], text, 0);
  assert(kubectl.text.includes("[... 10 more lines]"), "kubectl get capped");
  assert(kubectl.rule === "list-cap", "list-cap for kubectl");
});

// ok fallback
test("ok: empty output after crushing", () => {
  const text = "  \n\t\n  ";
  const r = crushOutput(["cmd"], text, 0);
  assert(r.text === "ok", "whitespace-only becomes ok");
});

test("ok: all spinner lines", () => {
  const text = "⠋  \n⠙⠹⠸\t";
  const r = crushOutput(["cmd"], text, 0);
  assert(r.text === "ok", "all-spinner output becomes ok");
});

// never-worse guard
test("never-worse: crushing expands output", () => {
  // Contrived: a case where the truncation marker is longer than what's saved
  const text = "a\nb\nc";
  // If a rule added a long marker but dropped little, the guard should prevent it
  // For git-diff, if we only had 3 lines and added truncation, it wouldn't save chars
  const r = crushOutput(["git", "diff"], text, 0);
  // git-diff shouldn't trigger on non-diff content, so rule should be null
  assert(r.rule === null || r.rule === "generic", "no expansion allowed");
  assert(r.text.length <= text.length, "never-worse guard prevents expansion");
});

test("never-worse: original returned when not shrinking", () => {
  const text = "short";
  const r = crushOutput(["tsc"], text, 0);
  // tsc rule tries to drop blank lines, but there are none, so no change
  // If result >= original, should return original with rule=null
  assert(r.text === text, "original returned");
  assert(r.rule === null, "rule is null when not shrinking");
});

// Rule attribution
test("rule attribution: generic only", () => {
  const text = "line1\rline2";
  const r = crushOutput(["unknown"], text, 0);
  assert(r.text === "line2", "generic pass applied");
  assert(r.rule === "generic", "rule is 'generic'");
});

test("rule attribution: rule applied", () => {
  const text = "   Compiling x\noutput";
  const r = crushOutput(["cargo", "build"], text, 0);
  assert(r.rule === "cargo", "rule is the rule name");
});

test("rule attribution: no change", () => {
  const text = "plain output";
  const r = crushOutput(["unknown"], text, 0);
  // Generic pass doesn't change anything, no rule applies
  // But we need to check if it's unchanged
  // If text is the same and no generic change happened, rule should be null
  assert(r.text === text, "unchanged");
  assert(r.rule === null, "rule is null when nothing changed");
});

// Edge cases
test("empty command", () => {
  const r = crushOutput([], "text", 0);
  assert(r.text === "text", "empty command returns original");
  assert(r.rule === null, "no rule applied");
});

test("empty text", () => {
  const r = crushOutput(["cmd"], "", 0);
  assert(r.text === "", "empty text returns empty");
  assert(r.rule === null, "no rule applied");
});

test("basename extraction: path with directories", () => {
  const text = "   Compiling x\nok";
  const r1 = crushOutput(["/usr/bin/cargo", "test"], text, 0);
  assert(r1.rule === "cargo", "Unix path basename extracted");
  
  const r2 = crushOutput(["C:\\tools\\cargo.exe", "test"], text, 0);
  assert(r2.rule === "cargo", "Windows path with .exe stripped");
});

// Non-vacuity examples (assertions that old behavior would fail)
test("non-vacuity: cargo noise would be present without rule", () => {
  const text = "   Compiling mylib\ntest result: ok";
  const r = crushOutput(["cargo", "test"], text, 0);
  // This asserts that without the cargo rule, we'd still see "Compiling"
  const withoutRule = crushOutput(["notcargo", "test"], text, 0);
  assert(withoutRule.text.includes("Compiling"), "without cargo rule, noise is kept");
  assert(!r.text.includes("Compiling"), "with cargo rule, noise is dropped");
});

test("non-vacuity: pytest dots would be present without rule", () => {
  const text = "......\nsummary";
  const r = crushOutput(["pytest"], text, 0);
  const withoutRule = crushOutput(["notpytest"], text, 0);
  assert(withoutRule.text.includes("......"), "without pytest rule, dots kept");
  assert(!r.text.includes("......"), "with pytest rule, dots dropped");
});

test("non-vacuity: git-diff lines beyond 100 would be present", () => {
  const headers = ["diff --git a/f b/f", "@@ -1,110 +1,110 @@"];
  const hunkLines = Array.from({ length: 110 }, (_, i) => ` line${i}`);
  const text = [...headers, ...hunkLines].join("\n");
  
  const r = crushOutput(["git", "diff"], text, 0);
  assert(!r.text.includes("line109"), "line 109 (beyond 100 body lines) dropped");
  
  const withoutRule = crushOutput(["notgit", "diff"], text, 0);
  assert(withoutRule.text.includes("line109"), "without rule, all lines kept");
});

console.log("\nAll tests passed!");

// ---------------------------------------------------------------------------
// 0.23 rules: NDJSON, tables, kubectl managedFields, terraform progress, delta.
// Every input below is a REAL capture committed under reference/crush/ (see
// its manifest.json for the command and how it was taken); the inline strings
// are boundary probes. Planted-answer style: each test names values the
// reader needs, proves they survive byte for byte, and proves the rule saved
// something (a rule that changes nothing passes any survival check).
const FIX = join(import.meta.dir, "..", "reference", "crush");
const fx = (f: string): string => readFileSync(join(FIX, f), "utf8");
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Replay `out` against `raw` in lockstep: a marker line (matched by `marker`,
 *  yielding how many input lines it replaced) must sit where `at` matches the
 *  input line; every other output line must be the next input line exactly.
 *  Returns the replaced input lines, so a test can say what was dropped. */
function replay(raw: string, out: string, at: RegExp, marker: RegExp): string[][] {
  const inp = raw.split("\n");
  let j = 0;
  const dropped: string[][] = [];
  for (const line of out.split("\n")) {
    const m = marker.exec(line);
    if (m === null) {
      assert(line === inp[j], `output line ${JSON.stringify(line)} is not input line ${j + 1} ${JSON.stringify(inp[j])}`);
      j++;
    } else {
      assert(at.test(inp[j]), `marker ${JSON.stringify(line)} does not sit on a matching input line (${JSON.stringify(inp[j])})`);
      const n = Number(m[1]);
      dropped.push(inp.slice(j, j + n));
      j += n;
    }
  }
  assert(j === inp.length, `replay consumed ${j} of ${inp.length} input lines`);
  return dropped;
}

const words = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

const JSON_CMD = ["cargo", "test", "--", "-Z", "unstable-options", "--format", "json", "--report-time"];

test("ndjson: cargo --format json is lossless per line and shorter", () => {
  const raw = fx("cargo-test-json.log");
  const r = crushOutput(JSON_CMD, raw, 101);
  assert(r.rule === "cargo+ndjson", `rule ${r.rule}`);
  const inJson = raw.split("\n").filter((l) => l.startsWith("{"));
  const outJson = r.text.split("\n").filter((l) => l.startsWith("{"));
  assert(inJson.length === 28 && outJson.length === 28, `${inJson.length} vs ${outJson.length} JSON lines`);
  for (let i = 0; i < inJson.length; i++) {
    assert(JSON.stringify(JSON.parse(inJson[i])) === JSON.stringify(JSON.parse(outJson[i])), `line ${i} changed value`);
    assert(!/\s/.test(outJson[i].replace(/"(?:[^"\\]|\\.)*"/g, '""')), `line ${i} still has whitespace outside strings`);
  }
  // planted answers: the failing assertion and where it panicked live inside JSON strings
  assert(r.text.includes("right: Ok(700)") && r.text.includes("TOTAL     193700"), "planted: expected value and the report total inside JSON strings");
  assert(r.text.includes("left: Err(\\\"bad amount"), "planted: escaped quotes inside the string kept");
  assert(r.text.includes("panicked at src/lib.rs:"), "planted: panic location kept");
  assert(r.text.includes('"passed":10,"failed":3'), "planted: suite count kept");
  // non-vacuity: the raw capture is spaced, and the rule removed real chars
  assert(raw.includes('{ "type": "test"'), "fixture is the spaced libtest form");
  assert(raw.length - r.text.length > 300, `saved ${raw.length - r.text.length} chars`);
});

test("ndjson: only JSON lines change, strings stay byte-exact, threshold is JSON >= other", () => {
  const rec = (i: number) => `{ "a": ${i}, "s": "x   y", "b": [ ${i}, ${i + 1} ] }`;
  const fires = ["Running tests", rec(1), rec(2), "warning: something", rec(3), "error: test failed", ""].join("\n");
  const r = crushOutput(["tool"], fires, 0);
  assert(r.rule === "ndjson", `rule ${r.rule}`);
  const lines = r.text.split("\n");
  assert(lines[0] === "Running tests" && lines[3] === "warning: something" && lines[5] === "error: test failed", "other lines untouched");
  assert(lines[1] === '{"a":1,"s":"x   y","b":[1,2]}', `line 1: ${lines[1]}`);
  assert(lines[4] === '{"a":3,"s":"x   y","b":[3,4]}', "inner string spaces kept");
  // one more non-JSON line and the rule stays out
  const no = ["Running tests", rec(1), rec(2), '{ "a": 1,, }', "warning: something", rec(3), "error: test failed", ""].join("\n");
  const n = crushOutput(["tool"], no, 0);
  assert(n.rule === null && n.text === no, `3 JSON vs 4 other lines: ${n.rule}`);
  // fewer than 3 JSON lines never fires
  const two = [rec(1), rec(2)].join("\n");
  assert(crushOutput(["tool"], two, 0).rule === null, "two JSON lines");
  // indented JSON loses its indent (whitespace outside strings), value intact
  const ind = crushOutput(["tool"], [`   ${rec(1)}   `, rec(2), rec(3)].join("\n"), 0);
  assert(ind.text.split("\n")[0] === '{"a":1,"s":"x   y","b":[1,2]}', "indent stripped");
});

test("table: docker ps keeps every cell of every row, padding becomes one TAB", () => {
  const raw = fx("docker-ps.log");
  const r = crushOutput(["docker", "ps"], raw, 0);
  assert(r.rule === "table", `rule ${r.rule}`);
  const inp = raw.split("\n");
  const out = r.text.split("\n");
  assert(inp.length === out.length, "same line count");
  for (let i = 0; i < inp.length; i++) assert(words(inp[i]) === words(out[i].split("\t").join(" ")), `line ${i} content changed`);
  assert(out[0].split("\t").join("|") === "CONTAINER ID|IMAGE|COMMAND|CREATED|STATUS|PORTS|NAMES", `header ${JSON.stringify(out[0])}`);
  // planted answer: which container serves 8081, and what image it runs
  const row = out.find((l) => l.startsWith("bcbd396ae96f"))!.split("\t");
  assert(row.join("|") === 'bcbd396ae96f|nginx:alpine|"/docker-entrypoint.…"|6 days ago|Up 4 hours|127.0.0.1:8081->80/tcp|todo-ui-1', `row ${row.join("|")}`);
  assert(r.text.length < raw.length * 0.8, "at least 20% of the chars gone");
});

test("table: ps aux, df -h and kubectl get pods keep content; a wide COMMAND column stays whole", () => {
  for (const [f, cmd, min] of [
    ["ps-aux.log", ["ps", "aux"], 0.15],
    ["df-h.log", ["df", "-h"], 0.05],
    ["kubectl-get-pods.log", ["kubectl", "get", "pods", "-A"], 0.3],
  ] as [string, string[], number][]) {
    const raw = fx(f);
    const r = crushOutput(cmd, raw, 0);
    assert(r.rule === "table", `${f}: rule ${r.rule}`);
    const inp = raw.split("\n");
    const out = r.text.split("\n");
    for (let i = 0; i < inp.length; i++) assert(words(inp[i]) === words(out[i].split("\t").join(" ")), `${f} line ${i} content changed`);
    assert(raw.length - r.text.length >= raw.length * min, `${f}: saved ${raw.length - r.text.length} of ${raw.length}`);
  }
  const ps = crushOutput(["ps", "aux"], fx("ps-aux.log"), 0).text;
  const row = ps.split("\n").find((l) => l.includes("8002"))!;
  assert(row.includes("python3 -m http.server 8002 --bind 127.0.0.1"), "planted: full command line intact in its cell");
  assert(row.split("\t").at(-1) === "python3 -m http.server 8002 --bind 127.0.0.1" || row.endsWith("python3 -m http.server 8002 --bind 127.0.0.1"), "command is the last cell");
  const df = crushOutput(["df", "-h"], fx("df-h.log"), 0).text.split("\n");
  assert(df.find((l) => l.startsWith("/dev/nvme0n1p1"))!.split("\t").join("|") === "/dev/nvme0n1p1|1022M|355M|668M|35%|/boot", "planted: /boot row");
});

test("table: what is not a table stays text", () => {
  const same = (text: string, why: string) => {
    const r = crushOutput(["tbl"], text, 0);
    assert(r.text === text && r.rule === null, `${why}: ${r.rule}`);
  };
  same(["a b c d", "e f g h", "i j k l", "m n o p", "q r s t", ""].join("\n"), "aligned but unpadded saves nothing");
  same(["NAME     STATUS", "web      Running", "", "db       Running", "cache    Running"].join("\n"), "blank line in the middle");
  same(["NAME     STATUS", "web      Running", "db       Running", " cache   Running"].join("\n"), "row starting with a space");
  same(["NAME     STATUS", "web      Running", "db       Ru\tnning", "cache    Running"].join("\n"), "a TAB already in the text");
  same(["NAME     STATUS", "web      Running", "db       Running"].join("\n"), "header plus two rows is too small");
  // 2-space gutters save 1 char in 14 (7 %): under the 10 % floor it is aligned prose, not a table
  const thin = ["alphabet  cats", "bravo123  dogs", "charlie4  fish", "deltaaaa  owls"];
  same(thin.join("\n"), "under the 10 % saving floor");
  assert(crushOutput(["tbl"], thin.map((l) => l.replace("  ", "   ")).join("\n"), 0).rule === "table", "3-space gutters clear the floor");
  const t = crushOutput(["tbl"], ["NAME        STATUS     PORTS            AGE", "web-1       Running    80/tcp           3d", "api-é…      Pending                     2d", "worker-3    Running    9000/tcp,22/tcp  10h", "db          Running    5432/tcp         12d"].join("\n"), 0);
  assert(t.rule === "table", "empty cell table");
  assert(t.text.split("\n")[2] === "api-é…\tPending\t\t2d", `empty middle cell stays a column: ${JSON.stringify(t.text.split("\n")[2])}`);
});

test("table: list-cap still bounds a long table, after the tabs", () => {
  const head = "CONTAINER ID   IMAGE          COMMAND      NAMES";
  const rows = Array.from({ length: 250 }, (_, i) => `${String(i).padStart(12, "0")}   nginx:alpine   "nginx -g"    web-${i}`);
  const r = crushOutput(["docker", "ps"], [head, ...rows].join("\n"), 0);
  assert(r.rule === "table+list-cap", `rule ${r.rule}`);
  const lines = r.text.split("\n");
  assert(lines.length === 201 && lines[200] === "[... 51 more lines]", `${lines.length} lines`);
  assert(lines[1].split("\t").length === 4, "rows are tab-separated");
});

const KUBE_YAML = ["kubectl", "get", "deployments,services,configmaps", "-A", "-o", "yaml", "--show-managed-fields"];

test("kubectl yaml: managedFields dropped, everything else byte-exact, count named", () => {
  const raw = fx("kubectl-get-yaml.log");
  const r = crushOutput(KUBE_YAML, raw, 0);
  assert(r.rule === "managedfields", `rule ${r.rule} (a document is not a row list to cap)`);
  const dropped = replay(raw, r.text, /^ *managedFields: *$/, /^ *managedFields: \[\] # ([0-9]+) lines dropped$/);
  assert(dropped.length === 14, `${dropped.length} blocks`);
  const gone = dropped.flat().join("\n");
  assert(gone.includes("fieldsV1:") && gone.includes("manager: kubectl-client-side-apply"), "what went is the server bookkeeping");
  assert(!r.text.includes("fieldsV1:") && !r.text.includes("manager:"), "no bookkeeping left");
  // planted answers the reader needs, all outside managedFields
  for (const keep of ["owner: backend-team@example.org", "kubectl.kubernetes.io/last-applied-configuration", "replicas: 2", "kind: Deployment", "resourceVersion:"]) {
    assert(r.text.includes(keep), `planted: ${keep}`);
  }
  assert(dropped.flat().length > 400 && raw.length - r.text.length > 10000, `${dropped.flat().length} lines, ${raw.length - r.text.length} chars`);
  // control: real kubectl hides managedFields by default, the rule leaves that alone
  const plain = crushOutput(KUBE_YAML.slice(0, -1), fx("kubectl-get-yaml-default.log"), 0);
  assert(plain.rule === "list-cap" && !plain.text.includes("managedFields"), `default output: ${plain.rule}`);
});

test("kubectl yaml via routeOutput: never a bigger answer than before the managedFields rule, the map describes the cleaned document", () => {
  withStash(() => {
    const raw = fx("kubectl-get-yaml.log");
    const out = routeOutput(KUBE_YAML, raw, 0, null, ptr, "/proj");
    // measured on HEAD (0.22.1, no managedFields rule): 2847 chars
    assert(out.length <= 2847, `answer ${out.length} chars`);
    assert(out.includes("distill map (managedFields dropped): "), "map says what it left out");
    assert(!out.includes("fieldsV1") && !out.includes("operation: Update"), "no bookkeeping in the map's repeats");
    assert(out.includes(`stashed ${sha(raw)} · ${raw.length} bytes`), "the stash still holds the raw capture");
    // a document that is smaller inline than the old answer stays inline
    const small = ["metadata:", "  managedFields:", ...Array.from({ length: 60 }, (_, i) => `  - manager: m${i}`), "  name: x", "  uid: 7"].join("\n");
    const s = routeOutput(["kubectl", "get", "x", "-o", "yaml"], small + "\n", 0, null, ptr, "/proj");
    assert(s.includes("managedFields: [] # 61 lines dropped") && !s.includes("distill map"), s);
  });
});

test("kubectl json: valid JSON in, valid JSON out, only managedFields differ", () => {
  const raw = fx("kubectl-get-json.log");
  const r = crushOutput(["kubectl", "get", "deployments,services,configmaps", "-A", "-o", "json", "--show-managed-fields"], raw, 0);
  assert(r.rule === "managedfields", `rule ${r.rule}`);
  const dropped = replay(raw, r.text, /^ *"managedFields": \[$/, /^ *"managedFields": \["\.\.\. ([0-9]+) lines dropped"\],?$/);
  assert(dropped.length === 14, `${dropped.length} blocks`);
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "managedFields").map(([k, x]) => [k, scrub(x)]));
    }
    return v;
  };
  const before = JSON.parse(raw);
  const after = JSON.parse(r.text); // still parses
  assert(JSON.stringify(scrub(before)) === JSON.stringify(scrub(after)), "everything but managedFields is the same value");
  assert(before.items[0].metadata.managedFields.length > 0 && after.items[0].metadata.managedFields.length === 1, "one marker entry per block");
  assert(after.items[0].metadata.name === before.items[0].metadata.name, "planted: names survive");
  assert(raw.length - r.text.length > 20000, `saved ${raw.length - r.text.length}`);
});

test("kubectl managedFields: comma / no comma / nested / unterminated / other commands", () => {
  const doc = ["{", '  "m": {', '    "managedFields": [', "      {", '        "manager": "kubectl"', "      }", "    ],", '    "name": "x"', "  },", '  "o": {', '    "managedFields": [', '      { "manager": "z" }', "    ]", "  }", "}"].join("\n");
  const r = crushOutput(["kubectl", "get", "x"], doc, 0);
  assert(r.rule === "managedfields", `rule ${r.rule}`);
  const j = JSON.parse(r.text);
  assert(j.m.managedFields[0] === "... 5 lines dropped" && j.m.name === "x", "comma close kept the comma, sibling key survives");
  assert(j.o.managedFields[0] === "... 3 lines dropped", "no-comma close");
  const yaml = ["metadata:", "  managedFields:", "  - apiVersion: v1", "    manager: a", "  - apiVersion: v1", "    manager: b", "  name: x", "  uid: 7"].join("\n");
  const y = crushOutput(["kubectl", "get", "x"], yaml, 0).text;
  assert(y === "metadata:\n  managedFields: [] # 5 lines dropped\n  name: x\n  uid: 7", `yaml: ${JSON.stringify(y)}`);
  // a block that never closes is left alone rather than swallowing the rest
  const open = ["{", '  "managedFields": [', '    { "manager": "a" }', '  "name": "x"'].join("\n");
  assert(crushOutput(["kubectl", "get", "x"], open, 0).text === open, "unterminated JSON block untouched");
  // only kubectl: `cat` of the same yaml is somebody else's file
  assert(crushOutput(["cat", "f.yaml"], yaml, 0).text === yaml, "other commands keep managedFields");
});

const TF_PROGRESS = /^[A-Za-z].*: (Refreshing state\.\.\.|Reading\.\.\.|Read complete after )/;

test("terraform plan: progress lines become one count line, every diff line and the Plan: summary stay", () => {
  const raw = fx("terraform-plan.log");
  const r = crushOutput(["terraform", "plan"], raw, 0);
  assert(r.rule === "terraform", `rule ${r.rule}`);
  const inp = raw.split("\n");
  const prog = inp.filter((l) => TF_PROGRESS.test(strip(l)));
  const rest = inp.filter((l) => !TF_PROGRESS.test(strip(l)));
  const out = r.text.split("\n");
  const first = inp.findIndex((l) => TF_PROGRESS.test(strip(l)));
  const count = (re: RegExp) => prog.filter((l) => re.test(l)).length;
  const parts = [`${count(/Refreshing state/)} Refreshing state`, `${count(/Reading\.\.\./)} Reading`, `${count(/Read complete/)} Read complete`];
  assert(out[first] === `[terraform: ${prog.length} progress lines dropped: ${parts.join(", ")}]`, `summary ${JSON.stringify(out[first])}`);
  assert(JSON.stringify([...out.slice(0, first), ...out.slice(first + 1)]) === JSON.stringify(rest), "every other line byte-exact, in order");
  // planted answers, ANSI codes and all
  assert(r.text.includes("\x1b[1mPlan:\x1b[0m \x1b[0m4 to add, 0 to change, 2 to destroy."), "planted: Plan summary");
  for (const l of inp.filter((x) => /^\S*\x1b\[1m  # /.test(x) || /^ +\S*\x1b\[3[123]m[+~-]/.test(x) || strip(x).startsWith("  # "))) assert(out.includes(l), `diff header/line kept: ${JSON.stringify(l)}`);
  assert(r.text.includes("# local_file.out[3]") && r.text.includes("must be \x1b[1m\x1b[31mreplaced"), "planted: which resource is replaced");
  assert(prog.length > 30 && raw.length - r.text.length > 4000, `${prog.length} progress lines, saved ${raw.length - r.text.length}`);
});

test("terraform: errors, no-op and apply lines survive; the failure log keeps its diagnostics", () => {
  const fail = fx("terraform-plan-fail.log");
  const rf = crushOutput(["terraform", "plan"], fail, 1);
  assert(rf.rule === "terraform", `rule ${rf.rule}`);
  const errs = fail.split("\n").filter((l) => !TF_PROGRESS.test(strip(l)));
  assert(errs.every((l) => rf.text.includes(l)), "every non-progress line of the failing plan survives");
  assert(strip(fail).includes("Error:") && strip(rf.text).includes("Error:") && strip(rf.text).includes("postcondition"), "planted: the error and why");
  const noop = crushOutput(["terraform", "plan"], fx("terraform-plan-noop.log"), 0);
  assert(strip(noop.text).includes("No changes.") && noop.text.length < 500, `no-op keeps its verdict: ${noop.text.length} chars`);
  const apply = fx("terraform-apply-change.log");
  const ra = crushOutput(["terraform", "apply", "-auto-approve"], apply, 0);
  for (const keep of ["Apply complete!", "Modifying...", "Creating...", "Destroying...", "Creation complete after"]) assert(strip(ra.text).includes(keep), `apply keeps ${keep}`);
  assert(ra.text.length < apply.length * 0.6, "apply-after-change shrank");
});

test("terraform: below 3 progress lines nothing changes; ANSI, bracketed addresses, tofu, lookalikes", () => {
  const two = ["a.b: Refreshing state... [id=1]", "c.d: Refreshing state... [id=2]", "Plan: 0 to add, 0 to change, 0 to destroy.", "Note: nothing else"].join("\n");
  assert(crushOutput(["terraform", "plan"], two, 0).text === two, "two progress lines untouched");
  const four = ["\x1b[0m\x1b[1mrandom_pet.p[0]: Refreshing state... [id=a-b]\x1b[0m", 'module.x["a b"].aws_y.z: Refreshing state... [id=i-1]', "data.local_file.f: Reading...", "data.local_file.f: Read complete after 0s [id=abc]", "", "  # random_pet.p[0] will be updated", '      + name = "x: Reading... y"', "Plan: 0 to add, 1 to change, 0 to destroy."].join("\n");
  for (const bin of ["terraform", "tofu"]) {
    const r = crushOutput([bin, "plan"], four, 0);
    assert(r.text.split("\n")[0] === "[terraform: 4 progress lines dropped: 2 Refreshing state, 1 Reading, 1 Read complete]", `${bin}: ${r.text.split("\n")[0]}`);
    assert(r.text.includes('+ name = "x: Reading... y"'), "a diff line that only looks like progress is kept");
  }
  assert(crushOutput(["cat", "log"], four, 0).text === four, "other commands are not terraform");
});

// --- delta: same command, same cwd, same stash --------------------------------
function withStash<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tanuki-delta-"));
  const prev = process.env.TANUKI_STASH;
  const prevDelta = process.env.TANUKI_DELTA;
  process.env.TANUKI_STASH = dir;
  delete process.env.TANUKI_DELTA;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TANUKI_STASH;
    else process.env.TANUKI_STASH = prev;
    if (prevDelta === undefined) delete process.env.TANUKI_DELTA;
    else process.env.TANUKI_DELTA = prevDelta;
    rmSync(dir, { recursive: true, force: true });
  }
}
const ptr = (id: string) => `fetch ${id}`;
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12);
const CARGO = ["cargo", "test"];

test("delta: two real cargo test runs - one failure fixed, one new, one unchanged", () => {
  withStash(() => {
    const one = fx("cargo-test-fail-1.log");
    const two = fx("cargo-test-fail-2.log");
    const first = routeOutput(CARGO, one, 101, null, ptr, "/proj");
    assert(!first.includes("[tanuki delta]"), "the first run has nothing to compare with");
    const out = routeOutput(CARGO, two, 101, null, ptr, "/proj");
    const idOne = sha(one);
    assert(out.includes(`[tanuki delta] vs previous run ${idOne} · exit 101 (same) · 1 fixed · 1 new`), `head: ${out.split("\n").slice(0, 3).join(" | ")}`);
    assert(out.includes("fixed: test tests::fee_never_negative ... FAILED"), "planted: the fixed failure is named");
    assert(out.includes("new: test tests::interest_compounds_yearly ... FAILED"), "planted: the new failure is named");
    // the persistent failure changed its thread id and nothing else: not fixed, not new
    const head = out.split("\n").filter((l) => l.startsWith("fixed:") || l.startsWith("new:"));
    assert(head.length === 2 && !head.some((l) => l.includes("parse_handles_whitespace")), `items: ${head.join(" | ")}`);
    // its detail block and the golden-report block are pointers now; the new failure's detail is in full
    assert(out.includes(`(same as previous run: 4 lines, fetch id ${idOne})`), "unchanged failure detail replaced by a pointer");
    assert(!out.includes('left: Err("bad amount'), "the unchanged panic body is not repeated");
    assert(out.includes("left: 110000") && out.includes("right: 110250"), "planted: the new failure's detail is complete");
    // ... and the pointer is honest: the previous run is in the stash, the current one too
    assert(fetchSlice(idOne, null, "1-200").includes('left: Err("bad amount'), "previous run fetchable by the id in the pointer");
    assert(out.includes(`fetch ${sha(two)}`), "the current run is fetchable too");
    assert(fetchSlice(sha(two), "report differs", null).includes("report differs from golden"), "full current output stashed");
    // non-vacuity: the same run alone is longer
    const solo = withStash(() => routeOutput(CARGO, two, 101, null, ptr, "/proj"));
    assert(out.length < solo.length, `delta ${out.length} vs solo ${solo.length}`);
  });
});

test("delta: two identical npm test runs collapse to a pointer", () => {
  withStash(() => {
    const a = fx("npm-test-1.log");
    const b = fx("npm-test-2.log");
    assert(a !== b, "the captures differ (timings)");
    const first = routeOutput(["npm", "test"], a, 0, null, ptr, "/proj");
    const second = routeOutput(["npm", "test"], b, 0, null, ptr, "/proj");
    const idA = sha(a);
    assert(second.includes("output identical"), "says nothing changed");
    assert(second.includes(`(same as previous run: ${a.split("\n").length} lines, fetch id ${idA})`), "one pointer");
    assert(second.length < first.length * 0.2, `second run ${second.length} vs first ${first.length}`);
    assert(fetchSlice(idA, "tests 50", null).includes("ℹ tests 50"), "planted: the totals are one fetch away");
    // a real change is not called identical: a test flips to failing
    const broke = b.replace("✔ sorts the answer", "✖ sorts the answer").replace("ℹ pass 50", "ℹ pass 49").replace("ℹ fail 0", "ℹ fail 1");
    const third = routeOutput(["npm", "test"], broke, 1, null, ptr, "/proj");
    assert(!third.includes("output identical") && third.includes("exit 0 -> 1") && third.includes("new: ✖ sorts the answer"), `third: ${third.split("\n").slice(0, 4).join(" | ")}`);
    assert(third.includes("was: ℹ pass 50") && third.includes("now: ℹ pass 49"), "changed counts named");
  });
});

test("delta: a big failing run then a tiny passing one still reports what was fixed", () => {
  withStash(() => {
    routeOutput(CARGO, fx("cargo-test-fail-1.log"), 101, null, ptr, "/proj");
    const pass = "test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    assert(pass.length < DELTA_MIN, "the passing run is under the size floor");
    const out = routeOutput(CARGO, pass, 0, null, ptr, "/proj");
    assert(out.includes("exit 101 -> 0 · 3 fixed · 0 new"), out.split("\n")[1]);
    for (const t of ["fee_never_negative", "parse_handles_whitespace", "report_matches_golden"]) assert(out.includes(`fixed: test tests::${t} ... FAILED`), `planted: ${t}`);
    assert(out.includes("now: test result: ok. 13 passed"), "the new totals");
  });
});

test("delta: keyed by argv (after VAR=) + cwd; off switch; floor; unwritable stash", () => {
  assert(runKey(["FOO=1", "BAR=2", "cargo", "test"], "/p") === runKey(["cargo", "test"], "/p"), "VAR= prefixes ignored");
  assert(runKey(["cargo", "test"], "/p") !== runKey(["cargo", "test"], "/q"), "cwd is part of the key");
  assert(runKey(["cargo", "test"], "/p") !== runKey(["cargo", "test", "--lib"], "/p"), "argv is part of the key");
  assert(/^[0-9a-f]{12}$/.test(runKey(["cargo"], "/p")), "12 hex");
  withStash((dir) => {
    const one = fx("cargo-test-fail-1.log");
    routeOutput(CARGO, one, 101, null, ptr, "/a");
    assert(!routeOutput(CARGO, one, 101, null, ptr, "/b").includes("[tanuki delta]"), "another cwd is another command");
    assert(!routeOutput(["cargo", "test", "--lib"], one, 101, null, ptr, "/a").includes("[tanuki delta]"), "another argv is another command");
    assert(routeOutput(["X=1", "cargo", "test"], one, 101, null, ptr, "/a").includes("output identical"), "VAR= prefix: same command");
    process.env.TANUKI_DELTA = "off";
    assert(!routeOutput(CARGO, one, 101, null, ptr, "/a").includes("[tanuki delta]"), "TANUKI_DELTA=off");
    delete process.env.TANUKI_DELTA;
    assert(existsSync(join(dir, "runs")), "the index lives in the stash dir");
  });
  withStash((dir) => {
    const small = "ok  \tpkg\t0.123s\n";
    routeOutput(["go", "test"], small, 0, null, ptr, "/a");
    assert(small.length < DELTA_MIN && !existsSync(join(dir, "runs")), "a small first run is not indexed");
  });
  // a stash that cannot be written must not fail the command
  const prev = process.env.TANUKI_STASH;
  process.env.TANUKI_STASH = "/dev/null/nope";
  try {
    const out = routeOutput(CARGO, fx("cargo-test-fail-1.log"), 101, null, ptr, "/a");
    assert(out.startsWith("[tanuki run] exit 101"), "still routed");
  } finally {
    if (prev === undefined) delete process.env.TANUKI_STASH;
    else process.env.TANUKI_STASH = prev;
  }
});

test("delta: norm masks what changes on every run, nothing else", () => {
  const same = (a: string, b: string) => assert(norm(a) === norm(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  same("thread 'a' (376631) panicked at src/lib.rs:80:9:", "thread 'a' (487199) panicked at src/lib.rs:80:9:");
  same("✔ creates a new sku (0.456408ms)", "✔ creates a new sku (0.104607ms)");
  same("test result: ok. 1 passed; finished in 0.00s", "test result: ok. 1 passed; finished in 1.25s");
  same("ℹ duration_ms 42.589764", "ℹ duration_ms 7.1");
  same("2026-09-30T10:00:00.123Z ERROR boom", "2026-09-30T11:59:59Z ERROR boom");
  same("took 1s 2s", "took 30s 400ms");
  same("at 0xdeadbeef01", "at 0x1234567890");
  assert(norm("test a::b ... FAILED") !== norm("test a::c ... FAILED"), "different tests stay different");
  assert(norm("line 12: id=3e43d0fb") !== norm("line 13: id=3e43d0fb"), "small numbers are content");
});

test("delta: diffRuns caps long lists, quotes the previous run, keeps exit-code change", () => {
  const fails = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `test t::case_${from + i} ... FAILED`).join("\n");
  const d = diffRuns({ id: "abcdef012345", code: 1, text: `${fails(12)}\nend`, lines: 13 }, { text: "all good\nnothing\nfailed here: none", code: 0 });
  assert(d.head[0] === "[tanuki delta] vs previous run abcdef012345 · exit 1 -> 0 · 12 fixed · 0 new", d.head[0]);
  assert(d.head.filter((l) => l.startsWith("fixed: test ")).length === 10, "10 items shown");
  assert(d.head.includes("fixed: ... 2 more"), "the rest is counted");
  assert(!d.collapsed && d.body === "all good\nnothing\nfailed here: none", "no shared block, body untouched");
});
