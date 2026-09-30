// Delta between runs: the second `cargo test` / `npm test` / `pytest` of the
// same command in the same directory mostly repeats the first. When the same
// normalised command ran before in this stash, say what CHANGED (new failures,
// fixed failures, changed counts, exit code) and replace the blocks that are
// identical to the previous run by a pointer. The full output is stashed by the
// caller, so nothing is lost - it is one fetch away. Mirrored in delta.rs.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rustTrim, truncateChars } from "./serde.ts";
import { stashDir, stashRead } from "./stash.ts";

/** Runs below this many chars are not worth a delta block unless the command
 *  already has a recorded run (a big failing run followed by a tiny passing
 *  one is exactly the delta worth showing). */
export const DELTA_MIN = 400;
/** A block of at least this many lines is collapsed when the previous run had it. */
const BLOCK_MIN = 3;
const ITEM_CAP = 10;
const COUNT_CAP = 5;
const ITEM_CHARS = 160;

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Same command = same argv (after leading `VAR=value` words) in the same cwd. */
export function runKey(cmd: string[], cwd: string): string {
  let i = 0;
  while (i < cmd.length - 1 && ENV_ASSIGN.test(cmd[i])) i++;
  return createHash("sha256")
    .update(`${cwd}\0${cmd.slice(i).join("\0")}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export interface PrevRun {
  id: string;
  code: number;
  /** the previous capture, exactly as stashed */
  text: string;
}

/** The last recorded run of `key`, read-only, or null (also on any IO error). */
export function previousRun(key: string): PrevRun | null {
  try {
    const m = /^([0-9a-f]{12}) (-?[0-9]+)\n?$/.exec(readFileSync(`${stashDir()}/runs/${key}`, "utf8"));
    if (m === null) return null;
    const text = stashRead(m[1]);
    return text === null ? null : { id: m[1], code: Number(m[2]), text };
  } catch {
    return null;
  }
}

/** Remember `id` (a stashed capture) as the last run of `key`. Throws on IO
 *  errors; the caller decides that a read-only stash must not fail a command. */
export function recordRun(key: string, id: string, code: number): void {
  const dir = `${stashDir()}/runs`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/${key}`, `${id} ${code}\n`, { mode: 0o600 });
}

// Tokens that differ on every run of an unchanged command: timestamps, thread
// and process ids, durations, addresses. Two lines equal after this are "the
// same line".
const TS = /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?/g;
const PID = /\([0-9]{4,}\)/g;
const DUR = /(^|[^A-Za-z0-9_.])[0-9]+(?:\.[0-9]+)?(?:ns|µs|μs|us|ms|s)([^A-Za-z0-9_]|$)/g;
const DUR_MS = /duration_ms [0-9.]+/g;
const HEX = /0x[0-9a-f]{6,}/g;

export function norm(line: string): string {
  let s = rustTrim(line).replace(TS, "<ts>").replace(PID, "(#)");
  // twice: "1s 2s" - the first match consumes the space the second one needs
  for (let i = 0; i < 2; i++) s = s.replace(DUR, (_m, a: string, b: string) => `${a}<t>${b}`);
  return s.replace(DUR_MS, "duration_ms <n>").replace(HEX, "0x#");
}

const COUNT =
  /[0-9]+ (?:passed|failed|passing|failing|pass|fail|skipped|ignored|pending|todo|cancelled|tests?|suites?|warnings?|errors?|total)(?:[^A-Za-z0-9_]|$)|(?:^|[^A-Za-z0-9_])(?:tests|suites|pass|fail|skipped|cancelled|todo|passed|failed) [0-9]+(?:[^0-9.]|$)/;
const FAIL =
  /(?:^|[^A-Za-z0-9_])(?:FAILED|FAIL|ERROR|not ok)(?:[^A-Za-z0-9_]|$)|^ *error\[[A-Za-z0-9]+\]:|error TS[0-9]+|[✖✕✗]/;

