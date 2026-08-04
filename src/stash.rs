//! Stash mode: park bulky text on disk under a content hash, hand back a
//! compact deterministic overview; fetch slices later by query or line range.
//! Storage: $TANUKI_STASH (else ~/.tanuki/stash), file named by the id =
//! first 12 hex chars of sha256(text). Byte-identical with the TS engine.

use crate::distill;
use crate::sha256;
use std::path::PathBuf;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// ponytail: below this length a distance-1 neighborhood is mostly noise, so
/// short values get an exact-or-absent answer only (mirror of the TS engine).
const MIN_FUZZY_LEN: usize = 4;
const VERIFY_CAND_CAP: usize = 8;

pub fn stash_dir() -> PathBuf {
    match std::env::var_os("TANUKI_STASH") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => {
            let home = std::env::var_os("HOME").unwrap_or_default();
            PathBuf::from(home).join(".tanuki").join("stash")
        }
    }
}

/// Read a stashed blob by id, validating the id first. Ids are
/// content-addressed - `stash_text` mints them as a 12-char lowercase sha256
/// prefix - so any other shape is a traversal attempt, not a typo (issue #2).
/// This engine needed it more than the TS one: `PathBuf::join` REPLACES the
/// base when its argument is absolute, so an absolute `id` escaped the stash
/// dir outright, with no `..` anywhere. Returns the same contract error a
/// missing id already returned, so callers and tests are unchanged.
fn read_stash(id: &str) -> Result<String, String> {
    let shaped = id.len() == 12 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    shaped
        .then(|| stash_dir().join(id))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .ok_or_else(|| format!("unknown stash id: {id}"))
}

/// Park `text` under its content hash; returns (id, overview).
pub fn stash_text(text: &str) -> std::io::Result<(String, String)> {
    let mut id = sha256::hex(text.as_bytes());
    id.truncate(12);
    let dir = stash_dir();
    // The stash deliberately holds unredacted bytes, so it is owner-only
    // rather than whatever umask says (0755/0644 by default). Mode is applied
    // at creation, not chmod'ed after, so there is no world-readable window.
    let mut db = std::fs::DirBuilder::new();
    db.recursive(true);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
        db.mode(0o700);
        opts.mode(0o600);
    }
    db.create(&dir)?;
    {
        use std::io::Write as _;
        opts.open(dir.join(&id))?.write_all(text.as_bytes())?;
    }
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

