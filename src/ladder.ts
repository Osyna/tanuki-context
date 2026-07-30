// Stage 1: graded text compression ladder (port of pxpipe mcp/compress.mjs).
// Levels 0-4, each ⊇ the previous. From level 2 up, any line that looks like
// code/data or carries a hash/path/URL/long id is passed VERBATIM.

import { isRustWhitespace, rustTrim } from "./serde.ts";

export const LEVELS: [string, string, string][] = [
  ["none", "none", "passthrough (baseline)"],
  [
    "whitespace",
    "lossless",
    "trailing whitespace + blank-line runs collapsed; safe for code",
  ],
  [
    "prose",
    "light",
    "L1 + prose lines: collapse spaces, cut redundant filler phrases (code/IDs protected)",
  ],
  [
    "dense",
    "medium",
    "L2 + prose: drop articles & intensifiers",
  ],
  [
    "caveman",
    "heavy",
    "L3 + prose: telegraphic — drop function words; gist only, NOT verbatim",
  ],
];

// Rust regex `\b` is Unicode-aware: \w = Alphabetic + Mark + Decimal_Number +
// Connector_Punctuation + Join_Control. JS `\b` is ASCII-only, so emulate the
// boundaries with lookarounds against the Unicode word class.
const W =
  "[\\p{Alphabetic}\\p{Mark}\\p{Decimal_Number}\\p{Connector_Punctuation}\\p{Join_Control}]";
// Rust `\s` / char::is_whitespace = Unicode White_Space. JS `\s` differs
// (misses U+0085 NEL, adds U+FEFF), so use the explicit property set.
const SP =
  "[\\t\\n\\x0B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";

// `(?i)\b<phrase>\b` — phrase starts/ends on a word char in every entry.
const wordPhrase = (p: string): RegExp =>
  new RegExp(`(?<!${W})(?:${p})(?!${W})`, "giu");

const FILLER: [RegExp, string][] = [
  [wordPhrase("in order to"), "to"],
  [wordPhrase("due to the fact that"), "because"],
  [wordPhrase("at this point in time"), "now"],
  [wordPhrase("in the event that"), "if"],
  [wordPhrase("for the purpose of"), "for"],
  [wordPhrase("with regard to"), "about"],
  [wordPhrase("a large number of"), "many"],
  [wordPhrase("it is important to note that"), ""],
  [wordPhrase("please note that"), ""],
  [wordPhrase("as a matter of fact"), ""],
  [wordPhrase("in terms of"), "for"],
  [wordPhrase("the fact that"), "that"],
];
// (?i)\b(the|an|a)\s+
const ARTICLES = new RegExp(`(?<!${W})(?:the|an|a)${SP}+`, "giu");
// (?i)\b(very|...)\s+
const INTENSIFIERS = new RegExp(
  `(?<!${W})(?:very|really|just|actually|basically|simply|quite|rather|essentially|literally)${SP}+`,
  "giu",
);
// (?i)\b(is|...)\b\s*
const FUNCTION_WORDS = new RegExp(
  `(?<!${W})(?:is|are|was|were|am|be|been|being|do|does|did|have|has|had|will|would|shall|should|can|could|may|might|of|to|in|on|at|for|with|that|this|these|those|it|its|there|here)(?!${W})${SP}*`,
  "giu",
);
const SPACES = / {2,}/g;
const PUNCT = new RegExp(`${SP}+([.,;:!?])`, "gu");
const NL3 = /\n{3,}/g;

/**
 * A line that must be preserved verbatim: indented (code), symbol-dense
 * (code/JSON), or carrying a long whitespace-free token (hash/path/URL/id).
 */
export function isProtectedLine(line: string): boolean {
  if (line.length === 0) return false;
  const c0 = line.charCodeAt(0);
  if (c0 === 0x20 || c0 === 0x09) return true;
  let total = 0;
  let sym = 0;
  let run = 0; // current whitespace-free token length in codepoints
  let longTok = false;
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    total++;
    if (isRustWhitespace(cp)) {
      run = 0;
      continue;
    }
    run++;
    if (run >= 24) longTok = true;
    // ascii alnum
    if (
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a)
    ) {
      continue;
    }
    // . , ; : ' " ! ? ( ) -
    switch (cp) {
      case 0x2e: // .
      case 0x2c: // ,
      case 0x3b: // ;
      case 0x3a: // :
      case 0x27: // '
      case 0x22: // "
      case 0x21: // !
      case 0x3f: // ?
      case 0x28: // (
      case 0x29: // )
      case 0x2d: // -
        continue;
    }
    sym++;
  }
  if (sym / total > 0.3) return true;
  return longTok;
}

function tightenProse(line: string, level: number): string {
  let s = line.replace(SPACES, " ");
  for (let i = 0; i < FILLER.length; i++) {
    s = s.replace(FILLER[i][0], FILLER[i][1]);
  }
  if (level >= 3) {
    s = s.replace(ARTICLES, "");
    s = s.replace(INTENSIFIERS, "");
  }
  if (level >= 4) {
    s = s.replace(FUNCTION_WORDS, "");
  }
  s = s.replace(SPACES, " ");
  s = rustTrim(s.replace(PUNCT, "$1"));
  // re-capitalize sentence start (ASCII lowercase only, like Rust)
  const first = s.charCodeAt(0);
  if (first >= 0x61 && first <= 0x7a) {
    s = String.fromCharCode(first - 0x20) + s.slice(1);
  }
  return s;
}

export interface Compressed {
  compressed: string;
  protectedLines: number;
  level: number;
}

export function compressText(text: string, level: number): Compressed {
  // Clamp defensively at the choke point, matching Rust's `f64 as u8` (which
  // saturates) followed by `.min(4)`. `Math.min(level, 4)` alone let a
  // negative through: the proxy's `--level -1` reached tightenProse, which
  // only tests >=3 and >=4, so it silently applied LOSSY level-2 prose
  // compression here while Rust applied none. Every caller is now safe
  // regardless of how it parsed the number.
  const lvl = Math.min(Math.max(0, Math.trunc(level)), 4);
  if (lvl === 0) {
    return { compressed: text, protectedLines: 0, level: lvl };
  }
  let protectedLines = 0;
  const parts = text.split("\n");
  const lines: string[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    // trim_end_matches([' ', '\t'])
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c !== 0x20 && c !== 0x09) break;
      end--;
    }
    const line = end === raw.length ? raw : raw.slice(0, end);
    if (lvl === 1) {
      lines[i] = line;
      continue;
    }
    if (isProtectedLine(line)) {
      protectedLines++;
      lines[i] = line;
      continue;
    }
    lines[i] = tightenProse(line, lvl);
  }
  const joined = lines.join("\n");
  return {
    compressed: joined.replace(NL3, "\n\n"),
    protectedLines,
    level: lvl,
  };
}
