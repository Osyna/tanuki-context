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
import { opsCorpus, taskCorpus, vocabGapCorpus } from "./lib/corpus.mjs";
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

/** Real tokens: OpenAI's o200k_base BPE (gpt-tokenizer, a devDependency). The
 *  runtime estimator in src/serde.ts is a fitted heuristic; this is the
 *  yardstick it is measured against, never a replacement for it. */
export async function o200kCounter() {
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
  return (text) => encode(text, { disallowedSpecial: new Set() }).length;
}

/** Mean |estimated - real| / real over payloads, in percent (2 decimals).
 *  Mean of per-payload errors, not error of the sums: over- and under-counts
 *  on different payloads must not cancel. Payloads with no real tokens are
 *  skipped (an empty log has nothing to mis-estimate). */
export function driftPct(pairs) {
  const live = pairs.filter(([, real]) => real > 0);
  if (live.length === 0) return 0;
  return +((live.reduce((a, [est, real]) => a + Math.abs(est - real) / real, 0) / live.length) * 100).toFixed(2);
}

// A section is one function (ctx, put) => void that puts its metrics. To gate
// a new feature add a function below and one line to SECTIONS; nothing else in
// this file changes. ctx carries the loaded modules (ctx.mod), the o200k
// counter (ctx.tok), the shared ops log / pretty JSON document, and
// `ctx.payloads`, the real (raw, routed) texts sectionCrush collects for the
// estimator-drift section (so that one must run after it).
//
// Missing-metric semantics (see compare): a metric in the baseline that is not
// measured now FAILS; a metric measured now that the baseline lacks is printed
// "(new)" and cannot fail (only its own hard `limit` binds). So a section can
// land before the baseline is refreshed, and `--update` makes it binding.

/** 1. run rules over the committed real command outputs */
function sectionCrush(ctx, put) {
  const { routeOutput } = ctx.mod.crush;
  // absolute token totals are not metrics: they would grow with every fixture
  // added to the corpus and read as a regression; per-fixture counts and the
  // weighted ratio do not
  const manifest = JSON.parse(readFileSync(join(ROOT, "reference", "crush", "manifest.json"), "utf8"));
  let rawSum = 0;
  let outSum = 0;
  let rawTok = 0;
  let outTok = 0;
  const shared = process.env.TANUKI_STASH;
  for (const f of manifest.fixtures) {
    if (f.skipped) continue;
    const raw = readFileSync(join(ROOT, "reference", "crush", f.file), "utf8");
    // one stash per fixture: routeOutput diffs against an earlier run of the
    // same argv in the same stash, and fixtures that share argv (pytest x2)
    // must each be measured as a first run
    process.env.TANUKI_STASH = mkdtempSync(join(tmpdir(), "tanuki-gate-fx-"));
    const out = routeOutput(f.cmd, raw, f.exit, null, (id) => `fetch ${id}`);
    rmSync(process.env.TANUKI_STASH, { recursive: true, force: true });
    process.env.TANUKI_STASH = shared;
    rawSum += raw.length;
    outSum += out.length;
    const fixtureTok = ctx.tok(out);
    rawTok += ctx.tok(raw);
    outTok += fixtureTok;
    ctx.payloads.push(raw, out);
    put(`crush.${f.file}.out_chars`, out.length, "lower");
    put(`crush.${f.file}.out_tokens_o200k`, fixtureTok, "lower");
    put(`crush.${f.file}.exit_kept`, out.startsWith(`[tanuki run] exit ${f.exit} `) ? 1 : 0, "higher");
  }
  put("crush.weighted_saved_permille", Math.round((1 - outSum / rawSum) * 1000), "higher");
  // the same saving in real tokens: the header `run` prints is a fixed cost that
  // chars hide and tokens do not
  put("crush.weighted_saved_tokens_permille_o200k", Math.round((1 - outTok / rawTok) * 1000), "higher");
}

/** 2. distill: size of what the model reads, and that the planted answers survive */
function sectionDistill(ctx, put) {
  const { distillLog } = ctx.mod.distill;
  const { ops } = ctx;
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
}

/** 3. exact strings: the sidecar catches seeded ids of shapes nobody wrote a rule for */
function sectionIds(ctx, put) {
  const { scanNeedles } = ctx.mod.needles;
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
}

/** 4. find: plain-language asks mixing common and rare words, over a noisy
 *  log where the common words are on almost every line */