/** normalised line -> first original (trimmed), for failure lines and count lines. */
function classify(lines: string[]): { fail: Map<string, string>; count: Map<string, string> } {
  const fail = new Map<string, string>();
  const count = new Map<string, string>();
  for (const l of lines) {
    const n = norm(l);
    if (n === "") continue;
    const into = COUNT.test(n) ? count : FAIL.test(n) ? fail : null;
    if (into !== null && !into.has(n)) into.set(n, rustTrim(l));
  }
  return { fail, count };
}

function diffList(label: string, items: string[], cap: number): string[] {
  const out = items.slice(0, cap).map((s) => `${label}: ${truncateChars(s, ITEM_CHARS)}`);
  if (items.length > cap) out.push(`${label}: ... ${items.length - cap} more`);
  return out;
}

export interface Delta {
  /** lines that lead the routed output */
  head: string[];
  /** the current crushed text with identical blocks replaced by pointers */
  body: string;
  /** true when any block or the whole output was replaced by a pointer */
  collapsed: boolean;
}

/**
 * Compare this run with the previous one. `prev.text` and `cur.text` are the
 * CRUSHED outputs (noise already gone from both); `prev.lines` is the line
 * count of the previous raw capture, the number the pointer quotes.
 */
export function diffRuns(
  prev: { id: string; code: number; text: string; lines: number },
  cur: { text: string; code: number },
): Delta {
  const pl = prev.text.split("\n");
  const cl = cur.text.split("\n");
  const exit = prev.code === cur.code ? `exit ${cur.code} (same)` : `exit ${prev.code} -> ${cur.code}`;
  const at = `[tanuki delta] vs previous run ${prev.id} · ${exit}`;
  const pn = pl.map(norm).sort();
  const cn = cl.map(norm).sort();
  if (pn.length === cn.length && pn.every((x, i) => x === cn[i])) {
    return {
      head: [`${at} · output identical`],
      body: `(same as previous run: ${prev.lines} lines, fetch id ${prev.id})`,
      collapsed: true,
    };
  }
  const p = classify(pl);
  const c = classify(cl);
  const gone = (a: Map<string, string>, b: Map<string, string>) => [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
  const fixed = gone(p.fail, c.fail);
  const fresh = gone(c.fail, p.fail);
  const head = [
    `${at} · ${fixed.length} fixed · ${fresh.length} new`,
    ...diffList("fixed", fixed, ITEM_CAP),
    ...diffList("new", fresh, ITEM_CAP),
    ...diffList("was", gone(p.count, c.count), COUNT_CAP),
    ...diffList("now", gone(c.count, p.count), COUNT_CAP),
  ];

  // Blocks (runs of non-blank lines) of >= BLOCK_MIN lines that the previous
  // run had too, compared as sets of normalised lines: parallel test runners
  // print the same lines in a different order.
  const key = (b: string[]) => b.map(norm).sort().join("\n");
  const blocks = (ls: string[]): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < ls.length; ) {
      if (rustTrim(ls[i]) === "") {
        i++;
        continue;
      }
      let j = i;
      while (j < ls.length && rustTrim(ls[j]) !== "") j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  };
  const seen = new Set<string>();
  for (const [a, b] of blocks(pl)) if (b - a >= BLOCK_MIN) seen.add(key(pl.slice(a, b)));
  const body: string[] = [];
  let at2 = 0;
  let collapsed = false;
  for (const [a, b] of blocks(cl)) {
    body.push(...cl.slice(at2, a));
    if (b - a >= BLOCK_MIN && seen.has(key(cl.slice(a, b)))) {
      body.push(`(same as previous run: ${b - a} lines, fetch id ${prev.id})`);
      collapsed = true;
    } else {
      body.push(...cl.slice(a, b));
    }
    at2 = b;
  }
  body.push(...cl.slice(at2));
  return { head, body: body.join("\n"), collapsed };
}
