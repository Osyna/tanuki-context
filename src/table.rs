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
//! content (nested objects re-print with sorted keys, serde_json's default
//! Value ordering).
//!
//! ponytail: whole-input tables only — mixed prose+JSON stays text; add
//! block detection if a real corpus ever demands it.

use serde_json::Value;

pub const COLS_MARK: &str = "\u{b7}cols\u{b7}"; // ·cols·

pub struct Table {
    pub text: String,
    pub rows: usize,
    pub cols: usize,
}

/// Engine-parity cell print: an integral f64 in JS safe-integer range prints
/// as an integer (TS `Number.isSafeInteger(50.0)` -> "50"), so coerce those
/// to i64 at parse; everything else is serde_json's compact `Display`, which
/// the TS `jcell` mimics (sorted object keys, ryu-style exponents).
fn canon(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if n.is_f64() {
                let f = n.as_f64().unwrap();
                if f.fract() == 0.0 && f.abs() <= 9007199254740991.0 {
                    *v = Value::from(f as i64);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(canon),
        Value::Object(o) => o.values_mut().for_each(canon),
        _ => {}
    }
}

fn parse_rows(text: &str) -> Option<Vec<Value>> {
    // whole input = one JSON array of objects
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let Value::Array(a) = v {
            if a.len() >= 2 && a.iter().all(Value::is_object) {
                return Some(a);
            }
            return None;
        }
        // a non-array whole-JSON parse falls through to NDJSON (TS parity)
    }
    // pure NDJSON: every non-empty line parses as an object
    let mut rows = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        if !v.is_object() {
            return None;
        }
        rows.push(v);
    }
    if rows.len() >= 2 { Some(rows) } else { None }
}

/// Encode when the whole input is structured rows AND the table is actually
/// smaller (header overhead can lose on tiny inputs). None = leave text alone.
pub fn table_encode(text: &str) -> Option<Table> {
    let mut rows = parse_rows(text)?;
    rows.iter_mut().for_each(canon);
    // column order: sorted key union — canonical, and byte-identical across
    // engines by construction (String Ord is code-point order).
    let cols: Vec<&str> = {
        let mut seen = std::collections::BTreeSet::new();
        for r in &rows {
            for k in r.as_object().unwrap().keys() {
                seen.insert(k.as_str());
            }
        }
        seen.into_iter().collect()
    };
    if cols.is_empty() {
        return None;
    }
    let mut out: Vec<String> = Vec::with_capacity(rows.len() + 1);
    let header: Vec<String> = cols.iter().map(|k| serde_json::to_string(k).unwrap()).collect();
    out.push(format!("{COLS_MARK}\t{}", header.join("\t")));
    for r in &rows {
        let o = r.as_object().unwrap();
        let cells: Vec<String> = cols
            .iter()
            .map(|k| o.get(*k).map_or_else(String::new, |v| serde_json::to_string(v).unwrap()))
            .collect();
        out.push(cells.join("\t"));
    }
    let encoded = out.join("\n");
    if encoded.chars().count() >= text.chars().count() {
        return None;
    }
    Some(Table { text: encoded, rows: rows.len(), cols: cols.len() })
}