function sectionFind(ctx, put) {
  const { stashText, fetchSlice } = ctx.mod.stash;
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
}

/** 5. lossless JSON: tokens a pretty document costs after minify, estimated and real */
function sectionJson(ctx, put) {
  const { minifyJson, textTokens } = ctx.mod.serde;
  const { doc, pretty } = ctx;
  const min = minifyJson(pretty);
  const minText = min === null ? pretty : min;
  put("json.pretty_tokens_after_minify", textTokens(minText), "lower");
  put("json.pretty_tokens_after_minify_o200k", ctx.tok(minText), "lower");
  put("json.roundtrip_exact", min !== null && JSON.stringify(JSON.parse(min)) === JSON.stringify(doc) ? 1 : 0, "higher");
  // the omp/pi hook's mode: line breaks kept, and no line longer than before
  const kept = minifyJson(pretty, true);
  const keptText = kept === null ? pretty : kept;
  put("json.keep_lines_tokens_after_minify", textTokens(keptText), "lower");
  put("json.keep_lines_tokens_after_minify_o200k", ctx.tok(keptText), "lower");
  const widest = (s) => Math.max(...s.split("\n").map((l) => l.length));
  put("json.keep_lines_no_line_grew", kept !== null && widest(kept) <= widest(pretty) && JSON.stringify(JSON.parse(kept)) === JSON.stringify(doc) ? 1 : 0, "higher");
  ctx.jsonPair = [pretty, minText];
}

/** 6. proxy: one request with old bulk and a fresh JSON tool result */
function sectionProxy(ctx, put) {
  const { transformRequestBody, PROXY_DEFAULTS } = ctx.mod.proxy;
  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: [{ type: "text", text: ctx.ops.text }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "gh", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: ctx.pretty }] },
    ],
  });
  const tr = transformRequestBody(body, { ...PROXY_DEFAULTS, port: 0, upstream: "http://127.0.0.1:1" });
  put("proxy.saved_tokens", tr?.savedTokens ?? 0, "higher");
}

/** 7. imaging: what the ladder says the ops log costs as pages */
function sectionImaging(ctx, put) {
  const est = ctx.mod.main.toolEstimate({ text: ctx.ops.text, level: 0 });
  put("estimate.ops_image_tokens", Number(est.imageTokens), "lower");
  put("estimate.ops_total_saved_pct", Number(est.totalSavedPct), "higher");
}

/** 8a. find vocabulary gaps: 24 asks whose gold line shares no whole word with
 *  the ask (reference/lib/corpus.mjs VOCAB_GAP); hit@1 and MRR over the printed
 *  window scores, as the seeded find set above. Before synonyms and stems: 0/24. */
function sectionVocabGap(ctx, put) {
  const { stashText, fetchSlice } = ctx.mod.stash;
  const { text, asks } = vocabGapCorpus();
  const { id } = stashText(text);
  const goldAt = (gold) => text.split("\n").indexOf(gold) + 1;
  let hit1 = 0;
  let mrr = 0;
  for (const { ask, gold } of asks) {
    const at = goldAt(gold);
    const ranked = [...fetchSlice(id, null, null, ask, 8).matchAll(/^·find· L(\d+)-(\d+) score (\S+)/gm)]
      .map((m) => ({ a: +m[1], b: +m[2], s: +m[3] }))
      .sort((x, y) => y.s - x.s || x.a - y.a);
    const rank = ranked.findIndex((w) => w.a <= at && at <= w.b);
    hit1 += rank === 0 ? 1 : 0;
    mrr += rank === -1 ? 0 : 1 / (rank + 1);
  }
  put("find.vocab_gap_hit1_of_24", hit1, "higher");
  put("find.vocab_gap_mrr_permille", Math.round((mrr / asks.length) * 1000), "higher");
}

/** 8b. the 0.23 run rules fire on their real fixtures, and the kubectl
 *  document never costs more than the answer 0.22.1 gave for it (2847 chars,
 *  measured on HEAD 9f6e121: the first 200 raw lines, mostly managedFields). */
