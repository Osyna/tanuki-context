//! Stash mode: park bulky text on disk under a content hash, hand back a
//! compact deterministic overview; fetch slices later by query or line range.
//! Storage: $TANUKI_STASH (else ~/.tanuki/stash), file named by the id =
//! first 12 hex chars of sha256(text). Byte-identical with the TS engine.

use crate::distill;
use crate::sha256;
use std::path::PathBuf;

pub fn stash_dir() -> PathBuf {
    match std::env::var_os("TANUKI_STASH") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => {
            let home = std::env::var_os("HOME").unwrap_or_default();
            PathBuf::from(home).join(".tanuki").join("stash")
        }
    }
}

/// Park `text` under its content hash; returns (id, overview).
pub fn stash_text(text: &str) -> std::io::Result<(String, String)> {
    let mut id = sha256::hex(text.as_bytes());
    id.truncate(12);
    let dir = stash_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(&id), text.as_bytes())?;
    let ov = overview(&id, text);
    Ok((id, ov))
}

/// The compact map returned by stash: joined with '\n', no trailing newline.
fn overview(id: &str, text: &str) -> String {
    let segs: Vec<&str> = text.split('\n').collect();
    let stats = distill::distill_log(text, None, 2).stats;
    let mut out = vec![
        format!("stashed {id} · {} bytes · {} lines", text.len(), segs.len()),
        format!(
            "distill map: {} -> {} lines · {}% of chars removable · {} error/warn lines",
            stats["origLines"], stats["outLines"], stats["savedPct"], stats["importantKept"],
        ),
    ];
    let reps = stats["topRepeats"].as_array().expect("topRepeats");
    if !reps.is_empty() {
        out.push("top repeats:".to_string());
        for r in reps.iter().take(5) {
            let tag = if r["kind"] == "template" { " (template)" } else { "" };
            // exemplar is already trimmed + truncated to 160 chars by distill
            out.push(format!("  ×{}{tag}  {}", r["count"], r["exemplar"].as_str().unwrap_or("")));
        }
    }
    fn t(s: &str) -> &str {
        distill::truncate_chars(s.trim(), 160)
    }
    let last = segs.iter().rev().find(|s| !s.is_empty()).copied().unwrap_or("");
    out.push(format!("first: {}", t(segs[0])));
    out.push(format!("last: {}", t(last)));
    out.push(format!(
        "fetch: tanuki_fetch {{\"id\":\"{id}\",\"query\":\"<regex>\"}} or {{\"id\":\"{id}\",\"lines\":\"a-b\"}}"
    ));
    out.join("\n")
}

/// Pull a slice of a stashed text: `query` (regex -> distilled slice) or
/// `lines` "a-b" (1-based inclusive segments, clamped) — exactly one of them.
pub fn fetch_slice(id: &str, query: Option<&str>, lines: Option<&str>) -> Result<String, String> {
    if query.is_some() == lines.is_some() {
        return Err("give exactly one of query or lines".to_string());
    }
    let Ok(text) = std::fs::read_to_string(stash_dir().join(id)) else {
        return Err(format!("unknown stash id: {id}"));
    };
    if let Some(q) = query {
        return Ok(distill::distill_log(&text, Some(q), 2).distilled);
    }
    let (a, b) = parse_range(lines.unwrap()).ok_or_else(|| "bad lines range".to_string())?;
    let segs: Vec<&str> = text.split('\n').collect();
    let (a, b) = (a.clamp(1, segs.len()), b.clamp(1, segs.len()));
    Ok(segs[a - 1..b].join("\n"))
}

/// "a-b" -> (a, b); None when unparsable or a > b.
fn parse_range(s: &str) -> Option<(usize, usize)> {
    let (a, b) = s.split_once('-')?;
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let (a, b): (usize, usize) = (a.parse().ok()?, b.parse().ok()?);
    (a <= b).then_some((a, b))
}

