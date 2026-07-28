//! Verbatim sidecar: the fidelity answer to the needle read-back test.
//!
//! Model read-back of dense random strings from pixels fails silently (a
//! plausible wrong character, no error - Table D in the README measures
//! 5/10 at normal density, 3/10 tiny). So the strings a reader would grep
//! for - UUIDs, digests, long hex ids, 0x addresses, IPs, versions - are
//! scanned out of the exact text the pages will carry and shipped as TEXT
//! next to the image blocks. Pixels carry the bulk, text carries the
//! needles, and exactness never depends on transcription.
//!
//! Deterministic and engine-parity-locked: same patterns, same priority
//! order, same overlap/dedupe/cap rules as the Rust port. No lookarounds
//! (Rust `regex` has none). Scanned on the post-pipeline text so line
//! numbers match the rendered pages, and codebook ·legend· lines are
//! scanned too - a sigil's expansion is otherwise pixel-only.
//!
//! ponytail: the list is budgeted, not counted - the sidecar may grow until
//! its text costs a quarter of the raw text it protects. Overflow sets
//! `dense`, and `route` refuses to image a dense block: a capped sidecar
//! stays cheap while dropping the very ids it exists to carry, so the cost
//! math alone can never catch that.

import { charCount, textTokens } from "./serde.ts";

export interface Needle {
  line: number; // 1-based line in the text the pages carry
  value: string;
}

export interface Sidecar {
  needles: Needle[]; // first occurrence per distinct value, within budget
  more: number; // distinct values that did not fit
  dense: boolean; // more > 0: too many exact strings to carry - keep as text
  text: string; // "" when no needles: the block to ship as text
  tokens: number; // textTokens(text)
}

/// The sidecar exists to protect the compression win, so it must not erase
/// it. Budget its text at half the RAW characters it is an alternative to:
/// under that, carry every exact string; over it, the sidecar approaches the
/// size of just shipping the text, so stop and set `dense` — `route` then
/// refuses to image, because a budgeted sidecar stays cheap while dropping
/// the very ids it exists to carry and the cost math cannot see that.
///
/// The baseline is RAW, not the compressed text handed to the scanner: a
/// codebook/tiny run shrinks the compressed text while the legend still
/// carries the ids, and budgeting against it would refuse exactly the content
/// compressing best.
export const SIDECAR_SHARE = 2;
export const SIDECAR_MIN_CHARS = 256; // small blocks still get their needles

export function sidecarBudget(rawChars: number): number {
  const b = Math.floor(rawChars / SIDECAR_SHARE);
  return b < SIDECAR_MIN_CHARS ? SIDECAR_MIN_CHARS : b;
}

/// Priority-ordered: earlier patterns claim their span, later ones cannot
/// overlap it (a UUID's tail is not also a hex run; 1.2.3.4 is an IP, not
/// a semver prefix).
const PATTERNS: readonly RegExp[] = [
  // uuid
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  // prefixed digest (sha256:..., md5:..., blake3:...)
  /\b(?:sha1|sha256|sha384|sha512|md5|blake2b|blake2s|blake3):[0-9a-fA-F]{8,128}/g,
  // 0x address / hash
  /\b0x[0-9a-fA-F]{8,64}\b/g,
  // stack frame path:line:col (needs a / or . in the path, so 09:30:00 stays a timestamp)
  /[A-Za-z0-9_./-]*[/.][A-Za-z0-9_.-]*:\d+:\d+/g,
  // bare hex run (request ids, short shas >= 12)
  /\b[0-9a-fA-F]{12,64}\b/g,
  // ipv4, optional :port
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
  // version, optional prerelease (1.15.8-rc.3)
  /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g,
];

// ------------------------------------------------- recoverability classifier
// The allowlist above answers "is this a KNOWN id format?". That question has
// an unbounded complement: measured on 19.7 MB of real logs it fully carried
// only 30.9% of unrecoverable identifiers, missing pod names, MACs, base64
// blobs and git short shas (EVALS §7, `npm run coverage`). So we also ask the
// answerable question - "would a one-character misread of this token be
// silent AND unrecoverable?" - and ship everything not provably recoverable.
// The recoverable set is small and enumerable; the id-format set is not.
//
// Bias is to recall: a false positive costs a few sidecar tokens and is never
// wrong, a false negative is a silently corrupted id.

