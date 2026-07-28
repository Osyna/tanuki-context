//! Rust-engine parity primitives, in one place: the serde_json-compatible
//! serializer/accessors and the Unicode string ops that must count and trim
//! exactly like the Rust binary (`chars().count()`, `str::trim`,
//! `char::is_whitespace`, `f64::round`, UTF-8-order string cmp). Every other
//! module imports these instead of re-deriving them, so the two engines can
//! only drift in one file.

/**
 * Marker for values Rust holds as f64: serde_json prints whole floats with a
 * trailing `.0` (`50.0`), which plain JS numbers lose. `jstring` formats these
 * like serde_json/ryu.
 */
export class Float {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Rust `String` Ord = UTF-8 byte order = code-point order (not UTF-16 unit order). */
function keyCmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i >= n) {
    return a.length - b.length;
  }
  return a.codePointAt(i)! - b.codePointAt(i)!;
}

/** serde_json-compatible serializer (compact = `Display`, pretty = 2-space
 *  `to_string_pretty`). serde_json's default Map is a BTreeMap, so object keys
 *  serialize in byte-lexicographic order. Whole f64s (wrapped in `Float`)
 *  print as `50.0`. */
export function jstring(v: unknown, pretty: boolean, indent = ""): string {
  if (v === null || v === undefined) {
    return "null";
  }
  if (v instanceof Float) {
    const f = v.value;
    return Number.isFinite(f) && Number.isInteger(f) ? f.toFixed(1) : String(f);
  }
  const t = typeof v;
  if (t === "string") {
    return JSON.stringify(v);
  }
  if (t === "number" || t === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return "[]";
    }
    if (!pretty) {
      let out = "[";
      for (let i = 0; i < v.length; i++) {
        if (i > 0) out += ",";
        out += jstring(v[i], false);
      }
      return out + "]";
    }
    const inner = indent + "  ";
    let out = "[\n";
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ",\n";
      out += inner + jstring(v[i], true, inner);
    }
    return out + "\n" + indent + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort(keyCmp);
  if (keys.length === 0) {
    return "{}";
  }
  if (!pretty) {
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      out += JSON.stringify(keys[i]) + ":" + jstring(obj[keys[i]], false);
    }
    return out + "}";
  }
  const inner = indent + "  ";
  let out = "{\n";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",\n";
    out += inner + JSON.stringify(keys[i]) + ": " + jstring(obj[keys[i]], true, inner);
  }
  return out + "\n" + indent + "}";
}

/** Plain JSON object (serde_json `Value::Object`): not null, not an array. */
export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** serde_json `Value` string index: Null for non-objects / missing keys. */
export function jget(v: unknown, key: string): unknown {
  return isObj(v) ? v[key] : undefined;
}

export function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** serde_json `as_u64()`: only non-negative integer JSON numbers count. */
export function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Rust `f64::round()`: half away from zero (JS Math.round differs for negatives). */
export function rnd(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * The one text-price heuristic, stated once. Measured, not assumed.
 *
 * This used to be `chars / 4`, and that is wrong by a factor of three across
 * the content tanuki actually routes. Against Anthropic's own tokenizer
 * (`/v1/messages/count_tokens`, 30 samples, EVALS §9) real content runs from
 * **1.14 chars/token** (base64) to **5.52** (prose) - `chars/4` was off by
 * -72% on base64 and +38% on prose. It is the denominator of the imaging gate,
 * the minimum-saving test, the fidelity band's ratio and the savings ledger,
 * and the error does not cancel: image tokens come from exact pixel geometry,
 * so understating text tokens made tanuki decline wins AND report a rosier
 * fidelity band than the density warranted.
 *
 * A single divisor cannot fit a 2.8x spread, so this prices character classes
 * by how a BPE actually treats them:
 *   - letters inside a word-like run are nearly free (~6 chars/token): the
 *     merge table was built for words;
 *   - letters in a run with no vowel, or longer than 14 (base64, hex, ids),
 *     fragment to roughly a token and a half per character;
 *   - digits and punctuation fragment hard; whitespace usually merges into the
 *     following word.
 * Weights are least-squares over those 30 samples. Worst residual 19.8%,
 * 21.7% leave-one-out, against 72% for `chars/4`; on real logs it is within
 * 3.5%.
 *
 * Integer per-mille arithmetic on purpose: identical in both engines with no
 * floating-point parity risk.
 */
const W_WORD = 161; // letters in a word-like run, per mille
const W_ODD = 1501; // letters in a vowelless or overlong run
const W_DIGIT = 807;
const W_PUNCT = 690;
const W_SPACE = 428;
const MAX_WORD_RUN = 14;

export function textTokens(text: string): number {
  let word = 0, odd = 0, digits = 0, punct = 0, space = 0;
  let runLen = 0, runVowels = 0;
  const flush = (): void => {
    if (runLen === 0) return;
    if (runVowels > 0 && runLen <= MAX_WORD_RUN) word += runLen;
    else odd += runLen;
    runLen = 0;
    runVowels = 0;
  };
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const lower = c | 0x20;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      runLen++;
      if (lower === 97 || lower === 101 || lower === 105 || lower === 111 || lower === 117 || lower === 121) runVowels++;
      continue;
    }
    flush();
    if (c >= 48 && c <= 57) digits++;
    else if (c === 32 || c === 9 || c === 10 || c === 13) space++;
    else punct++;
  }
  flush();
  const milli = word * W_WORD + odd * W_ODD + digits * W_DIGIT + punct * W_PUNCT + space * W_SPACE;
  return Math.round(milli / 1000);
}

/** Rust `chars().count()`: Unicode scalar values, not UTF-16 units. */
export function charCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return n;
}

/** Rust `truncate_chars`: first n codepoints of s. */
export function truncateChars(s: string, n: number): string {
  let i = 0;
  let c = 0;
  const len = s.length;
  while (i < len && c < n) {
    const u = s.charCodeAt(i);
    i += u >= 0xd800 && u <= 0xdbff && i + 1 < len ? 2 : 1;
    c++;
  }
  return i >= len ? s : s.slice(0, i);
}

/** Rust `char::is_whitespace` (Unicode White_Space). All members are BMP,
 * non-surrogate, single UTF-16 unit — safe on charCodeAt values too. */
export function isRustWhitespace(cp: number): boolean {
  if (cp === 0x20) return true;
  if (cp < 0x09) return false;
  if (cp <= 0x0d) return true;
  if (cp < 0x85) return false;
  return (
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Rust `str::trim` (Unicode-whitespace on both ends). */
export function rustTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isRustWhitespace(s.charCodeAt(a))) a++;
  while (b > a && isRustWhitespace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Rust String cmp = UTF-8 byte order = codepoint order (NOT UTF-16 unit order). */
export function cmpCodepoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}
