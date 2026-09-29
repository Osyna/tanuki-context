// No-regression gate: every number this package is sold on, measured
// model-free on committed or seeded inputs, compared with
// reference/gate-baseline.json. A release may move a number in its good
// direction only; anything else fails CI with the metric, the baseline and
// the new value. `--update` rewrites the baseline, and refuses while anything
// regressed unless `--accept` says the trade is intended.
//
//   bun reference/gate.mjs            compare, exit 1 on a regression
//   bun reference/gate.mjs --update   record a new baseline (no regressions)
//   bun reference/gate.mjs --json     the measured metrics, nothing else
//
// Deterministic metrics must not move against their direction at all: same
// input, same code, same number. Speed is the one noisy family, so it is
// measured as a RATIO to a fixed reference workload in the same process
// (machine-independent to within tens of percent) and fails only past 2x -
// plus a scaling check that catches an O(n^2) slip whatever the machine.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsCorpus, taskCorpus } from "./lib/corpus.mjs";
import { lcg } from "./lib/rand.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = join(ROOT, "reference", "gate-baseline.json");
export const SPEED_TOLERANCE = 2.0;
export const MAX_SCALING = 6.0; // 4x the input may cost at most 6x the time

/** A regression is a move against `better`; speed metrics get SPEED_TOLERANCE. */
export function compare(base, cur) {
  const regressions = [];
  const improvements = [];
  for (const [key, b] of Object.entries(base)) {
    const c = cur[key];
    if (c === undefined) {
      regressions.push(`${key}: measured before (${b.value}), not measured now`);
      continue;
    }
    const tol = b.better === "lower-speed" ? SPEED_TOLERANCE : 1;
    const worse = b.better === "higher" ? c.value < b.value : c.value > b.value * tol;
    const better = b.better === "higher" ? c.value > b.value : c.value < b.value;
    if (worse) regressions.push(`${key}: ${b.value} -> ${c.value} (${b.better === "higher" ? "higher" : "lower"} is better)`);
    else if (better && b.better !== "lower-speed") improvements.push(`${key}: ${b.value} -> ${c.value}`);
  }
  for (const [key, c] of Object.entries(cur)) {
    if (c.limit !== undefined && c.value > c.limit) regressions.push(`${key}: ${c.value} over its hard limit ${c.limit}`);
  }
  return { regressions, improvements };
}