/// Serialize env-dependent tests (TANUKI_STASH is process-global) and give
/// each a scratch dir. Shared with the tool-level tests in main.rs.
#[cfg(test)]
pub(crate) fn with_test_dir<T>(name: &str, f: impl FnOnce() -> T) -> T {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("tanuki-stash-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::env::set_var("TANUKI_STASH", &dir);
    let out = f();
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_deterministic_and_exact() {
        with_test_dir("det", || {
            let text = "alpha\nbeta\ngamma";
            let (id1, ov1) = stash_text(text).unwrap();
            let (id2, ov2) = stash_text(text).unwrap();
            assert_eq!(id1, id2);
            assert_eq!(ov1, ov2, "overview must be byte-identical across runs");
            // sha256("alpha\nbeta\ngamma") = f3220283d05d1ff2...
            assert_eq!(id1, "f3220283d05d");
            assert_eq!(
                ov1,
                "stashed f3220283d05d · 16 bytes · 3 lines\n\
                 distill map: 3 -> 3 lines · 0% of chars removable · 0 error/warn lines\n\
                 first: alpha\n\
                 last: gamma\n\
                 fetch: tanuki_fetch {\"id\":\"f3220283d05d\",\"query\":\"<regex>\"} or {\"id\":\"f3220283d05d\",\"lines\":\"a-b\"}"
            );
            // the stash file holds the raw utf8 bytes
            assert_eq!(std::fs::read_to_string(stash_dir().join(&id1)).unwrap(), text);
        })
    }

    #[test]
    fn overview_counts_trailing_segment_and_lists_repeats() {
        with_test_dir("reps", || {
            // scattered (non-consecutive) repeats survive pass 1 and land in topRepeats
            let words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
            let mut text = String::new();
            for w in words {
                text.push_str("GET /api/v1/health 200 in 3ms\n");
                text.push_str(&format!("padding {w} line\n"));
            }
            let (_, ov) = stash_text(&text).unwrap();
            let lines: Vec<&str> = ov.split('\n').collect();
            // 18 payload segments + trailing empty segment = 19
            assert!(lines[0].ends_with(&format!(" · {} bytes · 19 lines", text.len())), "{}", lines[0]);
            assert_eq!(lines[2], "top repeats:");
            assert!(lines[3].starts_with("  ×9  GET /api/v1/health"), "{}", lines[3]);
            assert!(ov.contains("\nlast: padding india line\n"), "last skips the empty tail segment");
        })
    }

    #[test]
    fn fetch_lines_slice_exact() {
        with_test_dir("lines", || {
            let text = (1..=9).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
            let (id, _) = stash_text(&text).unwrap();
            assert_eq!(fetch_slice(&id, None, Some("2-4")).unwrap(), "line 2\nline 3\nline 4");
            assert_eq!(fetch_slice(&id, None, Some("9-9")).unwrap(), "line 9");
            // clamped into range on both ends
            assert_eq!(fetch_slice(&id, None, Some("7-99")).unwrap(), "line 7\nline 8\nline 9");
            assert_eq!(fetch_slice(&id, None, Some("0-1")).unwrap(), "line 1");
            assert_eq!(fetch_slice(&id, None, Some("5-2")).unwrap_err(), "bad lines range");
            assert_eq!(fetch_slice(&id, None, Some("x-2")).unwrap_err(), "bad lines range");
            assert_eq!(fetch_slice(&id, None, Some("3")).unwrap_err(), "bad lines range");
        })
    }

    #[test]
    fn fetch_query_returns_distilled_slice() {
        with_test_dir("query", || {
            let mut text = String::new();
            for i in 0..50 {
                text.push_str(&format!("2026-07-26T02:00:00Z INFO worker {i} heartbeat ok\n"));
            }
            text.push_str("2026-07-26T02:00:01Z ERROR worker 7 exploded\n");
            for i in 0..50 {
                text.push_str(&format!("2026-07-26T02:00:02Z INFO worker {i} heartbeat ok\n"));
            }
            let (id, _) = stash_text(&text).unwrap();
            let got = fetch_slice(&id, Some("exploded"), None).unwrap();
            assert_eq!(got, distill::distill_log(&text, Some("exploded"), 2).distilled);
            assert!(got.contains("ERROR worker 7 exploded"));
        })
    }

    #[test]
    fn fetch_arg_and_id_errors_exact() {
        with_test_dir("errs", || {
            let (id, _) = stash_text("abc").unwrap();
            assert_eq!(
                fetch_slice(&id, None, None).unwrap_err(),
                "give exactly one of query or lines"
            );
            assert_eq!(
                fetch_slice(&id, Some("a"), Some("1-1")).unwrap_err(),
                "give exactly one of query or lines"
            );
            assert_eq!(
                fetch_slice("cafebabe0000", Some("a"), None).unwrap_err(),
                "unknown stash id: cafebabe0000"
            );
        })
    }
}
