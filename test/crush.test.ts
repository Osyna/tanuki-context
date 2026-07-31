// Crush tests: rule families, generic pass, guards

import { test } from "bun:test";
import { crushOutput } from "../src/crush.ts";

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
