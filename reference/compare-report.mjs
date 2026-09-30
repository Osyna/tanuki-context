#!/usr/bin/env node
// Comparison report: tanuki-context vs rtk (github.com/rtk-ai/rtk) vs
// context-mode (github.com/mksglu/context-mode) on the committed real command
// outputs in reference/crush/. Two numbers per tool, on the same bytes:
//   1. o200k tokens the model reads (real BPE, not chars/4)
//   2. planted-answer survival: of the exact strings a developer needs from
//      that output (QUESTIONS below), how many are still in what the model reads
// A tool that drops the answer has not "saved" the tokens, so the table reports
// both, and names the winner per fixture among tools that kept every answer.
//
// The competitors are installed and run INSIDE an aisandbox instance, never on
// the host. The script has two halves so only the half that needs them is there:
//
//   collect  (in the sandbox)  replay every fixture through every tool, write outputs.json
//   score    (anywhere)        tokenize + check answers + print the markdown table
//
//   node reference/compare-report.mjs collect --out DIR [--tanuki "node dist/cli.js"]
//                                             [--rtk rtk] [--ctxmode context-mode]
//   node reference/compare-report.mjs score DIR/outputs.json      (needs `bun install` for the tokenizer)
//
// Sandbox recipe (aisandbox/dev image; context-mode needs Bun or Node >= 22.5):
//   instance_deploy {image:"aisandbox/dev", ttl:"90m"}            -> <id>
//   instance_exec   mkdir -p /opt/rtk && cd /opt/rtk && curl -fsSL \
//       https://github.com/rtk-ai/rtk/releases/download/v0.50.0/rtk-x86_64-unknown-linux-musl.tar.gz | tar xz
//   instance_exec   npm i -g bun && bun add -g context-mode       (binary: /root/.bun/bin/context-mode)
//   bun build src/cli.ts --target=node --minify --outfile=STAGE/dist/cli.js ; cp -r assets reference STAGE/
//   instance_put    STAGE -> /work/ctxeval
//   instance_exec   cd /work/ctxeval && PATH=$PATH:/root/.bun/bin node reference/compare-report.mjs collect \
//       --out /work/out --rtk /opt/rtk/rtk
//   instance_get    /work/out/outputs.json -> host ; node reference/compare-report.mjs score outputs.json
//
// How each tool is replayed (the fixtures are captured output, so the real
// programs are replaced by a shim named after them that cats the fixture and
// exits with the recorded code - the same method as crush-report.mjs):
//   tanuki      `tanuki-context run -- <cmd>` through the shim: its production path.
//   rtk         `rtk pipe -f <filter>` on the captured bytes when rtk has a pipe
//               filter for that command; otherwise `rtk <cmd>` through the shim
//               (live mode). rtk rewrites some commands' arguments (git status
//               -> porcelain, go test -> -json, docker ps -> --format) that a
//               shim cannot honour, so those rows are labelled and their argv is
//               logged: read them as "rtk on output it did not ask for".
//   context-mode  the model-written-filter workflow cannot be replayed without a
//               model, so two transparent paths: ctx_execute(shell, cmd, intent)
//               and ctx_batch_execute(commands, queries) with the question as
//               the intent/query. Both return only what the tool prints.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "crush");

/** The strings a developer needs out of each output, and the question a model
 *  would ask. Only fixtures listed here are compared, so adding fixtures to
 *  the crush corpus never silently changes this table. An answer is a string
 *  that must appear verbatim, or an array of accepted spellings (a tool that
 *  reports "84 passed" for "82 passed" + "2 passed" kept the fact). Answers
 *  are content, not layout: a tool that reformats `file(5,2)` as `L5` still
 *  keeps the file, the code and the message. They are checked against the raw
 *  capture at load: an answer the raw bytes lack is a bug here. */
