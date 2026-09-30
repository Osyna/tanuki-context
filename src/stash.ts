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
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { distillLog } from "./distill.ts";
import { redactCredentials } from "./needles.ts";
import { cmpCodepoints, isRustWhitespace, rnd, rustTrim, truncateChars } from "./serde.ts";

/// 2^53-1: the largest integer JS holds exactly. Both engines saturate a line
/// bound here so an absurd end bound means "to the end" identically, instead
/// of TS rounding and Rust overflowing into an error.
const MAX_LINE = 9007199254740991;

/// `find` ranks lines by BM25: a word that is on every line (`error`, `the`)
/// weighs almost nothing, a rare one decides. k1 caps how much a repeated word
/// counts, b how much a long line is discounted. Flat per-word points let
/// common words drown the one that mattered: on a real 6,000-line journal with
/// plain-language asks, the right line came first 11 times in 200 flat, 25 with
/// BM25 (and 0 vs 10 for a one-common-word ask); pure rare-word asks tied.
const FIND_K1 = 1.2;
const FIND_B = 0.75;
const FIND_MAX_WORDS = 16;

function isWordUnit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/// Rust `str::split_whitespace`: runs between Unicode whitespace.
function rustWords(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const ws = i === s.length || isRustWhitespace(s.charCodeAt(i));
    if (ws && start !== -1) {
      out.push(s.slice(start, i));
      start = -1;
    } else if (!ws && start === -1) {
      start = i;
    }
  }
  return out;
}

/// Term frequency of `word` in a lowercased line: whole-word hits count one
/// each; a line holding it only inside a longer word (`error_code` for
/// `error`) counts 1/3 - the old 3:1 whole-word preference, kept as a frequency.
function termFreq(lower: string, word: string): number {
  let full = 0;
  let any = false;
  for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
    any = true;
    const end = at + word.length;
    if ((at === 0 || !isWordUnit(lower.charCodeAt(at - 1))) && (end >= lower.length || !isWordUnit(lower.charCodeAt(end)))) full++;
  }
  return full > 0 ? full : any ? 1 / 3 : 0;
}

/// Vocabulary gaps: "root cause of the crash" shares no word with `FATAL panic`.
/// A small fixed table of log vocabulary (symmetric groups, matched on stems)
/// plus light stemming lets an ask word also hit a synonym or an inflection of
/// itself. Such a hit counts at half a direct hit's score, with tf pinned to 1
/// and only when the line has no direct hit for that word, so an expansion can
/// tie a direct hit at best, never add onto one. Extend from real logs; keep it small.
const SYN_GROUPS: string[][] = [
  ["crash", "panic", "fatal", "abort", "segfault", "sigsegv", "sigabrt", "oom", "killed"],
  ["slow", "latency", "timeout", "timed", "deadline", "delay", "stall", "hang"],
  ["fail", "failure", "error", "err", "exception", "fault"],
  ["auth", "authentication", "authorization", "token", "bearer", "unauthorized", "forbidden", "401", "403", "credential", "login"],
  ["permission", "denied", "eacces", "forbidden", "403"],
  ["disk", "space", "enospc", "full", "storage"],
  ["net", "network", "connection", "refused", "reset", "unreachable", "dns", "socket", "econnrefused"],
  ["start", "boot", "init", "listening", "ready", "launch", "startup"],
  ["stop", "shutdown", "exit", "terminated", "sigterm", "halt"],
  ["memory", "heap", "oom", "leak", "alloc"],
  ["missing", "absent", "notfound", "404", "enoent"],
  ["deploy", "rollout", "release", "upgrade"],
  ["corrupt", "corruption", "mismatch", "invalid", "malformed"],
  ["limit", "quota", "throttle", "ratelimit", "429"],
  ["config", "configuration", "setting"],
];

/// Light suffix strip on an ASCII word: plural first (-es after s/x/z/ch/sh, else
/// -s but not -ss), then one of -ing/-ed/-er; a stem never drops under 3 chars.
function stem(w: string): string {
  const cut = (s: string, k: number): string => (s.length - k >= 3 ? s.slice(0, s.length - k) : s);
  let s = w;
  if (/(?:s|x|z|ch|sh)es$/.test(s)) s = cut(s, 2);
  else if (s.endsWith("s") && !s.endsWith("ss")) s = cut(s, 1);
  if (s.endsWith("ing")) return cut(s, 3);
  if (s.endsWith("ed") || s.endsWith("er")) return cut(s, 2);
  return s;
}

const SYN_INDEX = new Map<string, number[]>();
SYN_GROUPS.forEach((g, gi) => {
  for (const m of g) {
    const k = stem(m);
    const at = SYN_INDEX.get(k) ?? [];
    if (!at.includes(gi)) at.push(gi);
    SYN_INDEX.set(k, at);
  }
});