/// Pull a slice of a stashed text: `query` (regex -> distilled slice), `lines`
/// "a-b" (1-based inclusive segments, clamped), or `find` (relevance search) —
/// exactly one of them.
pub fn fetch_slice(
    id: &str,
    query: Option<&str>,
    lines: Option<&str>,
    find: Option<&str>,
    top: usize,
) -> Result<String, String> {
    let non_null = [query.is_some(), lines.is_some(), find.is_some()].iter().filter(|&&x| x).count();
    if non_null != 1 {
        return Err("give exactly one of query, lines or find".to_string());
    }
    let text = read_stash(id)?;
    // F3: find mode
    if let Some(f) = find {
        let raw_words: Vec<&str> = f.split_whitespace().collect();
        if raw_words.is_empty() {
            return Err("find needs at least one word".to_string());
        }
        let mut seen = std::collections::HashSet::new();
        let mut words = Vec::new();
        for w in raw_words {
            let lower = w.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower.clone());
                words.push(lower);
                if words.len() >= 8 {
                    break;
                }
            }
        }
        let segments: Vec<&str> = text.split('\n').collect();
        let n = segments.len();
        
        // Score each line
        struct Anchor {
            line: usize,
            score: usize,
        }
        let mut anchors = Vec::new();
        for (i, raw) in segments.iter().enumerate() {
            let lower = raw.to_lowercase();
            let mut score = 0;
            for word in &words {
                // ASCII word boundary check
                let mut found = false;
                if let Some(pos) = raw.to_lowercase().find(word) {
                    let before_ok = pos == 0 || !raw.as_bytes()[pos - 1].is_ascii_alphanumeric() && raw.as_bytes()[pos - 1] != b'_';
                    let after_pos = pos + word.len();
                    let after_ok = after_pos >= raw.len() || !raw.as_bytes()[after_pos].is_ascii_alphanumeric() && raw.as_bytes()[after_pos] != b'_';
                    if before_ok && after_ok {
                        score += 3;
                        found = true;
                    }
                }
                if !found && lower.contains(word) {
                    score += 1;
                }
            }
            if score > 0 {
                anchors.push(Anchor { line: i + 1, score });
            }
        }
        
        let h = anchors.len();
        if h == 0 {
            return Ok(format!("·find· {} words · 0 lines matched", words.len()));
        }
        
        // Top K anchors by (score desc, line asc)
        let k = top.clamp(1, 32);
        anchors.sort_by(|a, b| {
            if a.score != b.score {
                b.score.cmp(&a.score)
            } else {
                a.line.cmp(&b.line)
            }
        });
        let top_anchors: Vec<_> = anchors.into_iter().take(k).collect();
        
        // Build windows: each anchor -> [max(1,n-2), min(N,n+2)]
        struct Window {
            start: usize,
            end: usize,
            score: usize,
        }
        let mut windows = Vec::new();
        for anc in &top_anchors {
            let start = 1.max(anc.line.saturating_sub(2));
            let end = n.min(anc.line + 2);
            windows.push(Window { start, end, score: anc.score });
        }
        
        // Merge overlapping/adjacent windows
        windows.sort_by_key(|w| w.start);
        let mut merged: Vec<Window> = Vec::new();
        for win in windows {
            if merged.is_empty() || win.start > merged.last().unwrap().end + 1 {
                merged.push(win);
            } else {
                let last = merged.last_mut().unwrap();
                last.end = last.end.max(win.end);
                last.score = last.score.max(win.score);
            }
        }
        
        // Output
        let mut parts = Vec::new();
        for win in &merged {
            parts.push(format!("·find· L{}-{} score {}", win.start, win.end, win.score));
            parts.push(segments[win.start - 1..win.end].join("\n"));
        }
        parts.push(format!("·find· {} words · {} lines matched · {} windows", words.len(), h, merged.len()));
        return Ok(parts.join("\n"));
    }
    if let Some(q) = query {
        return Ok(distill::distill_log(&text, Some(q), 2).distilled);
    }
    let (a, b) = parse_range(lines.unwrap()).ok_or_else(|| "bad lines range".to_string())?;
    let segs: Vec<&str> = text.split('\n').collect();
    let (a, b) = (a.clamp(1, segs.len()), b.clamp(1, segs.len()));
    Ok(segs[a - 1..b].join("\n"))
}

/// How many raw lines of the stash match `query`, and how many there are.
/// The distilled slice keeps context lines and collapses repeats, so its line
/// count is NOT a match count - and without a real one an agent cannot answer
/// "which unit logged the most errors" at all (EVALS section 6).
pub fn match_count(id: &str, query: &str) -> Result<(usize, usize), String> {
    let text = read_stash(id)?;
    let re = regex::Regex::new(query).map_err(|_| format!("bad query regex: {query}"))?;
    let segs: Vec<&str> = text.split('\n').collect();
    let matched = segs.iter().filter(|l| re.is_match(l)).count();
    Ok((matched, segs.len()))
}

/// 2^53-1: the largest integer the TS engine holds exactly. Both engines
/// saturate a line bound here so an absurd end bound means "to the end"
/// identically, instead of TS rounding past 2^53 and returning the whole
/// stash while this side overflowed into "bad lines range".
const MAX_LINE: usize = 9_007_199_254_740_991;

/// "a-b" -> (a, b), each saturated to MAX_LINE; None when unparsable or a > b.
fn parse_range(s: &str) -> Option<(usize, usize)> {
    let (a, b) = s.split_once('-')?;
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let bound = |t: &str| t.parse::<usize>().unwrap_or(MAX_LINE).min(MAX_LINE);
    let (a, b) = (bound(a), bound(b));
    (a <= b).then_some((a, b))
}

