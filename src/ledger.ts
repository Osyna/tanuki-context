//! Net-savings ledger: what a crushed/stashed output saved, and what the model
//! then paid to get it back. Compression raises reacquisition calls (arXiv
//! 2608.16370), so a saving that ignores the fetches it causes is not a saving.
//!
//! One append-only TSV next to the stash (`ledger.tsv`), two row kinds:
//!   s <id> <rule> <savedTokens>   a run/stash handed out with a pointer or map
//!   f <id> <tokens>               a fetch/find paid to read it back
//! `rule` is the crush rule ("distill" when none fired, "stash" for a manual
//! tanuki_stash). A fetch belongs to the LATEST `s` row of its id. Capped: past
//! LEDGER_MAX the older half of the rows goes. Every write is best-effort - a
//! ledger must never fail a command. Mirrored in ledger.rs; the summary is
//! parity-locked byte-for-byte.
//!
//! There is deliberately no back-off that stops crushing a command whose
//! outputs get fetched back: measured live (EVALS §20) it cost more than it
//! saved - showing an output whole costs ~10x what the fetches it prevents do.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cmpCodepoints } from "./serde.ts";
import { stashDir } from "./stash.ts";

const LEDGER_MAX = 256 * 1024;

export function ledgerPath(): string {
  return `${stashDir()}/ledger.tsv`;
}

function append(line: string): void {
  try {
    const p = ledgerPath();
    mkdirSync(stashDir(), { recursive: true, mode: 0o700 });
    appendFileSync(p, line + "\n", { mode: 0o600 });
    if (statSync(p).size <= LEDGER_MAX) return;
    // Over the cap: keep the newer half. The kept rows go to a temp file of our own and are
    // renamed over the ledger, so a reader never sees a half-written file and two writers
    // never share a temp; the size is re-read first so a writer that lost the race to
    // another trim does not trim a second time. A row appended between the read and the
    // rename is lost - a cap trim is rare (every ~128 KiB) and a ledger row is an estimate.
    const ls = readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
    if (Buffer.byteLength(ls.join("\n")) <= LEDGER_MAX) return;
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, ls.slice(ls.length >> 1).join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    /* unwritable stash: no accounting, the command itself is unaffected */
  }
}

/** A stash was handed to the model (pointer or map) in place of `saved` tokens. */
export function logStash(id: string, rule: string, saved: number): void {
  append(`s\t${id}\t${rule}\t${Math.trunc(saved)}`);
}

/** The model paid `tokens` to read a slice of stash `id` back. */
export function logFetch(id: string, tokens: number): void {
  if (/^[0-9a-f]{12}$/.test(id)) append(`f\t${id}\t${Math.trunc(tokens)}`);
}

interface Net {
  stashes: number;
  savedTokens: number;
  fetches: number;
  fetchedTokens: number;
  netTokens: number;
}
const zero = (): Net => ({ stashes: 0, savedTokens: 0, fetches: 0, fetchedTokens: 0, netTokens: 0 });

/** Saved minus fetched-back tokens, per rule and in total; null with no rows. */
export function stashNet(): Record<string, unknown> | null {
  let rows: string[][];
  try {
    rows = readFileSync(ledgerPath(), "utf8").split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const rules = new Map<string, Net>();
  const of = (rule: string): Net => {
    let n = rules.get(rule);
    if (n === undefined) rules.set(rule, (n = zero()));
    return n;
  };
  const ruleOf = new Map<string, string>(); // id -> rule of its latest `s` row
  for (const r of rows) {
    if (r[0] === "s") {
      ruleOf.set(r[1], r[2]);
      const n = of(r[2]);
      n.stashes++;
      n.savedTokens += Number(r[3]) || 0;
    } else if (r[0] === "f") {
      const n = of(ruleOf.get(r[1]) ?? "untracked");
      n.fetches++;
      n.fetchedTokens += Number(r[2]) || 0;
    }
  }
  const total = zero();
  const out: Record<string, Net> = {};
  for (const name of [...rules.keys()].sort(cmpCodepoints)) {
    const n = rules.get(name)!;
    n.netTokens = n.savedTokens - n.fetchedTokens;
    out[name] = n;
    for (const k of Object.keys(total) as (keyof Net)[]) total[k] += n[k];
  }
  return { rules: out, total };
}