/// Stems an ask word may also match: its own and its synonym groups'. null for
/// anything that is not a plain ASCII word (after trimming edge punctuation).
function variantStems(word: string): Set<string> | null {
  let a = 0;
  let b = word.length;
  while (a < b && !isWordUnit(word.charCodeAt(a))) a++;
  while (b > a && !isWordUnit(word.charCodeAt(b - 1))) b--;
  const key = word.slice(a, b);
  if (key.length === 0) return null;
  for (let i = 0; i < key.length; i++) if (!isWordUnit(key.charCodeAt(i))) return null;
  const k = stem(key);
  const set = new Set([k]);
  for (const gi of SYN_INDEX.get(k) ?? []) for (const m of SYN_GROUPS[gi]) set.add(stem(m));
  return set;
}

/// The stems of every word-unit run in a lowercased line.
function lineStems(lower: string): Set<string> {
  const out = new Set<string>();
  let s = -1;
  for (let i = 0; i <= lower.length; i++) {
    const u = i < lower.length && isWordUnit(lower.charCodeAt(i));
    if (u && s === -1) s = i;
    else if (!u && s !== -1) {
      out.add(stem(lower.slice(s, i)));
      s = -1;
    }
  }
  return out;
}

export function stashDir(): string {
  const env = process.env.TANUKI_STASH;
  if (env !== undefined && env !== "") return env;
  return `${process.env.HOME ?? ""}/.tanuki/stash`;
}

/// A stash id is content-addressed - `stashText` mints it as a 12-char
/// lowercase sha256 prefix - so anything but that shape is a traversal
/// attempt, not a typo (issue #2). Every read routes through here rather than
/// building the path itself: string concat happened to defuse absolute paths
/// in this engine, but the Rust engine joins a PathBuf, where an absolute
/// `id` replaces the stash dir outright. One chokepoint, both engines.
function stashPath(id: string): string {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error(`unknown stash id: ${id}`);
  return `${stashDir()}/${id}`;
}

/// Read-only lookup for other modules (delta): the stashed text, or null for an
/// unshaped id or a missing/unreadable file.
export function stashRead(id: string): string | null {
  try {
    return readFileSync(stashPath(id), "utf8");
  } catch {
    return null;
  }
}

export interface Stashed {
  id: string;
  overview: string;
}

/** A cleaned view of the capture the overview describes instead of the raw
 *  bytes (kubectl without managedFields); `note` names what was removed. */
export interface MapView {
  text: string;
  note: string;
}