/// Recoverable from sequence or format - a misread either breaks the shape
/// visibly or is reconstructible from context. Never sidecar'd. Words are
/// deliberately NOT here: `^[A-Za-z]+$` would also wave through every random
/// alphabetic id (0/60 caught, EVALS §7). The segment scan below separates a
/// word from a random letter run by structure instead.
const RECOVERABLE: readonly RegExp[] = [
  /^[0-9]+(?:\.[0-9]+)?(?:ns|us|ms|s|m|h|d|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|%)$/, // measures
  /^(?:[0-9]+h)?(?:[0-9]+m)?[0-9]+(?:\.[0-9]+)?s$/, // durations (1h30m0s)
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[0-9A-Za-z:.+-]*$/, // ISO date/time
  /^[0-9]{2}:[0-9]{2}:[0-9]{2}[0-9.,]*$/, // clock
  /^[vV]?[0-9]+(?:[._][0-9]+)+$/, // version
];
const RE_MAC = /^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;
const RE_HEXGROUP = /^(?:[0-9a-fA-F]{4,}[:-])+[0-9a-fA-F]{4,}$/; // PCI/USB id, uuid
const RE_B64 = /^[A-Za-z0-9+\/]{16,}={0,2}$/;

/// True when losing one character of `v` would be both silent and unfixable.
export function atRisk(v: string): boolean {
  const n = v.length;
  if (n < 6) return false;
  let digits = 0;
  let lower = false;
  let upper = false;
  let hexish = true;
  let flips = 0;
  let prev = false;
  for (let k = 0; k < n; k++) {
    const c = v.charCodeAt(k);
    const d = c >= 48 && c <= 57;
    if (d) digits++;
    else if (c >= 97 && c <= 122) lower = true;
    else if (c >= 65 && c <= 90) upper = true;
    if (!(d || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) hexish = false;
    if (k > 0 && d !== prev) flips++;
    prev = d;
  }
  if (digits === n) return n >= 9; // small ints recover from context, long ids do not
  if (hexish) return true; // hex run >= 6: git short sha, request id
  for (const p of RECOVERABLE) if (p.test(v)) return false;
  if (RE_MAC.test(v) || RE_HEXGROUP.test(v)) return true;
  if (digits > 0 && upper && lower && RE_B64.test(v)) return true;
  // Segment scan. Two shapes no format rule can name: a long alnum run mixing
  // letters and digits (pod, build, container ids), and a long alphabetic run
  // that is not a word. Words alternate vowels and consonants; random letters
  // pile up. Random alphabetic ids are invisible to every shape rule - the
  // adversarial harness caught 0/60 of them before this (EVALS §7).
  let s = 0;
  while (s < n) {
    while (s < n) {
      const c = v.charCodeAt(s);
      if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)) break;
      s++;
    }
    let e = s;
    let segDigits = 0;
    let segAlpha = 0;
    let vowels = 0;
    let run = 0;
    let maxRun = 0;
    while (e < n) {
      const c = v.charCodeAt(e);
      const isD = c >= 48 && c <= 57;
      if (!isD && !((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) break;
      if (isD) segDigits++;
      else {
        segAlpha++;
        const f = c | 32;
        if (f === 97 || f === 101 || f === 105 || f === 111 || f === 117 || f === 121) {
          vowels++;
          run = 0;
        } else if (++run > maxRun) maxRun = run;
      }
      e++;
    }
    const len = e - s;
    if (len >= 8 && segDigits > 0 && segAlpha > 0) return true;
    if (len >= 8 && segDigits === 0 && (maxRun >= 5 || vowels * 100 < len * 15)) return true;
    s = e;
  }
  // generic, no named format: interleaved alnum - pod, build, container ids
  return n >= 10 && digits > 0 && (upper || lower) && flips >= 3;
}

/// At-risk whole-token spans in `line`, left to right. Whitespace-delimited,
/// `key=value` reduced to the value, wrapping punctuation trimmed.
function riskyTokens(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && line[j] !== " " && line[j] !== "\t") j++;
    let eq = -1;
    for (let k = i; k < j; k++) if (line[k] === "=") eq = k;
    let s = eq > i && j - (eq + 1) >= 6 ? eq + 1 : i;
    let e = j;
    while (s < e) {
      const c = line.charCodeAt(s);
      if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)) break;
      s++;
    }
    while (e > s) {
      const c = line.charCodeAt(e - 1);
      // `=` `+` `/` survive the trailing trim so base64 padding stays intact
      const keep = (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 61 || c === 43 || c === 47;
      if (keep) break;
      e--;
    }
    // length is checked inside atRisk (in characters) so the Rust port, which
    // scans byte offsets, agrees on non-ASCII lines
    if (e > s && atRisk(line.slice(s, e))) out.push([s, e]);
    i = j;
  }
  return out;
}

