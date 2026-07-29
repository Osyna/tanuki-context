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