/// Decode back to canonical NDJSON (tests + the documented escape hatch).
#[allow(dead_code)] // exercised by round-trip tests; the pipeline never decodes
pub fn table_decode(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(head) = lines.first().and_then(|l| l.strip_prefix(COLS_MARK)).and_then(|l| l.strip_prefix('\t')) else {
        return None;
    };
    if lines.len() < 2 {
        return None;
    }
    let mut cols: Vec<String> = Vec::new();
    for c in head.split('\t') {
        match serde_json::from_str::<Value>(c) {
            Ok(Value::String(s)) => cols.push(s),
            _ => return None,
        }
    }
    let mut out: Vec<String> = Vec::new();
    for line in &lines[1..] {
        if line.trim().is_empty() {
            continue;
        }
        let cells: Vec<&str> = line.split('\t').collect();
        let mut parts: Vec<String> = Vec::new();
        for (c, col) in cols.iter().enumerate() {
            let cell = cells.get(c).copied().unwrap_or("");
            if cell.is_empty() {
                continue;
            }
            if serde_json::from_str::<Value>(cell).is_err() {
                return None;
            }
            parts.push(format!("{}:{cell}", serde_json::to_string(col).unwrap()));
        }
        out.push(format!("{{{}}}", parts.join(",")));
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn corpus_rows() -> Vec<Value> {
        (0..200)
            .map(|i| {
                json!({
                    "ts": format!("2026-07-26T03:{:02}:00Z", i % 60),
                    "level": if i % 7 == 0 { "error" } else { "info" },
                    "unit": format!("worker-{}.service", i % 4),
                    "message": format!("copied segment_{:05}.parquet ok", i % 9),
                    "pid": 1000 + (i % 32),
                })
            })
            .collect()
    }

    fn ndjson(rows: &[Value]) -> String {
        rows.iter().map(|r| serde_json::to_string(r).unwrap()).collect::<Vec<_>>().join("\n")
    }

    fn decode_rows(encoded: &str) -> Vec<Value> {
        table_decode(encoded)
            .expect("decode")
            .split('\n')
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn round_trip_preserves_every_value_ndjson_and_array_forms() {
        let rows = corpus_rows();
        let as_array = serde_json::to_string_pretty(&Value::Array(rows.clone())).unwrap();
        for src in [ndjson(&rows), as_array] {
            let t = table_encode(&src).expect("encode");
            assert_eq!(decode_rows(&t.text), rows);
        }
    }

    #[test]
    fn keys_stated_once_materially_smaller_rows_cols_counted() {
        let rows = corpus_rows();
        let src = ndjson(&rows);
        let t = table_encode(&src).expect("encode");
        assert_eq!(t.rows, 200);
        assert_eq!(t.cols, 5);
        // 5 keys x ~200 rows of repeated '"key":' scaffolding deleted
        assert!((t.text.chars().count() as f64) < src.chars().count() as f64 * 0.75);
    }

    #[test]
    fn gate_mixed_prose_stays_text_and_size_gate_decides_tiny_inputs() {
        let src = ndjson(&corpus_rows());
        assert!(table_encode(&format!("some prose\n{src}")).is_none());
        assert!(table_encode(r#"{"a":1}"#).is_none()); // single object, not rows
        // two rows with DISJOINT 1-char keys: the ·cols· header costs more than it saves
        assert!(table_encode("{\"a\":1}\n{\"b\":2}").is_none());
        // two rows SHARING a key: scaffolding removal already wins
        assert!(table_encode("{\"aa\":1}\n{\"aa\":2}").is_some());
    }

    #[test]
    fn absent_keys_become_empty_cells_and_survive_the_round_trip() {
        let sparse = "{\"a\":1,\"b\":\"x\"}\n{\"a\":2}\n{\"b\":\"y\",\"c\":true}";
        let t = table_encode(sparse).expect("encode");
        assert_eq!(
            decode_rows(&t.text),
            vec![json!({"a": 1, "b": "x"}), json!({"a": 2}), json!({"b": "y", "c": true})]
        );
    }

    #[test]
    fn tabs_and_newlines_inside_string_values_cannot_break_the_grammar() {
        let tricky = r#"{"msg":"a\tb\nc","n":1}
{"msg":"plain","n":2}"#;
        let t = table_encode(tricky).expect("encode");
        let back = decode_rows(&t.text);
        assert_eq!(back[0]["msg"], "a\tb\nc");
        assert_eq!(back[1]["msg"], "plain");
    }

    #[test]
    fn integral_f64_cells_print_as_integers() {
        // '50.0' parses as f64; the cell must print '50' (TS Number.isSafeInteger parity)
        let src = "{\"v\":50.0,\"w\":1.5}\n{\"v\":2.0,\"w\":0.25}";
        let t = table_encode(src).expect("encode");
        let mut lines = t.text.split('\n');
        assert_eq!(lines.next().unwrap(), format!("{COLS_MARK}\t\"v\"\t\"w\""));
        assert_eq!(lines.next().unwrap(), "50\t1.5");
        assert_eq!(lines.next().unwrap(), "2\t0.25");
    }
}