async function measure() {
  const stash = mkdtempSync(join(tmpdir(), "tanuki-gate-"));
  process.env.TANUKI_STASH = stash;
  const { routeOutput } = await import("../src/crush.ts");
  const { distillLog } = await import("../src/distill.ts");
  const { stashText, fetchSlice } = await import("../src/stash.ts");
  const { scanNeedles } = await import("../src/needles.ts");
  const { minifyJson, textTokens } = await import("../src/serde.ts");
  const { transformRequestBody, PROXY_DEFAULTS } = await import("../src/proxy.ts");
  const { toolEstimate } = await import("../src/main.ts");
  const m = {};
  const put = (key, value, better, extra = {}) => (m[key] = { value, better, ...extra });

  // 1. run rules over the committed real command outputs
  const manifest = JSON.parse(readFileSync(join(ROOT, "reference", "crush", "manifest.json"), "utf8"));
  let rawSum = 0;
  let outSum = 0;
  for (const f of manifest.fixtures) {
    if (f.skipped) continue;
    const raw = readFileSync(join(ROOT, "reference", "crush", f.file), "utf8");
    const out = routeOutput(f.cmd, raw, f.exit, null, (id) => `fetch ${id}`);
    rawSum += raw.length;
    outSum += out.length;
    put(`crush.${f.file}.out_chars`, out.length, "lower");
    put(`crush.${f.file}.exit_kept`, out.startsWith(`[tanuki run] exit ${f.exit} `) ? 1 : 0, "higher");
  }
  put("crush.weighted_saved_permille", Math.round((1 - outSum / rawSum) * 1000), "higher");

  // 2. distill: size of what the model reads, and that the planted answers survive
  const ops = opsCorpus();
  const od = distillLog(ops.text, null, 2).distilled;
  put("distill.ops.out_chars", od.length, "lower");
  put("distill.ops.answers_kept", [ops.answers.version, ops.answers.reqId, "digest mismatch"].filter((a) => od.includes(a)).length, "higher");
  let taskChars = 0;
  let fatalKept = 0;
  for (let s = 1; s <= 30; s++) {
    const t = taskCorpus(s);
    const d = distillLog(t.text, null, 2).distilled;
    taskChars += d.length;
    fatalKept += d.includes(`component=${t.token}`) ? 1 : 0;
  }
  put("distill.task30.out_chars", taskChars, "lower");
  put("distill.task30.fatal_kept", fatalKept, "higher");

  // 3. exact strings: the sidecar catches seeded ids of shapes nobody wrote a rule for
  const rnd = lcg(1337);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let caught = 0;
  const N_IDS = 300;
  for (let i = 0; i < N_IDS; i++) {
    const len = 10 + ((rnd() * 20) | 0);
    let id = "";
    for (let k = 0; k < len; k++) id += alphabet[(rnd() * (k === 0 ? 52 : alphabet.length)) | 0];
    const host = `2026-07-27T09:10:0${i % 10}Z relay INFO job ${id} scheduled on shard ${i % 7}\n`.repeat(3);
    caught += scanNeedles(host).needles.some((n) => n.value === id) ? 1 : 0;
  }
  put("ids.random_caught_of_300", caught, "higher");

  // 4. find: plain-language asks mixing common and rare words, over a noisy
  //    log where the common words are on almost every line
  const COMMON = ["request", "failed", "error", "worker", "the", "retry", "status", "service"];
  const RARE = ["checksum", "lease", "quota", "replay", "arena", "digest", "canary", "rollback", "tombstone", "compactor", "snapshot", "fencing"];
  let hit1 = 0;
  let mrr = 0;
  const CASES = 60;
  for (let s = 0; s < CASES; s++) {
    const r = lcg(500 + s);
    const pick = (a) => a[(r() * a.length) | 0];
    const lines = Array.from({ length: 400 }, (_, i) => `t${i} ${pick(COMMON)} ${pick(COMMON)} ${pick(COMMON)} ERROR request failed status=${500 + (i % 4)} worker-${i % 9}`);
    const [a, b] = [pick(RARE), pick(RARE)];
    const gold = 50 + ((r() * 300) | 0);
    lines[gold] = `t${gold} relay ERROR ${a} ${b} mismatch on shard ${gold % 7}`;
    const { id } = stashText(lines.join("\n"));
    const ask = `which ${pick(COMMON)} the ${a} ${pick(COMMON)} ${b} request failed`;
    const heads = fetchSlice(id, null, null, ask, 8).split("\n").filter((l) => /^·find· L\d+-\d+ score/.test(l));
    // windows print in line order; rank them by their printed score
    const ranked = heads.map((h) => ({ a: +/L(\d+)-/.exec(h)[1], b: +/-(\d+) score/.exec(h)[1], s: +/score (\S+)/.exec(h)[1] })).sort((x, y) => y.s - x.s || x.a - y.a);
    const at = ranked.findIndex((w) => w.a <= gold + 1 && gold + 1 <= w.b);
    hit1 += at === 0 ? 1 : 0;
    mrr += at === -1 ? 0 : 1 / (at + 1);
  }
  put("find.hit1_of_60", hit1, "higher");
  put("find.mrr_permille", Math.round((mrr / CASES) * 1000), "higher");

  // 5. lossless JSON: tokens a pretty document costs after minify
  const jr = lcg(77);
  const doc = {
    total_count: 40,
    items: Array.from({ length: 40 }, (_, i) => ({
      id: 1000 + i,
      node_id: `MDEwOlJlcG9zaXRvcnk${(jr() * 1e9) | 0}`,
      name: `repo-${i}`,
      owner: { login: `user${i % 7}`, type: "User", site_admin: false },
      topics: ["cli", "tokens", i % 2 ? "rust" : "typescript"],
      stats: { stars: (jr() * 5000) | 0, forks: (jr() * 400) | 0, open_issues: (jr() * 40) | 0 },
      description: `A seeded description for repository number ${i}, with some words in it.`,
    })),
  };
  const pretty = JSON.stringify(doc, null, 2);
  const min = minifyJson(pretty);
  put("json.pretty_tokens_after_minify", min === null ? textTokens(pretty) : textTokens(min), "lower");
  put("json.roundtrip_exact", min !== null && JSON.stringify(JSON.parse(min)) === JSON.stringify(doc) ? 1 : 0, "higher");
  // the omp/pi hook's mode: line breaks kept, and no line longer than before
  const kept = minifyJson(pretty, true);
  put("json.keep_lines_tokens_after_minify", kept === null ? textTokens(pretty) : textTokens(kept), "lower");
  const widest = (s) => Math.max(...s.split("\n").map((l) => l.length));
  put("json.keep_lines_no_line_grew", kept !== null && widest(kept) <= widest(pretty) && JSON.stringify(JSON.parse(kept)) === JSON.stringify(doc) ? 1 : 0, "higher");

  // 6. proxy: one request with old bulk and a fresh JSON tool result
  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: [{ type: "text", text: ops.text }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "gh", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: pretty }] },
    ],
  });
  const tr = transformRequestBody(body, { ...PROXY_DEFAULTS, port: 0, upstream: "http://127.0.0.1:1" });
  put("proxy.saved_tokens", tr?.savedTokens ?? 0, "higher");

  // 7. imaging: what the ladder says the ops log costs as pages
  const est = toolEstimate({ text: ops.text, level: 0 });
  put("estimate.ops_image_tokens", Number(est.imageTokens), "lower");
  put("estimate.ops_total_saved_pct", Number(est.totalSavedPct), "higher");

  // 8. speed, relative to a fixed workload in this process; best of 5
  const best = (fn) => {
    let t = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      fn();
      t = Math.min(t, performance.now() - t0);
    }
    return t;
  };
  const big = (k) => Array.from({ length: k }, (_, i) => `2026-07-27T09:${String(i % 60).padStart(2, "0")}:00Z worker-${i % 9} INFO poll ok latency=${i % 40}ms req=${(i * 2654435761) % 1e9}`).join("\n");
  const small = big(20_000);
  const large = big(80_000);
  // the reference does what distill does (split, regex-template, count in a
  // Map, join), so a runtime that speeds those up speeds both sides: a sort
  // reference drifted 2x between bun 1.3 and 1.4 while distill did not
  const refMs = best(() => {
    const counts = new Map();
    for (const l of large.split("\n")) {
      const k = l.replace(/[0-9]+/g, "<n>").toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.keys()].join("\n").length;
  });
  const distillSmall = best(() => distillLog(small, null, 2));
  const distillLarge = best(() => distillLog(large, null, 2));
  const findLarge = best(() => fetchSlice(stashText(large).id, null, null, "worker latency request poll", 8));
  put("speed.distill_80k_lines_x_ref", +(distillLarge / refMs).toFixed(3), "lower-speed");
  put("speed.find_80k_lines_x_ref", +(findLarge / refMs).toFixed(3), "lower-speed");
  put("speed.distill_scaling_4x", +(distillLarge / distillSmall).toFixed(2), "lower-speed", { limit: MAX_SCALING });

  rmSync(stash, { recursive: true, force: true });
  return m;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cur = await measure();
  if (args.includes("--json")) {
    console.log(JSON.stringify(cur, null, 1));
    process.exit(0);
  }
  let base = {};
  try {
    base = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    if (!args.includes("--update")) {
      console.error(`NOT A MEASUREMENT: ${BASELINE} missing; run with --update once`);
      process.exit(2);
    }
  }
  const { regressions, improvements } = compare(base, cur);
  for (const [k, v] of Object.entries(cur)) console.log(`${k.padEnd(44)} ${String(v.value).padStart(10)}   ${base[k] ? `(baseline ${base[k].value})` : "(new)"}`);
  if (improvements.length) console.log(`\nimproved:\n  ${improvements.join("\n  ")}`);
  if (regressions.length) console.log(`\nREGRESSED:\n  ${regressions.join("\n  ")}`);
  if (args.includes("--update")) {
    if (regressions.length && !args.includes("--accept")) {
      console.error("\nrefusing to record a baseline that regresses; pass --accept if the trade is intended");
      process.exit(1);
    }
    writeFileSync(BASELINE, JSON.stringify(cur, null, 1) + "\n");
    console.log(`\nbaseline written: ${BASELINE}`);
    process.exit(0);
  }
  console.log(regressions.length ? "\nFAIL" : "\nPASS: nothing moved against its direction");
  process.exit(regressions.length ? 1 : 0);
}
