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

/** The one text-price heuristic, stated once: ~4 chars per token. */
export function textTokens(chars: number): number {
  return Math.round(chars / 4.0);
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