export const QUESTIONS = {
  "cargo-test-pass.log": { ask: "how many tests passed and which warnings were raised", answers: [["84 passed", "82 passed"], "run_len", "scan_needles"] },
  "cargo-build-fail.log": { ask: "why did the build fail and where", answers: ["src/ladder.rs:151:14", "unclosed delimiter", "fn broken("] },
  "pytest-pass.log": { ask: "did the tests pass and how many", answers: ["6 passed"] },
  "pytest-fail.log": { ask: "which tests failed and what were the assertion errors", answers: ["test_fail_one", "test_fail_two", "assert 1 == 2", "assert 10 == 5", "test_fail.py:10"] },
  "go-test-pass.log": { ask: "which packages passed", answers: ["example.com/m/a", "example.com/m/b"] },
  "go-test-fail.log": { ask: "which test failed and what did it expect", answers: ["TestAdd", "main_test.go:7", "want 5", "example.com/m/a"] },
  "npm-install.log": { ask: "was anything installed or already up to date", answers: ["up to date"] },
  "git-status.log": { ask: "which files are staged, modified and untracked", answers: ["a.txt", "b.js", "d.txt"] },
  "git-diff.log": { ask: "what changed in the diff", answers: ["Hello Universe", "return x - y;", "b.js"] },
  "docker-ps.log": { ask: "which containers are running and on which ports", answers: ["todo-db-1", "127.0.0.1:8081->80/tcp", "aisandbox-dind", "Up 4 hours (healthy)"] },
  // three paths from the start, middle and end of a 400-line list: a tool that
  // summarises a listing trades exactly these away
  "find-list.log": { ask: "what license files are there for mailcap, linux-lts-headers and cblas", answers: (raw) => [2, 200, 398].map((i) => raw.split("\n")[i]) },
  "tsc-fail.log": { ask: "which files have type errors and what kinds", answers: ["TS2322", "Type 'string' is not assignable to type 'number'", "helper.ts", "Cannot find name 'config'"] },
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const alts = (a) => (Array.isArray(a) ? a : [a]);
const answersOf = (file, raw) => {
  const q = QUESTIONS[file];
  return typeof q.answers === "function" ? q.answers(raw) : q.answers;
};

/** Replays that cannot be faithful for a tool, with the reason: the tool asks
 *  its child for a different output format than the captured fixture has. Such
 *  a row is reported but left out of the faithful-only totals. */
const RTK_PIPE_UNFAITHFUL = {
  "go-test-pass.log": "rtk's go-test filter parses `go test -json`; the fixture is plain text",
  "go-test-fail.log": "rtk's go-test filter parses `go test -json`; the fixture is plain text",
};

/** A pointer to the full output, where a tool offers one: what a model can
 *  fetch after the in-context text dropped an answer. context-mode has none
 *  to detect (its queries hit an index the model must query itself). */
const POINTER = { tanuki: /tanuki-context fetch [0-9a-f]{6,}/, rtk: /rtk recall|full output|\btee\b/i };
/** rtk `pipe --filter` names that fit a fixture; others fall back to live mode. */
const RTK_PIPE = {
  "cargo-test-pass.log": "cargo-test",
  "pytest-pass.log": "pytest",
  "pytest-fail.log": "pytest",
  "go-test-pass.log": "go-test",
  "go-test-fail.log": "go-test",
  "git-status.log": "git-status",
  "git-diff.log": "git-diff",
  "find-list.log": "find",
  "tsc-fail.log": "tsc",
};

/** One MCP call in a fresh server process; resolves with the text blocks. */
function mcpCall(cmd, name, args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, [], { env, cwd });
    let buf = "";
    let version = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      p.kill();
      resolve({ ...v, version });
    };
    const timer = setTimeout(() => finish({ error: "timeout 60s", text: "" }), 60_000);
    p.on("error", (e) => finish({ error: String(e), text: "" }));
    p.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        try {
          const m = JSON.parse(line);
          if (m.id === 1) version = m.result?.serverInfo?.version ?? null;
          if (m.id === 2) {
            clearTimeout(timer);
            finish({ error: m.error ? JSON.stringify(m.error) : null, text: (m.result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") });
          }
        } catch {}
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "compare-report", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  });
}

const versionOf = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.error ? null : (r.stdout || r.stderr).trim().split("\n")[0];
};