/// Disk-grounded exact check for a value read off a rendered page. No model:
/// the stashed original bytes are compared directly, so a plausible-wrong-
/// character misread becomes `exact`, a unique `corrected`, an `ambiguous`
/// shortlist, or an explicit `absent`. Byte-identical with the TS engine
/// (substitution or adjacent-transposition distance 1; same scan and math).
pub fn verify_value(id: &str, value: &str) -> Result<Value, String> {
    if value.is_empty() {
        return Err("verify needs a non-empty value".to_string());
    }
    let text = read_stash(id)?;

    if let Some(byte_idx) = text.find(value) {
        let line = 1 + text[..byte_idx].bytes().filter(|&b| b == b'\n').count();
        return Ok(json!({ "status": "exact", "line": line, "found": value, "candidates": [] }));
    }

    let val: Vec<char> = value.chars().collect();
    let n = val.len();
    if n < MIN_FUZZY_LEN {
        return Ok(json!({ "status": "absent", "line": null, "found": null, "candidates": [] }));
    }

    let cps: Vec<char> = text.chars().collect();
    let mut line_at = vec![0usize; cps.len()];
    let mut ln = 1usize;
    for (i, &c) in cps.iter().enumerate() {
        line_at[i] = ln;
        if c == '\n' {
            ln += 1;
        }
    }

    // Distance-1 neighbourhood, same length only (mirror of the TS engine): one
    // substitution (the dominant dense-glyph misread) or one adjacent
    // transposition (a digit swap like f0->0f). Both preserve length, so a
    // window cannot match a fragment of a longer token the way an indel would.
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    if n <= cps.len() {
        for off in 0..=(cps.len() - n) {
            let mut diffs = 0usize;
            let mut a = 0usize;
            let mut b = 0usize;
            for i in 0..n {
                if val[i] != cps[off + i] {
                    diffs += 1;
                    if diffs == 1 {
                        a = i;
                    } else if diffs == 2 {
                        b = i;
                    } else {
                        break;
                    }
                }
            }
            let is_match = diffs == 1
                || (diffs == 2 && b == a + 1 && val[a] == cps[off + b] && val[b] == cps[off + a]);
            if is_match {
                let s: String = cps[off..off + n].iter().collect();
                found.entry(s).or_insert(line_at[off]);
            }
        }
    }

    if found.is_empty() {
        return Ok(json!({ "status": "absent", "line": null, "found": null, "candidates": [] }));
    }
    if found.len() == 1 {
        let (s, line) = found.iter().next().unwrap();
        return Ok(json!({ "status": "corrected", "line": line, "found": s, "candidates": [] }));
    }
    let candidates: Vec<&String> = found.keys().take(VERIFY_CAND_CAP).collect();
    Ok(json!({ "status": "ambiguous", "line": null, "found": null, "candidates": candidates }))
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
            assert_eq!(fetch_slice(&id, None, Some("2-4"), None, 8).unwrap(), "line 2\nline 3\nline 4");
            assert_eq!(fetch_slice(&id, None, Some("9-9"), None, 8).unwrap(), "line 9");
            // clamped into range on both ends
            assert_eq!(fetch_slice(&id, None, Some("7-99"), None, 8).unwrap(), "line 7\nline 8\nline 9");
            assert_eq!(fetch_slice(&id, None, Some("0-1"), None, 8).unwrap(), "line 1");
            assert_eq!(fetch_slice(&id, None, Some("5-2"), None, 8).unwrap_err(), "bad lines range");
            assert_eq!(fetch_slice(&id, None, Some("x-2"), None, 8).unwrap_err(), "bad lines range");
            assert_eq!(fetch_slice(&id, None, Some("3"), None, 8).unwrap_err(), "bad lines range");
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
            let got = fetch_slice(&id, Some("exploded"), None, None, 8).unwrap();
            assert_eq!(got, distill::distill_log(&text, Some("exploded"), 2).distilled);
            assert!(got.contains("ERROR worker 7 exploded"));
        })
    }

    #[test]
    fn fetch_arg_and_id_errors_exact() {
        with_test_dir("errs", || {
            let (id, _) = stash_text("abc").unwrap();
            assert_eq!(
                fetch_slice(&id, None, None, None, 8).unwrap_err(),
                "give exactly one of query, lines or find"
            );
            assert_eq!(
                fetch_slice(&id, Some("a"), Some("1-1"), None, 8).unwrap_err(),
                "give exactly one of query, lines or find"
            );
            assert_eq!(
                fetch_slice("cafebabe0000", Some("a"), None, None, 8).unwrap_err(),
                "unknown stash id: cafebabe0000"
            );
        })
    }

    /// Issue #2: an id indexes a content-addressed file, so a caller-supplied
    /// path is never legitimate. The sentinel is a REAL file one level out of
    /// the stash dir, so passing means the read was refused, not that it
    /// missed. This engine was the worse of the two: `PathBuf::join` replaces
    /// the base when the argument is absolute, so it escaped with no `..`.
    #[test]
    fn traversal_ids_are_refused_at_every_read_site() {
        with_test_dir("traversal", || {
            let secret = std::env::temp_dir().join("tanuki-traversal-secret.txt");
            std::fs::write(&secret, "SENTINEL topsecret\n").unwrap();
            let abs = secret.to_string_lossy().to_string();
            let escapes = [
                "../tanuki-traversal-secret.txt",
                abs.as_str(),
                "..",
                "DEADBEEFCAFE", // a sha256 hex prefix is lowercase
                "deadbeefcaf",  // 11
                "deadbeefcafe1", // 13
            ];
            for bad in escapes {
                let want = format!("unknown stash id: {bad}");
                assert_eq!(fetch_slice(bad, None, Some("1-2"), None, 8).unwrap_err(), want);
                assert_eq!(fetch_slice(bad, Some("SENTINEL"), None, None, 8).unwrap_err(), want);
                assert_eq!(fetch_slice(bad, None, None, Some("SENTINEL"), 8).unwrap_err(), want);
                assert_eq!(match_count(bad, "SENTINEL").unwrap_err(), want);
                assert_eq!(verify_value(bad, "topsecret").unwrap_err(), want);
            }
            // The guard rejects only what stash_text cannot mint: real ids read.
            let (id, _) = stash_text("alpha\nbeta\n").unwrap();
            assert!(fetch_slice(&id, None, Some("1-1"), None, 8).is_ok());
            assert_eq!(match_count(&id, "alpha").unwrap().0, 1);
            assert_eq!(verify_value(&id, "alpha").unwrap()["status"], "exact");
            let _ = std::fs::remove_file(&secret);
        })
    }

    /// The stash holds unredacted bytes by design, so creation is owner-only
    /// rather than umask-default (0755/0644). Asserting group/other bits are
    /// clear rather than an exact mode keeps this true under any sane umask.
    #[cfg(unix)]
    #[test]
    fn stash_is_created_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        with_test_dir("perm", || {
            let (id, _) = stash_text("alpha\nbeta\n").unwrap();
            let dir = stash_dir();
            let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o077;
            assert_eq!(mode(dir.clone()), 0, "stash dir is group/other accessible");
            assert_eq!(mode(dir.join(&id)), 0, "stash file is group/other readable");
        })
    }

    #[test]
    fn verify_exact_corrected_ambiguous_absent() {
        with_test_dir("verify", || {
            let text = "alpha beta\nid 3451bd1b-13c4-4558-aa67-a62bc042905e end\ngamma cafe1234 and cafe1235 delta\n";
            let (id, _) = stash_text(text).unwrap();

            let exact = verify_value(&id, "3451bd1b-13c4-4558-aa67-a62bc042905e").unwrap();
            assert_eq!(exact["status"], "exact");
            assert_eq!(exact["line"], 2);
            assert_eq!(exact["found"], "3451bd1b-13c4-4558-aa67-a62bc042905e");

            // one-character misread (last e->f) resolves to the unique on-disk value
            let corr = verify_value(&id, "3451bd1b-13c4-4558-aa67-a62bc042905f").unwrap();
            assert_eq!(corr["status"], "corrected");
            assert_eq!(corr["found"], "3451bd1b-13c4-4558-aa67-a62bc042905e");
            assert_eq!(corr["line"], 2);

            // adjacent transposition (last two chars 5e -> e5) resolves too
            let trans = verify_value(&id, "3451bd1b-13c4-4558-aa67-a62bc04290e5").unwrap();
            assert_eq!(trans["status"], "corrected");
            assert_eq!(trans["found"], "3451bd1b-13c4-4558-aa67-a62bc042905e");

            // two distance-1 neighbours -> ambiguous shortlist, sorted
            let amb = verify_value(&id, "cafe1230").unwrap();
            assert_eq!(amb["status"], "ambiguous");
            assert_eq!(amb["candidates"], json!(["cafe1234", "cafe1235"]));

            assert_eq!(verify_value(&id, "ffffffff-0000-0000-0000-000000000000").unwrap()["status"], "absent");
            // short value: exact-or-absent only, no fuzzing
            assert_eq!(verify_value(&id, "cafe1234").unwrap()["status"], "exact");
            assert_eq!(verify_value(&id, "xyz").unwrap()["status"], "absent");

            assert_eq!(verify_value(&id, "").unwrap_err(), "verify needs a non-empty value");
            assert_eq!(verify_value("deadbeefcafe", "whatever").unwrap_err(), "unknown stash id: deadbeefcafe");
        })
    }
}

