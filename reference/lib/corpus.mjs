// The synthetic corpora, in one place.
//
// There are genuinely THREE fixtures here, not one duplicated three ways, and
// collapsing them further would be false DRY - they answer different questions:
//
//   opsCorpus()            1200 lines, fixed seed, three planted answers
//                          (dominant error unit / pinned version / request id).
//                          Used by the end-to-end agent harnesses.
//   taskCorpus(seed)        120 lines, one planted FATAL root cause.
//                          Used by comprehension and tier sweeps.
//   needleCorpus(r, needles) 80 lines with caller-supplied exact strings
//                          planted in realistic carrier lines. Used by
//                          read-back measurement.
//
// What WAS duplicated is `lcg`, `hex` and the unit vocabulary; those now come
// from ./rand.mjs. Bodies below are the historical ones verbatim, so every
// existing report still produces byte-identical output.

import { hex, lcg, UNITS } from "./rand.mjs";

/**
 * 1200-line operations log with three planted, checkable answers.
 * `ingest` dominates the ERROR lines by construction.
 */
export function opsCorpus() {
  const r = lcg(41);
  const lines = [];
  for (let i = 0; i < 1200; i++) {
    const ts = `2026-07-27T${String(8 + ((i / 300) | 0)).padStart(2, "0")}:${String((i / 5) % 60 | 0).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = UNITS[(r() * UNITS.length) | 0];
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

const COMPS = ["frame-allocator", "wal-compactor", "shard-router", "quota-reaper", "vclock-merger", "bloom-indexer", "lease-broker", "chunk-scrubber"];
const REASONS = ["disk write failed errno=ENOSPC", "deadlock acquiring lease table", "checksum mismatch on replay", "heap arena corruption detected", "fd table exhausted"];

/** 120-line log with one planted FATAL root cause; `token` is the answer. */
export function taskCorpus(seed) {
  const r = lcg(seed);
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const ts = `2026-07-27T09:${String(10 + ((i / 6) | 0)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = UNITS[(r() * UNITS.length) | 0];
    if (r() < 0.06) lines.push(`${ts} ${u} WARN retry status=502 backoff=${1 + ((r() * 8) | 0)}s conn=${(r() * 9) | 0}`);
    else lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
  }
  const comp = COMPS[(r() * COMPS.length) | 0];
  const reason = REASONS[(r() * REASONS.length) | 0];
  const at = 8 + ((r() * 100) | 0);
  const line = 100 + ((r() * 900) | 0);
  lines.splice(at, 0, `2026-07-27T09:30:00Z relay FATAL panic: ${reason} component=${comp}#${hex(r, 6)} at lib/relay/${comp}.rs:${line}`);
  return { text: lines.join("\n") + "\n", token: comp };
}

const CARRIERS = [
  (n) => `ERROR request failed session=${n}`,
  (n) => `ERROR request failed session=${n}`,
  (n) => `WARN rollback: pinned to ${n} after failed canary`,
  (n) => `INFO upgraded runtime to ${n}`,
  (n) => `ERROR upstream 502 request-id=${n}`,
  (n) => `WARN retry exhausted request-id=${n}`,
  (n) => `INFO image digest ${n} verified`,
  (n) => `ERROR digest mismatch, expected ${n}`,
  (n) => `    at handler (${n})`,
  (n) => `    at flush (${n})`,
  (n) => `INFO issued session token=${n}`,
  (n) => `DEBUG auth: bearer ${n} accepted`,
  (n) => `WARN slow span start=${n} over budget`,
  (n) => `INFO checkpoint written at ${n}`,
];

/** 80 filler lines with `needles` planted in realistic carrier lines. */
export function needleCorpus(r, needles) {
  const lines = [];
  for (let i = 0; i < 80; i++) {
    const ts = `2026-07-27T09:${String(10 + ((i / 4) | 0)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = UNITS[(r() * UNITS.length) | 0];
    lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
  }
  const r2 = lcg(101);
  needles.forEach((n, i) => {
    const at = 4 + ((r2() * 72) | 0);
    lines.splice(at, 0, `2026-07-27T09:30:00Z relay ${CARRIERS[i](n.value)}`);
  });
  return lines.join("\n") + "\n";
}

/**
 * Vocabulary-gap set for `find`: 24 plain-language asks, each with ONE gold line
 * in a 600-line noisy log. No ask word is a whole word of its gold line (and no
 * ask word of 4+ letters is a substring of it); the gold shares only a synonym
 * (15 asks, one per synonym group, so two golds never tie on one group) or a
 * word stem (9 asks) with the ask. The noise repeats common ask words
 * (service, server, request, database, process, retry) on purpose: a
 * surface-word search is drawn to those lines.
 */
export const VOCAB_GAP = [
  ["why did the service crash", "FATAL panic: invariant violated in shard-router"],
  ["which request was slow", "WARN handler exceeded deadline after 30000ms path=/v1/export"],
  ["login attempt for the invoicing user", "WARN 401 unauthorized principal=svc-billing"],
  ["disk problem on the node", "ERROR volume full /dev/nvme0n1p2 97%"],
  ["network problem reaching the database", "ERROR dns lookup db-primary.internal:5432 returned servfail"],
  ["when did the server start", "INFO listening on 0.0.0.0:8443 after cold boot"],
  ["who stops the scheduler", "INFO sigterm received, draining pid=812"],
  ["memory usage grew overnight", "WARN heap at 94% of cap, gc pause=800ms"],
  ["what is missing from the store", "ERROR 404 bucket=assets key=logo.svg"],
  ["bad configuration value", "ERROR invalid setting retention_days=-3"],
  ["rate limiting kicked in", "WARN throttle engaged bucket drained 429"],
  ["which release is live", "INFO rollout 7/7 complete version=4.2.0"],
  ["corrupted data on replay", "ERROR checksum mismatch segment=0007"],
  ["permission problem on the cron task", "ERROR eacces opening /etc/schedule.lock"],
  ["frequent timeouts from peers", "WARN timed out waiting on 10.0.4.2:8443"],
  ["retrying uploads", "WARN retry 3/5 upload chunk=88"],
  ["compacting segments", "INFO compacted segment ids=3..9 in 41ms"],
  ["indexing documents", "INFO indexed 4210 document batches"],
  ["deleting snapshots", "INFO deleted snapshot snap-0043"],
  ["restarting collectors", "INFO restart collector pid=4411"],
  ["closing streams", "INFO closed stream id=41"],
  ["rotating certificates", "INFO rotated certificate serial=7f"],
  ["scheduling jobs", "INFO scheduled job 88"],
  ["validating payloads", "INFO validated payload size=8kb"],
];

const NOISE = [
  (n) => `INFO request served path=/v1/items/${n} status=200 latency=${n % 41}ms`,
  (n) => `INFO worker heartbeat ok pool=${n % 9}`,
  (n) => `DEBUG cache hit key=k${n}`,
  (n) => `WARN retry status=502 backoff=${1 + (n % 8)}s`,
  (n) => `ERROR request failed status=502 peer=10.0.${n % 9}.${n % 200}`,
  (n) => `INFO service health check ok tick=${n}`,
  (n) => `INFO database pool size=${n % 32}`,
  (n) => `INFO server accepted connection id=${n}`,
  (n) => `INFO user session refreshed sid=${n}`,
  (n) => `INFO process tick scheduler lag=${n % 7}ms`,
];

/** 600 noise lines with the 24 gold lines spliced in at seeded positions. */
export function vocabGapCorpus() {
  const r = lcg(2718);
  const lines = Array.from({ length: 600 }, (_, i) => {
    const ts = `2026-07-27T10:${String((i / 10) % 60 | 0).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    return `${ts} ${UNITS[(r() * UNITS.length) | 0]} ${NOISE[(r() * NOISE.length) | 0]((r() * 1000) | 0)}`;
  });
  const golds = VOCAB_GAP.map(([, g], i) => `2026-07-27T11:00:${String(i).padStart(2, "0")}Z relay ${g}`);
  // spread by stride so no two golds share a +-2 window; 600/24 = 25 lines apart
  golds.forEach((g, i) => lines.splice(i * 25 + 3 + i + ((r() * 15) | 0), 0, g));
  return { text: lines.join("\n") + "\n", asks: VOCAB_GAP.map(([ask], i) => ({ ask, gold: golds[i] })) };
}