async function collect() {
  const outDir = arg("--out", "compare-out");
  const tanuki = arg("--tanuki", `node ${join(HERE, "..", "dist", "cli.js")}`).split(" ");
  const rtk = arg("--rtk", "rtk");
  const ctxmode = arg("--ctxmode", "context-mode");
  const have = { tanuki: versionOf(tanuki[0], [...tanuki.slice(1), "--version"]), rtk: versionOf(rtk), ctxmode: existsSync(ctxmode) || spawnSync("sh", ["-c", `command -v ${ctxmode}`]).status === 0 };
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
  const work = mkdtempSync(join(tmpdir(), "compare-"));
  const shimDir = join(work, "shim");
  mkdirSync(shimDir);
  const fixtures = manifest.fixtures.filter((f) => !f.skipped && QUESTIONS[f.file]);
  for (const name of new Set(fixtures.map((f) => f.cmd[0]))) {
    const p = join(shimDir, name);
    writeFileSync(p, `#!/bin/sh\necho "$0 $*" >> "$CRUSH_LOG"\ncat "$CRUSH_FIXTURE"\nexit "$CRUSH_EXIT"\n`);
    chmodSync(p, 0o755);
  }
  const rows = [];
  let ctxVersion = null;
  for (const f of fixtures) {
    const raw = readFileSync(join(FIX, f.file), "utf8");
    const q = QUESTIONS[f.file];
    const answers = answersOf(f.file, raw);
    for (const a of answers) if (!alts(a).some((s) => raw.includes(s))) throw new Error(`${f.file}: planted answer ${JSON.stringify(a)} is not in the raw capture`);
    const dir = mkdtempSync(join(work, "fx-"));
    const log = join(dir, "argv.log");
    writeFileSync(log, "");
    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, HOME: dir, CRUSH_FIXTURE: join(FIX, f.file), CRUSH_EXIT: String(f.exit), CRUSH_LOG: log, TANUKI_STASH: join(dir, "stash") };
    const cmdStr = f.cmd.join(" ");
    const arms = { raw: { out: raw } };
    const unfaithful = {};
    const run = (cmd, args, extra = {}) => {
      const t0 = performance.now();
      const r = spawnSync(cmd, args, { encoding: "utf8", env, maxBuffer: 1 << 28, ...extra });
      return { out: (r.stdout ?? "") + (r.error ? `[spawn error: ${r.error.message}]` : ""), ms: Math.round(performance.now() - t0), code: r.status };
    };
    arms.tanuki = run(tanuki[0], [...tanuki.slice(1), "run", "--", ...f.cmd]);
    if (have.rtk) {
      const filter = RTK_PIPE[f.file];
      if (filter) {
        arms.rtk = { ...run(rtk, ["pipe", "-f", filter], { input: raw }), mode: `pipe -f ${filter}` };
        if (RTK_PIPE_UNFAITHFUL[f.file]) unfaithful.rtk = RTK_PIPE_UNFAITHFUL[f.file];
      } else {
        arms.rtk = { ...run(rtk, f.cmd), mode: "live via shim" };
        arms.rtk.argv = readFileSync(log, "utf8").trim().split("\n").map((l) => l.replace(`${shimDir}/`, ""));
        const asked = arms.rtk.argv.find((l) => l !== cmdStr);
        if (asked) unfaithful.rtk = `rtk asked the shim for \`${asked}\`, a format the fixture does not have`;
      }
      // rtk's own stderr notices are not model-visible output; stdout only.
    }
    if (have.ctxmode) {
      const cenv = { ...env, CLAUDE_PROJECT_DIR: dir };
      const exec = await mcpCall(ctxmode, "ctx_execute", { language: "shell", code: cmdStr, intent: q.ask }, cenv, dir);
      arms["ctx-exec"] = { out: exec.text, error: exec.error };
      ctxVersion ??= exec.version;
      const batch = await mcpCall(ctxmode, "ctx_batch_execute", { commands: [{ label: cmdStr, command: cmdStr }], queries: [q.ask] }, { ...cenv, HOME: mkdtempSync(join(work, "home-")) }, dir);
      arms["ctx-batch"] = { out: batch.text, error: batch.error };
    }
    rows.push({ file: f.file, cmd: f.cmd, exit: f.exit, ask: q.ask, answers, arms, unfaithful });
  }
  const meta = { date: new Date().toISOString(), tanuki: have.tanuki, rtk: have.rtk, contextMode: ctxVersion, fixtures: rows.length };
  writeFileSync(join(outDir, "outputs.json"), JSON.stringify({ meta, rows }, null, 1));
  rmSync(work, { recursive: true, force: true });
  console.log(`collected ${rows.length} fixtures x ${Object.keys(rows[0]?.arms ?? {}).length} arms -> ${join(outDir, "outputs.json")}`);
}

const ARMS = [
  ["raw", "raw (no tool)"],
  ["tanuki", "tanuki-context run"],
  ["rtk", "rtk"],
  ["ctx-exec", "context-mode ctx_execute+intent"],
  ["ctx-batch", "context-mode ctx_batch_execute"],
];