/// The stash's own entries (12-hex files) are capped: past TANUKI_STASH_MAX_MB
/// (positive number, default 512) the oldest by mtime go until the total is
/// 75% of the cap. The entry just written survives; `runs/` and anything else
/// in the dir is not ours to delete. Any IO error is swallowed - pruning must
/// never fail a stash write. Mirror of the Rust engine.
/// ponytail: one readdir + stat per entry on every stash (~1 ms per 1,000
/// entries); amortise with a stamp file if a stash ever holds 50k+ entries.
function pruneStash(dir: string, keep: string): void {
  try {
    const raw = (process.env.TANUKI_STASH_MAX_MB ?? "").trim();
    const mb = /^\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw) ? Number(raw) : 0;
    const cap = (mb > 0 && Number.isFinite(mb) ? mb : 512) * 1048576;
    const all: { name: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const name of readdirSync(dir)) {
      if (!/^[0-9a-f]{12}$/.test(name)) continue;
      try {
        const st = statSync(`${dir}/${name}`);
        if (!st.isFile()) continue;
        all.push({ name, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch {}
    }
    if (total <= cap) return;
    all.sort((a, b) => a.mtime - b.mtime || cmpCodepoints(a.name, b.name));
    for (const e of all) {
      if (total <= cap * 0.75) break;
      if (e.name === keep) continue;
      try {
        unlinkSync(`${dir}/${e.name}`);
        total -= e.size;
      } catch {}
    }
  } catch {}
}

export function stashText(text: string, view?: MapView): Stashed {
  const id = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  const dir = stashDir();
  // The stash deliberately holds unredacted bytes, so it is owner-only
  // rather than whatever umask says (0755/0644 by default).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/${id}`, text, { mode: 0o600 });
  pruneStash(dir, id);

  const bytes = Buffer.byteLength(text, "utf8");
  const segments = text.split("\n");
  const mapText = view?.text ?? text;
  const mapSegs = view === undefined ? segments : mapText.split("\n");
  const stats = distillLog(mapText, null, 2).stats as {
    origLines: number;
    outLines: number;
    savedPct: number;
    importantKept: number;
    topRepeats: { count: number; exemplar: string; kind: string }[];
  };

  const lines: string[] = [
    `stashed ${id} · ${bytes} bytes · ${segments.length} lines`,
    `distill map${view === undefined ? "" : ` (${view.note})`}: ${stats.origLines} -> ${stats.outLines} lines · ${stats.savedPct}% of chars removable · ${stats.importantKept} error/warn lines`,
  ];
  if (stats.topRepeats.length > 0) {
    lines.push("top repeats:");
    for (const r of stats.topRepeats.slice(0, 5)) {
      const tag = r.kind === "template" ? " (template)" : "";
      lines.push(`  ×${r.count}${tag}  ${r.exemplar}`);
    }
  }
  let last = "";
  for (let i = mapSegs.length - 1; i >= 0; i--) {
    if (mapSegs[i] !== "") {
      last = mapSegs[i];
      break;
    }
  }
  lines.push(`first: ${truncateChars(rustTrim(mapSegs[0]), 160)}`);
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
    text = readFileSync(stashPath(id), "utf8");
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
    const rawWords = rustWords(find);
    if (rawWords.length === 0) throw new Error("find needs at least one word");
    const words = Array.from(new Set(rawWords.map((w) => w.toLowerCase()))).slice(0, FIND_MAX_WORDS);
    const segments = text.split("\n");
    const N = segments.length;
    const lowers = segments.map((s) => s.toLowerCase());
    const tf = words.map((w) => lowers.map((l) => termFreq(l, w)));
    const dl = segments.map((s) => rustWords(s).length);
    let total = 0;
    for (const d of dl) total += d;
    const avg = total / N;
    // variant hits: expansion-only lines (no direct hit for that word)
    const vsets = words.map(variantStems);
    // a token's stem is a prefix of the token, so a line holding none of a word's
    // stems as a substring cannot match; tokenise only the lines that pass
    const cache: (Set<string> | undefined)[] = new Array(N);
    const vh = words.map((_, j) => {
      const vs = vsets[j];
      const out = new Uint8Array(N);
      if (vs === null) return out;
      const arr = [...vs];
      const col = tf[j];
      for (let i = 0; i < N; i++) {
        const l = lowers[i];
        if (col[i] !== 0 || !arr.some((s) => l.includes(s))) continue;
        const st = (cache[i] ??= lineStems(l));
        for (const s of st) {
          if (vs.has(s)) {
            out[i] = 1;
            break;
          }
        }
      }
      return out;
    });
    const idf = tf.map((col, j) => {
      let df = col.filter((f) => f > 0).length;
      if (df === 0) for (let i = 0; i < N; i++) df += vh[j][i];
      return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    });
    // `mask`: bit 2j = word j hit directly, bit 2j+1 = hit through a synonym/stem
    interface Anchor { line: number; score: number; mask: number }
    const anchors: Anchor[] = [];
    for (let i = 0; i < N; i++) {
      let score = 0;
      let mask = 0;
      for (let j = 0; j < words.length; j++) {
        const f = tf[j][i];
        if (f > 0) {
          mask |= 1 << (2 * j);
          score += (idf[j] * (f * (FIND_K1 + 1))) / (f + FIND_K1 * (1 - FIND_B + (FIND_B * dl[i]) / avg));
        } else if (vh[j][i] !== 0) {
          mask |= 2 << (2 * j);
          score += ((idf[j] * (1 * (FIND_K1 + 1))) / (1 + FIND_K1 * (1 - FIND_B + (FIND_B * dl[i]) / avg))) * 0.5;
        }
      }
      // integer micro-points: ordering and the window max are exact, so a last-bit
      // difference between the engines' ln() cannot reorder two lines
      if (mask !== 0) anchors.push({ line: i + 1, score: rnd(score * 1e6), mask });
    }
    const termsOf = (mask: number): string =>
      words.flatMap((w, j) => ((mask >> (2 * j)) & 1 ? [w] : (mask >> (2 * j)) & 2 ? [`${w}~`] : [])).join(", ");
    const h = anchors.length;
    if (h === 0) return `·find· ${words.length} words · 0 lines matched`;
    // Top K anchors by (score desc, line asc)
    const k = Math.min(Math.max(1, top), 32);
    const topAnchors = anchors.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.line - b.line)).slice(0, k);
    // Build windows: each anchor -> [max(1,n-2), min(N,n+2)]
    interface Window { start: number; end: number; score: number; terms: string }
    const windows: Window[] = [];
    for (const anc of topAnchors) {
      const start = Math.max(1, anc.line - 2);
      const end = Math.min(N, anc.line + 2);
      windows.push({ start, end, score: anc.score, terms: termsOf(anc.mask) });
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
        if (win.score > last.score) {
          last.score = win.score;
          last.terms = win.terms;
        }
      }
    }
    // Output
    const parts: string[] = [];
    for (const win of merged) {
      parts.push(`·find· L${win.start}-${win.end} score ${(rnd(win.score / 1e5) / 10).toFixed(1)} · ${win.terms}`);
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
    text = readFileSync(stashPath(id), "utf8");
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
    text = readFileSync(stashPath(id), "utf8");
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