/// `rawChars` is the size of the ORIGINAL text this sidecar accompanies; it
/// defaults to `text` for callers that scan raw input directly.
export function scanNeedles(text: string, rawChars?: number): Sidecar {
  const seen = new Set<string>();
  const kept: Needle[] = [];
  let more = 0;
  let used = 0;
  let full = false;
  const lines = text.split("\n");
  const budget = sidecarBudget(rawChars ?? charCount(text));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const claimed: Array<[number, number]> = [];
    const take = (at: number, end: number, v: string): void => {
      claimed.push([at, end]);
      if (seen.has(v)) return;
      seen.add(v);
      const cost = 3 + String(i + 1).length + v.length; // "\nL<line> <value>"
      if (full || used + cost > budget) {
        full = true; // latch, so the carried list never ends ragged
        more += 1;
        return;
      }
      used += cost;
      kept.push({ line: i + 1, value: v });
    };
    // Whole-token pass first: an at-risk token ships entire, so a pattern that
    // matches only its middle cannot ship a fragment that reads as protected.
    for (const [at, end] of riskyTokens(line)) take(at, end, line.slice(at, end));
    // Then the named-format allowlist, for matches inside ordinary tokens.
    for (const pat of PATTERNS) {
      pat.lastIndex = 0;
      for (const m of line.matchAll(pat)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        if (claimed.some(([a, b]) => at < b && end > a)) continue;
        take(at, end, m[0]);
      }
    }
  }
  if (kept.length === 0) return { needles: [], more: 0, dense: false, text: "", tokens: 0 };
  kept.sort((a, b) => a.line - b.line);
  // Say what is CARRIED, not what was found: "read them here" is false for
  // anything past the budget, and the footer alone is easy to miss.
  let out =
    more > 0
      ? `·verbatim· ${kept.length} of ${kept.length + more} exact strings (read them here, not from pixels)`
      : `·verbatim· ${kept.length} exact strings (read them here, not from pixels)`;
  for (const n of kept) out += `\nL${n.line} ${n.value}`;
  if (more > 0) out += `\n… +${more} more (needle-dense; keep the source as text)`;
  return { needles: kept, more, dense: more > 0, text: out, tokens: textTokens(charCount(out)) };
}

/// Credential refuse-to-render gate. Rendering a secret to pixels risks a
/// silent single-character misread (the Table-D failure mode) on the one
/// string you must never corrupt, and buries it where no monitor can read it.
/// So a block carrying a credential-shaped secret is never imaged - it stays
/// text. High-confidence, well-structured formats only: a false positive just
/// keeps a block as text (safe, costs some compression), so we bias to recall
/// on known secret shapes and skip noisy generic `token=...` matches that
/// would gut ordinary log compression.
const CREDENTIALS: readonly (readonly [string, RegExp])[] = [
  ["aws-key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g],
  ["gcp-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g],
  ["github-pat", /\bgithub_pat_[0-9A-Za-z_]{82}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g],
  ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];

/// Distinct credential kinds found in `text`, sorted. Empty = safe to image.
/// Never returns the secret substring - only the kind label, for the marker.
export function scanCredentials(text: string): string[] {
  const kinds = new Set<string>();
  for (const [kind, pat] of CREDENTIALS) {
    pat.lastIndex = 0;
    if (pat.test(text)) kinds.add(kind);
  }
  return [...kinds].sort();
}
