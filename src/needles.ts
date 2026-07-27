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
//! ponytail: capped flat list, first 32 by first occurrence. If a file is
//! needle-dense past the cap it is hash-heavy content that should stay
//! text, and the verdict math (image + sidecar vs raw) already says so.

import { charCount, textTokens } from "./serde.ts";

export interface Needle {
  line: number; // 1-based line in the text the pages carry
  value: string;
}

export interface Sidecar {
  needles: Needle[]; // first occurrence per distinct value, capped
  more: number; // distinct values past the cap
  text: string; // "" when no needles: the block to ship as text
  tokens: number; // textTokens(text)
}

export const NEEDLE_CAP = 32;

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

export function scanNeedles(text: string): Sidecar {
  const seen = new Set<string>();
  const kept: Needle[] = [];
  let more = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const claimed: Array<[number, number]> = [];
    for (const pat of PATTERNS) {
      pat.lastIndex = 0;
      for (const m of lines[i].matchAll(pat)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        if (claimed.some(([a, b]) => at < b && end > a)) continue;
        claimed.push([at, end]);
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        if (kept.length < NEEDLE_CAP) kept.push({ line: i + 1, value: m[0] });
        else more += 1;
      }
    }
  }
  if (kept.length === 0) return { needles: [], more: 0, text: "", tokens: 0 };
  kept.sort((a, b) => a.line - b.line);
  let out = `·verbatim· ${kept.length + more} exact strings (read them here, not from pixels)`;
  for (const n of kept) out += `\nL${n.line} ${n.value}`;
  if (more > 0) out += `\n… +${more} more (needle-dense; keep the source as text)`;
  return { needles: kept, more, text: out, tokens: textTokens(charCount(out)) };
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