function sectionCrushRules(ctx, put) {
  const { crushOutput, routeOutput } = ctx.mod.crush;
  const manifest = JSON.parse(readFileSync(join(ROOT, "reference", "crush", "manifest.json"), "utf8"));
  const want = {
    "cargo-test-json.log": "ndjson",
    "docker-ps.log": "table",
    "ps-aux.log": "table",
    "df-h.log": "table",
    "kubectl-get-pods.log": "table",
    "kubectl-get-yaml.log": "managedfields",
    "kubectl-get-json.log": "managedfields",
    "terraform-plan.log": "terraform",
    "terraform-plan-noop.log": "terraform",
    "terraform-plan-fail.log": "terraform",
    "terraform-apply.log": "terraform",
    "terraform-apply-change.log": "terraform",
  };
  let fired = 0;
  for (const f of manifest.fixtures) {
    if (want[f.file] === undefined) continue;
    const raw = readFileSync(join(ROOT, "reference", "crush", f.file), "utf8");
    fired += (crushOutput(f.cmd, raw, f.exit).rule ?? "").split("+").includes(want[f.file]) ? 1 : 0;
  }
  put("crush.new_rules_fired_of_12", fired, "higher");
  const yaml = manifest.fixtures.find((f) => f.file === "kubectl-get-yaml.log");
  const shared = process.env.TANUKI_STASH;
  process.env.TANUKI_STASH = mkdtempSync(join(tmpdir(), "tanuki-gate-fx-"));
  const out = routeOutput(yaml.cmd, readFileSync(join(ROOT, "reference", "crush", yaml.file), "utf8"), yaml.exit, null, (id) => `fetch ${id}`);
  rmSync(process.env.TANUKI_STASH, { recursive: true, force: true });
  process.env.TANUKI_STASH = shared;
  put("crush.kubectl_yaml_chars_vs_0_22_1", out.length, "lower", { limit: 2847 });
}

/** 8c. delta: the second run of the same command in one stash. cargo test with
 *  one failure fixed and one new; npm test twice, identical modulo timings. */
function sectionDelta(ctx, put) {
  const { routeOutput } = ctx.mod.crush;
  const manifest = JSON.parse(readFileSync(join(ROOT, "reference", "crush", "manifest.json"), "utf8"));
  const shared = process.env.TANUKI_STASH;
  for (const pair of ["cargo-test", "npm-test"]) {
    const runs = manifest.fixtures.filter((f) => f.pair === pair).sort((a, b) => a.run - b.run);
    process.env.TANUKI_STASH = mkdtempSync(join(tmpdir(), "tanuki-gate-fx-"));
    const outs = runs.map((f) => routeOutput(f.cmd, readFileSync(join(ROOT, "reference", "crush", f.file), "utf8"), f.exit, null, (id) => `fetch ${id}`, "/gate"));
    rmSync(process.env.TANUKI_STASH, { recursive: true, force: true });
    put(`delta.${pair}.second_run_chars`, outs[1].length, "lower");
    put(`delta.${pair}.second_run_tokens_o200k`, ctx.tok(outs[1]), "lower");
    put(`delta.${pair}.led_by_delta`, outs[1].split("\n")[1].startsWith("[tanuki delta] vs previous run") ? 1 : 0, "higher");
  }
  process.env.TANUKI_STASH = shared;
}

/** 8d. proxy 0.23: memoised minify (warm call as a percent of the cold one),
 *  byte-exact splicing (the rewritten request is the client's bytes with ONE
 *  string literal replaced), and the automatic cache breakpoint schedule. */