#[cfg(test)]
mod count_tests {
    use super::*;

    /// Slices cannot count what they do not show - the distilled slice is
    /// context-padded and collapsed, so a frequency question needs the raw
    /// match count (EVALS section 6).
    #[test]
    fn match_count_is_raw_not_distilled() {
        with_test_dir("mc", || {
            let mut lines: Vec<String> = Vec::new();
            for i in 0..300 {
                let u = ["alpha", "beta", "gamma"][i % 3];
                let err = (u == "alpha" && i % 6 == 0) || i % 30 == 0;
                lines.push(format!("svc {u} {} boom", if err { "ERROR" } else { "INFO" }));
            }
            let text = format!("{}\n", lines.join("\n"));
            let (id, _) = stash_text(&text).unwrap();
            let (a, total) = match_count(&id, "alpha ERROR").unwrap();
            let (b, _) = match_count(&id, "beta ERROR").unwrap();
            let (c, _) = match_count(&id, "gamma ERROR").unwrap();
            assert!(a > b && a > c, "alpha {a} beta {b} gamma {c}");
            assert_eq!(total, 301);
            assert!(match_count("000000000000", "x").is_err());
            assert!(match_count(&id, "[unclosed").is_err());
        })
    }
    #[test]
    fn find_output_is_never_imaged() {
        // Mirrors the TS guard: the gate lives in main.rs tool_fetch/CLI, but
        // the premise it needs is pinned here - a find over a corpus whose
        // windows are big enough that the imaging gate WOULD win must still
        // come back as ·find· text windows from fetch_slice.
        // TANUKI_STASH is process-global and `with_test_dir` deletes its
        // scratch dir on the way out, so a test that stashes outside the
        // harness races every test inside it: the id vanishes between
        // stash_text and fetch_slice. Landed without the wrapper alongside
        // `find`; the flake it caused was "unknown stash id", not a find bug.
        with_test_dir("find", || {
            let text: String = (0..300)
                .map(|i| {
                    if (i + 1) % 6 == 0 {
                        format!("entry {} ERROR request failed with a long explanatory tail that pads the window bytes", i + 1)
                    } else {
                        format!("entry {} quiet routine heartbeat line with a long explanatory tail that pads the window", i + 1)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let (id, _o) = stash_text(&text).unwrap();
            let got = fetch_slice(&id, None, None, Some("ERROR request failed"), 32).unwrap();
            assert!(got.starts_with("\u{b7}find\u{b7} "));
            assert!(got.contains(" windows"));
        })
    }

}
