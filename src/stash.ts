//! Stash mode: context-mode's shape (content parked outside the context
//! window, queried on demand) fused with tanuki's pricing (big answers come
//! back as dense pages).
//!
//! stash = write the text to a content-addressed file and pay a few hundred
//! tokens for a deterministic map of what's there (distill stats, top
//! repeats, first/last lines, the id). fetch = pull a slice by regex query
//! (distill-powered) or line range; the caller images it only when pages
//! clearly win. Contract is byte-identical with the Rust engine.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { distillLog } from "./distill.ts";
import { redactCredentials } from "./needles.ts";
import { cmpCodepoints, rustTrim, truncateChars } from "./serde.ts";

/// 2^53-1: the largest integer JS holds exactly. Both engines saturate a line
/// bound here so an absurd end bound means "to the end" identically, instead
/// of TS rounding and Rust overflowing into an error.
const MAX_LINE = 9007199254740991;

function stashDir(): string {
  const env = process.env.TANUKI_STASH;
  if (env !== undefined && env !== "") return env;
  return `${process.env.HOME ?? ""}/.tanuki/stash`;
}

export interface Stashed {
  id: string;
  overview: string;
}

export function stashText(text: string): Stashed {
  const id = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  const dir = stashDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${id}`, text);

  const bytes = Buffer.byteLength(text, "utf8");
  const segments = text.split("\n");
  const stats = distillLog(text, null, 2).stats as {
    origLines: number;
    outLines: number;
    savedPct: number;
    importantKept: number;
    topRepeats: { count: number; exemplar: string; kind: string }[];
  };

  const lines: string[] = [
    `stashed ${id} · ${bytes} bytes · ${segments.length} lines`,
    `distill map: ${stats.origLines} -> ${stats.outLines} lines · ${stats.savedPct}% of chars removable · ${stats.importantKept} error/warn lines`,
  ];
  if (stats.topRepeats.length > 0) {
    lines.push("top repeats:");
    for (const r of stats.topRepeats.slice(0, 5)) {
      const tag = r.kind === "template" ? " (template)" : "";
      lines.push(`  ×${r.count}${tag}  ${r.exemplar}`);
    }
  }
  let last = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "") {
      last = segments[i];
      break;
    }
  }
  lines.push(`first: ${truncateChars(rustTrim(segments[0]), 160)}`);
  lines.push(`last: ${truncateChars(rustTrim(last), 160)}`);
  lines.push(`fetch: tanuki_fetch {"id":"${id}","query":"<regex>"} or {"id":"${id}","lines":"a-b"}`);
  return { id, overview: lines.join("\n") };
}

/** Pull a slice of a stashed text. Throws Error with the contract message on
 *  bad input; the caller maps it to a tool error / CLI fatal. */
export function fetchSlice(
  id: string,
  query: string | null,
  lines: string | null,
  find: string | null = null,
  top = 8,
): string {
  const nonNull = [query, lines, find].filter((x) => x !== null).length;
  if (nonNull !== 1) {
    throw new Error("give exactly one of query, lines or find");
  }
  let text: string;
  try {
    text = readFileSync(`${stashDir()}/${id}`, "utf8");
  } catch {
    throw new Error(`unknown stash id: ${id}`);
  }
  if (lines !== null) {
    const m = /^(\d+)-(\d+)$/.exec(lines);
    if (m === null) throw new Error("bad lines range");
    // A bound past the end means "to the end", so saturate instead of failing
    // - but saturate at the SAME cap in both engines. Rust parses to usize and
    // errored on overflow while TS let Number() round past 2^53 and returned
    // the whole stash: one call, two answers, and the byte-parity harness only
    // ever exercised "3-40" so it saw neither.
    const bound = (s: string): number => {
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : MAX_LINE;
    };
    const A = bound(m[1]);
    const B = bound(m[2]);
    if (A > B) throw new Error("bad lines range");
    const segments = text.split("\n");
    // Clamp BOTH ends into [1, len]. Raising only the low end made "0-0" an
    // empty string here and the first line in Rust.
    const a = Math.min(Math.max(1, A), segments.length);
    const b = Math.min(Math.max(1, B), segments.length);
    return segments.slice(a - 1, b).join("\n");
  }
  if (find !== null) {
    // find mode: word-based relevance scoring
    const rawWords = find.split(/\s+/).filter((w) => w !== "");
    if (rawWords.length === 0) throw new Error("find needs at least one word");
    const words = Array.from(new Set(rawWords.map((w) => w.toLowerCase()))).slice(0, 8);
    const segments = text.split("\n");
    const N = segments.length;
    // Score each line
    interface Anchor { line: number; score: number }
    const anchors: Anchor[] = [];
    for (let i = 0; i < N; i++) {
      const raw = segments[i];
      const lower = raw.toLowerCase();
      let score = 0;
      for (const word of words) {
        // Escape regex metacharacters
        const esc = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        // ASCII word boundary check: (?<![0-9A-Za-z_])word(?![0-9A-Za-z_])
        const re = new RegExp(`(?<![0-9A-Za-z_])${esc}(?![0-9A-Za-z_])`, "i");
        if (re.test(raw)) {
          score += 3;
        } else if (lower.includes(word)) {
          score += 1;
        }
      }
      if (score > 0) anchors.push({ line: i + 1, score });
    }
    const h = anchors.length;
    if (h === 0) return `·find· ${words.length} words · 0 lines matched`;
    // Top K anchors by (score desc, line asc)
    const k = Math.min(Math.max(1, top), 32);
    const topAnchors = anchors.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.line - b.line;
    }).slice(0, k);
    // Build windows: each anchor -> [max(1,n-2), min(N,n+2)]
    interface Window { start: number; end: number; score: number }
    const windows: Window[] = [];
    for (const anc of topAnchors) {
      const start = Math.max(1, anc.line - 2);
      const end = Math.min(N, anc.line + 2);
      windows.push({ start, end, score: anc.score });
    }
    // Merge overlapping/adjacent windows
    windows.sort((a, b) => a.start - b.start);
    const merged: Window[] = [];
    for (const win of windows) {
      if (merged.length === 0 || win.start > merged[merged.length - 1].end + 1) {
        merged.push(win);
      } else {
        const last = merged[merged.length - 1];
        last.end = Math.max(last.end, win.end);
        last.score = Math.max(last.score, win.score);
      }
    }
    // Output
    const parts: string[] = [];
    for (const win of merged) {
      parts.push(`·find· L${win.start}-${win.end} score ${win.score}`);
      parts.push(segments.slice(win.start - 1, win.end).join("\n"));
    }
    parts.push(`·find· ${words.length} words · ${h} lines matched · ${merged.length} windows`);
    return parts.join("\n");
  }
  return distillLog(text, query, 2).distilled;
}

/// How many raw lines of the stash match `query`, and how many there are.
/// The distilled slice keeps context lines and collapses repeats, so its line
/// count is NOT a match count - and an agent asked which unit logged the most
/// errors needs the real one. Without this it cannot count at all: it can only
/// read slices, and slices cannot count what they do not show (EVALS §6).
export function matchCount(id: string, query: string): { matched: number; total: number } {
  let text: string;
  try {
    text = readFileSync(`${stashDir()}/${id}`, "utf8");
  } catch {
    throw new Error(`unknown stash id: ${id}`);
  }
  let re: RegExp;
  try {
    re = new RegExp(query);
  } catch {
    throw new Error(`bad query regex: ${query}`);
  }
  const segments = text.split("\n");
  let matched = 0;
  for (const line of segments) if (re.test(line)) matched += 1;
  return { matched, total: segments.length };
}

export interface VerifyResult {
  status: "exact" | "corrected" | "ambiguous" | "absent";
  line: number | null;
  found: string | null;
  candidates: string[];
}

/// ponytail: below this length a distance-1 neighborhood is mostly noise
/// (every short string is one edit from dozens of others), so short values
/// get an exact-or-absent answer only. Raise if a real value class needs it.
const MIN_FUZZY_LEN = 4;
const VERIFY_CAND_CAP = 8;

/// Disk-grounded exact check for a value read off a rendered page. No model in
/// the loop: the original bytes are already stashed, so a plausible-wrong-
/// character misread becomes an `exact` match, a unique `corrected` string, an
/// `ambiguous` shortlist, or an explicit `absent` flag - never a silent guess.
/// Parity-locked with the Rust engine (same scan order, same code-point math).
export function verifyValue(id: string, value: string): VerifyResult {
  if (value === "") throw new Error("verify needs a non-empty value");
  let text: string;
  try {
    text = readFileSync(`${stashDir()}/${id}`, "utf8");
  } catch {
    throw new Error(`unknown stash id: ${id}`);
  }

  const idx = text.indexOf(value);
  if (idx >= 0) {
    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (text[i] === "\n") line++;
    }
    return { status: "exact", line, found: value, candidates: [] };
  }

  const val = [...value];
  const n = val.length;
  if (n < MIN_FUZZY_LEN) return { status: "absent", line: null, found: null, candidates: [] };

  const cps = [...text];
  // 1-based line of every code point, one pass.
  const lineAt = new Int32Array(cps.length);
  let ln = 1;
  for (let i = 0; i < cps.length; i++) {
    lineAt[i] = ln;
    if (cps[i] === "\n") ln++;
  }

  // Distance-1 neighbourhood, same length only: one substitution (the dominant
  // dense-glyph misread 0/O, 5/S, 1/l) or one adjacent transposition (a digit
  // swap like f0->0f, observed in real read-backs). Both preserve length, so a
  // window cannot match a fragment of a longer token the way an indel would
  // (ponytail: indels would need token-boundary awareness and are not
  // fragment-safe; not worth it).
  const found = new Map<string, number>();
  if (n <= cps.length) {
    for (let off = 0; off + n <= cps.length; off++) {
      let diffs = 0;
      let a = -1;
      let b = -1;
      for (let i = 0; i < n; i++) {
        if (val[i] !== cps[off + i]) {
          diffs++;
          if (diffs === 1) a = i;
          else if (diffs === 2) b = i;
          else break;
        }
      }
      const match =
        diffs === 1 ||
        (diffs === 2 && b === a + 1 && val[a] === cps[off + b] && val[b] === cps[off + a]);
      if (match) {
        const s = cps.slice(off, off + n).join("");
        if (!found.has(s)) found.set(s, lineAt[off]);
      }
    }
  }

  if (found.size === 0) return { status: "absent", line: null, found: null, candidates: [] };
  if (found.size === 1) {
    const [s, line] = [...found][0];
    return { status: "corrected", line, found: s, candidates: [] };
  }
  const candidates = [...found.keys()].sort(cmpCodepoints).slice(0, VERIFY_CAND_CAP);
  return { status: "ambiguous", line: null, found: null, candidates };
}