function sectionProxyBytes(ctx, put) {
  const { transformRequestBody, PROXY_DEFAULTS, newSession } = ctx.mod.proxy;
  const cfg = { ...PROXY_DEFAULTS, port: 0, upstream: "http://127.0.0.1:1" };
  // memo: 200 messages x ~28 KB pretty JSON; imaging and auto breakpoint off so
  // it measures minify + bookkeeping. Median of 3 fresh sessions, warm = best of 3.
  const doc = (n) => JSON.stringify({ items: Array.from({ length: 350 }, (_, i) => ({ id: `n${n}-${i}`, name: `row ${i}`, note: "keep  these\tspaces", tags: ["a", "b"] })) }, null, 2);
  const raw = JSON.stringify({ model: "claude-sonnet-4", messages: Array.from({ length: 200 }, (_, n) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: doc(n) }] })) });
  const mcfg = { ...cfg, minChars: 1e9, autoCache: false };
  const pcts = [];
  let identical = 1;
  for (let a = 0; a < 3; a++) {
    const s = newSession();
    let t = performance.now();
    const first = transformRequestBody(raw, mcfg, s);
    const t1 = performance.now() - t;
    let t2 = Infinity;
    for (let k = 0; k < 3; k++) {
      t = performance.now();
      const second = transformRequestBody(raw, mcfg, s);
      t2 = Math.min(t2, performance.now() - t);
      if (second?.body !== first?.body) identical = 0;
    }
    pcts.push((100 * t2) / t1);
  }
  put("proxy.memo_warm_pct_of_cold", Math.round(pcts.sort((x, y) => x - y)[1]), "lower-speed", { limit: 35 });
  put("proxy.memo_warm_same_bytes", identical, "higher");
  // splice: odd key order, spaces after colons, a 20-digit id, 1.50, an escaped
  // slash; exactly one literal (the pretty tool_result) may change
  const pretty = ctx.pretty;
  const literal = JSON.stringify(pretty);
  const before = `{ "max_tokens" : 1.50 , "tools":[{"name":"t","input_schema":{"n":12345678901234567890}}],\n "messages" : [ {"role":"user","content":"a\\/b"} , {"role":"user","content":[{"content":${literal},"type":"tool_result","tool_use_id":"t1"}]} , {"role":"user","content":"tail"} ], "model":"m" }`;
  const min = ctx.mod.serde.minifyJson(pretty);
  const r = transformRequestBody(before, { ...cfg, minChars: 1e9, autoCache: false });
  put("proxy.splice_bytes_exact", min !== null && r?.body === before.replace(literal, JSON.stringify(min)) ? 1 : 0, "higher");
  // auto breakpoint: none on requests 1-2, exactly one on request 3, none when the client placed its own
  const msg = (role, content) => ({ role, content });
  const conv = (n, first = "q0") => JSON.stringify({ model: "claude-sonnet-4", messages: [msg("user", first), msg("assistant", "a0"), msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2")].slice(0, n) });
  const count = (body) => body.split("cache_control").length - 1;
  const run = (first) => {
    const s = newSession();
    return [1, 3, 5].map((n) => count(transformRequestBody(conv(n, first), cfg, s)?.body ?? conv(n, first)));
  };
  const plain = run("q0");
  const client = run([{ type: "text", text: "q0", cache_control: { type: "ephemeral" } }]);
  put("proxy.auto_cache_schedule_ok", plain.join() === "0,0,1" && client.join() === "1,1,1" ? 1 : 0, "higher");
}

/** 8. estimator drift: how far src/serde.ts textTokens is from o200k on the
 *  committed real payloads (every crush fixture, raw and routed) and on the
 *  seeded JSON document. Runs after sectionCrush and sectionJson. The
 *  estimator is fitted, so drift is nonzero by design; the gate only keeps it
 *  from getting worse. */
function sectionEstimator(ctx, put) {
  const { textTokens } = ctx.mod.serde;
  put("estimator.drift_pct", driftPct(ctx.payloads.map((t) => [textTokens(t), ctx.tok(t)])), "lower");
  put("estimator.json_drift_pct", driftPct(ctx.jsonPair.map((t) => [textTokens(t), ctx.tok(t)])), "lower");
}

/** 9. speed, relative to a fixed workload in this process; best of 5 */
function sectionSpeed(ctx, put) {
  const { distillLog } = ctx.mod.distill;
  const { stashText, fetchSlice } = ctx.mod.stash;
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
}

// Order matters only where a section reads what an earlier one left in ctx:
// sectionEstimator needs sectionCrush + sectionJson; speed stays last so the
// other sections' allocations are not billed to it.
const SECTIONS = [sectionCrush, sectionDistill, sectionIds, sectionFind, sectionJson, sectionProxy, sectionImaging, sectionVocabGap, sectionCrushRules, sectionDelta, sectionProxyBytes, sectionEstimator, sectionSpeed];

async function measure() {
  const stash = mkdtempSync(join(tmpdir(), "tanuki-gate-"));
  process.env.TANUKI_STASH = stash;
  const mod = {
    crush: await import("../src/crush.ts"),
    distill: await import("../src/distill.ts"),
    stash: await import("../src/stash.ts"),
    needles: await import("../src/needles.ts"),
    serde: await import("../src/serde.ts"),
    proxy: await import("../src/proxy.ts"),
    main: await import("../src/main.ts"),
  };
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
  const ctx = { mod, tok: await o200kCounter(), ops: opsCorpus(), doc, pretty: JSON.stringify(doc, null, 2), payloads: [], jsonPair: [] };
  const m = {};
  const put = (key, value, better, extra = {}) => (m[key] = { value, better, ...extra });
  for (const section of SECTIONS) section(ctx, put);
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