/** Pure scoring of a collected outputs.json: per arm and per fixture. */
export function scoreRows(rows, tok) {
  const arms = {};
  const per = [];
  for (const r of rows) {
    const line = { file: r.file, arms: {} };
    for (const [id, a] of Object.entries(r.arms)) {
      const kept = r.answers.filter((x) => alts(x).some((s) => a.out.includes(s))).length;
      const tokens = tok(a.out);
      line.arms[id] = { tokens, kept, of: r.answers.length, all: kept === r.answers.length };
      const t = (arms[id] ??= { tokens: 0, kept: 0, of: 0, fixturesAll: 0, fixtures: 0, lost: 0, lostWithPointer: 0 });
      t.tokens += tokens;
      t.kept += kept;
      t.of += r.answers.length;
      t.fixtures++;
      t.fixturesAll += kept === r.answers.length ? 1 : 0;
      if (kept < r.answers.length) {
        t.lost++;
        t.lostWithPointer += POINTER[id]?.test(a.out) ? 1 : 0;
      }
    }
    // winner = fewest tokens among arms that kept every answer (raw counts: a tool must beat reading it all)
    const ok = Object.entries(line.arms).filter(([, v]) => v.all);
    const min = Math.min(...ok.map(([, v]) => v.tokens));
    line.winners = ok.filter(([, v]) => v.tokens === min).map(([k]) => k);
    per.push(line);
  }
  return { arms, per };
}

function printSummary(title, rows, tok) {
  const { arms, per } = scoreRows(rows, tok);
  const present = ARMS.filter(([id]) => arms[id]);
  const raw = arms.raw.tokens;
  console.log(`### ${title}\n`);
  console.log("| tool | tokens out | saved vs raw | answers kept | fixtures with every answer | of the others, carry a pointer to the full output |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [id, label] of present) {
    const a = arms[id];
    console.log(`| ${label} | ${a.tokens} | ${id === "raw" ? "-" : `${Math.round((1 - a.tokens / raw) * 100)}%`} | ${a.kept}/${a.of} | ${a.fixturesAll}/${a.fixtures} | ${a.lost === 0 ? "-" : POINTER[id] ? `${a.lostWithPointer}/${a.lost}` : `0/${a.lost} (no pointer)`} |`);
  }
  const wins = {};
  for (const p of per) for (const w of p.winners) wins[w] = (wins[w] ?? 0) + 1;
  console.log(`\nfixtures won (fewest tokens among tools that kept every answer; ties count for each): ${Object.entries(wins).map(([k, v]) => `${k} ${v}`).join(" · ")}\n`);
  return { present, per };
}

async function score() {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: compare-report.mjs score <outputs.json>");
    process.exit(2);
  }
  const { meta, rows } = JSON.parse(readFileSync(file, "utf8"));
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
  const tok = (t) => encode(t, { disallowedSpecial: new Set() }).length;
  console.log(`tanuki-context ${meta.tanuki} · rtk ${meta.rtk ?? "absent"} · context-mode ${meta.contextMode ?? "absent"} · committed real fixtures from reference/crush/ · o200k tokens\n`);
  const faithful = rows.filter((r) => Object.keys(r.unfaithful ?? {}).length === 0);
  printSummary(`faithful replay only (${faithful.length} of ${rows.length} fixtures; every tool saw the format it asks its child for)`, faithful, tok);
  const { present, per } = printSummary(`all ${rows.length} fixtures (rows marked † are unfaithful for some tool)`, rows, tok);
  console.log(`| fixture | ${present.map(([, l]) => l).join(" | ")} | fewest tokens with every answer |`);
  console.log(`| --- | ${present.map(() => "---:").join(" | ")} | --- |`);
  for (const p of per) {
    const bad = Object.keys(rows.find((r) => r.file === p.file).unfaithful ?? {});
    console.log(`| ${p.file}${bad.length ? " †" : ""} | ${present.map(([id]) => (p.arms[id] ? `${p.arms[id].tokens} (${p.arms[id].kept}/${p.arms[id].of})${bad.includes(id) ? " †" : ""}` : "-")).join(" | ")} | ${p.winners.join(", ")} |`);
  }
  for (const r of rows) for (const [id, why] of Object.entries(r.unfaithful ?? {})) console.log(`\n† ${r.file} / ${id}: ${why}`);
  const errs = rows.flatMap((r) => Object.entries(r.arms).filter(([, a]) => a.error).map(([id, a]) => `${r.file}/${id}: ${a.error}`));
  if (errs.length) console.log(`\nerrors: ${errs.join("; ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "collect") await collect();
  else if (mode === "score") await score();
  else {
    console.log("usage: compare-report.mjs collect --out DIR [--tanuki CMD] [--rtk PATH] [--ctxmode CMD]   (run inside an aisandbox instance)\n       compare-report.mjs score DIR/outputs.json\nsee the header of this file for the sandbox recipe");
  }
}
