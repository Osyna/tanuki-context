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
//! default Value ordering, which `jstring` in serde.ts already mimics
//! engine-wide).
//!
//! ponytail: whole-input tables only — mixed prose+JSON stays text; add
//! block detection if a real corpus ever demands it.

import { IMPORTANT } from "./distill.ts";
import { charCount, cmpCodepoints } from "./serde.ts";
import { stashText } from "./stash.ts";

export const COLS_MARK = "·cols·";

export interface Table {
  text: string;
  rows: number;
  cols: number;
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

export interface CrushSelect {
  text: string;
  kept: number;
  rows: number;
}

export interface CrushRows extends CrushSelect {
  id: string;
}

const CRUSH_MIN = 30;
const CRUSH_HEAD = 10;
const CRUSH_TAIL = 5;
const IMPORTANT_CAP = 40;

/**
 * crushRowsSelect: the pure selection half of crushRows - keep head/tail/
 * important rows of an oversized JSON/NDJSON row set, stash NOTHING. This is
 * what `recommend` prices (a probe must not write to the store). null = not
 * applicable (parse failed, too small, or nothing saved).
 */
export function crushRowsSelect(text: string): CrushSelect | null {
  const rows = parseRows(text);
  if (rows === null || rows.length < CRUSH_MIN) return null;

  // Canonicalize and dedupe
  const canonical = rows.map((r) => jcell(r));
  const seen = new Map<string, number>();
  const deduped: number[] = [];
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical[i];
    if (!seen.has(c)) {
      seen.set(c, deduped.length);
      deduped.push(i);
    }
  }

  // Build kept set: head + tail + important
  const kept = new Set<number>();
  for (let i = 0; i < Math.min(CRUSH_HEAD, deduped.length); i++) {
    kept.add(deduped[i]);
  }
  for (let i = Math.max(0, deduped.length - CRUSH_TAIL); i < deduped.length; i++) {
    kept.add(deduped[i]);
  }

  // Important rows
  let importantCount = 0;
  for (let i = 0; i < deduped.length && importantCount < IMPORTANT_CAP; i++) {
    const idx = deduped[i];
    if (IMPORTANT.test(canonical[idx])) {
      kept.add(idx);
      importantCount++;
    }
  }

  // Nothing saved?
  if (kept.size >= rows.length) return null;

  // Build output: kept canonical rows in original order
  const keptIndices = Array.from(kept).sort((a, b) => a - b);
  const outText = keptIndices.map((i) => canonical[i]).join("\n");

  return { text: outText, kept: kept.size, rows: rows.length };
}

/**
 * crushRows: selection + the stash of the full original, so the marker line
 * can name a real fetchable id. null exactly when crushRowsSelect is null.
 */
export function crushRows(text: string): CrushRows | null {
  const sel = crushRowsSelect(text);
  if (sel === null) return null;
  const stashed = stashText(text);
  return { ...sel, id: stashed.id };
}

/** Canonical compact JSON for parity (shared with proxy diagnostics). */
export const canonJson = jcell;
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
  if (charCount(encoded) >= charCount(text)) return null;
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
