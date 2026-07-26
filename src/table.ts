//! Columnar codec for structured JSON — the one domain where retrieval-store
//! compressors (Headroom's SmartCrusher) beat tanuki's line tools, done
//! tanuki-style instead: deterministic, no model in the loop, decode grammar
//! documented. An array of objects (or NDJSON — journalctl -o json, docker
//! events, API dumps) repeats every key on every row; state the keys ONCE:
//!
//!   ·cols·<TAB>"k1"<TAB>"k2"...
//!   cell<TAB>cell...          one line per row, cells = compact JSON
//!
//! An absent key is an empty cell (a JSON cell is never empty, so this is
//! unambiguous). Compact JSON escapes every control char, so a raw tab can
//! never appear inside a cell. Round-trip contract: same VALUES in canonical
//! layout — whitespace and per-object key order are serialization, not
//! content (nested objects re-print with sorted keys, exactly serde_json's
//! default Value ordering, which the custom serializer in main.ts already
//! mimics engine-wide).
//!
//! ponytail: whole-input tables only — mixed prose+JSON stays text; add
//! block detection if a real corpus ever demands it.

export const COLS_MARK = "·cols·";

import { cmpCodepoints } from "./codebook.ts";

export interface Table {
  text: string;
  rows: number;
  cols: number;
}

/** Unicode-scalar count, matching charCount in main.ts (Rust chars().count()). */
function chars(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
}

/**
 * serde_json-compatible compact value print. Two engine-parity rules:
 * integral f64 in safe range prints as an integer (the Rust port coerces at
 * parse: fract()==0 → i64), and JS exponent "e+21" drops the '+' (ryu style).
 * Object keys sort (serde_json Value = BTreeMap).
 */
function jcell(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return String(v);
    return String(v).replace("e+", "e");
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcell).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcell(o[k])}`).join(",")}}`;
}

function parseRows(text: string): Record<string, unknown>[] | null {
  const isRow = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  // whole input = one JSON array of objects
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) {
      if (v.length >= 2 && v.every(isRow)) return v as Record<string, unknown>[];
      return null;
    }
  } catch {
    /* fall through to NDJSON */
  }
  // pure NDJSON: every non-empty line parses as an object
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const v = JSON.parse(line);
      if (!isRow(v)) return null;
      rows.push(v);
    } catch {
      return null;
    }
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * Encode when the whole input is structured rows AND the table is actually
 * smaller (header overhead can lose on tiny inputs). null = leave text alone.
 */
export function tableEncode(text: string): Table | null {
  const rows = parseRows(text);
  if (rows === null) return null;
  // column order: sorted key union — canonical, and byte-identical across
  // engines by construction (Rust's serde_json Value is a sorted BTreeMap,
  // so source key order does not survive parsing there anyway).
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) seen.add(k);
  }
  const cols = [...seen].sort(cmpCodepoints);
  if (cols.length === 0) return null;
  const out: string[] = [COLS_MARK + "\t" + cols.map((k) => JSON.stringify(k)).join("\t")];
  for (const r of rows) {
    out.push(cols.map((k) => (k in r ? jcell(r[k]) : "")).join("\t"));
  }
  const encoded = out.join("\n");
  if (chars(encoded) >= chars(text)) return null;
  return { text: encoded, rows: rows.length, cols: cols.length };
}

/** Decode back to canonical NDJSON (tests + the documented escape hatch). */
export function tableDecode(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length < 2 || !lines[0].startsWith(COLS_MARK + "\t")) return null;
  let cols: string[];
  try {
    cols = lines[0]
      .slice(COLS_MARK.length + 1)
      .split("\t")
      .map((c) => {
        const k = JSON.parse(c);
        if (typeof k !== "string") throw new Error("bad col");
        return k;
      });
  } catch {
    return null;
  }
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    const cells = lines[i].split("\t");
    const parts: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const cell = cells[c] ?? "";
      if (cell === "") continue;
      try {
        JSON.parse(cell);
      } catch {
        return null;
      }
      parts.push(`${JSON.stringify(cols[c])}:${cell}`);
    }
    out.push(`{${parts.join(",")}}`);
  }
  return out.join("\n");
}
