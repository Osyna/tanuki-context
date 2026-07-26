//! Stage 0: log/output distillation (port of pxpipe mcp/distill.mjs).
//!
//! pass 1: collapse CONSECUTIVE repetitions of 1..MAX_CYCLE-line blocks
//!         (masked comparison) into the first block + "[×N similar]"
//! pass 2: global near-dupe suppression — exact masked key, then a coarse
//!         template key (non-alpha tokens -> <v>); exact counts in a summary
//! pass 3: optional query — matching lines ±context + important lines only
//! Error/warn/fail/exception lines are ALWAYS kept verbatim.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").unwrap());
// ASCII boundaries/classes throughout: matches JS regex semantics (\b, \d, \w are
// ASCII there) and is dramatically faster than the crate's Unicode-aware defaults.
static IMPORTANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)([0-9A-Za-z_]*(error|exception)s?|err|warn(ing)?s?|fail(s|ed|ure|ures)?|panic(s|ked)?|fatal|critical|traceback|denied|refused|timeouts?|timed.?out|assert(s|ed|ion|ions)?|segfault(s|ed)?)(?-u:\b)").unwrap()
});
static M_TS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?").unwrap()
});
static M_TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)[0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(?-u:\b)").unwrap()
});
static M_UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?-u:\b)")
        .unwrap()
});
static M_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)[0-9a-f]{7,64}(?-u:\b)").unwrap());
static M_NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)[0-9]+(\.[0-9]+)?[ \t\u{a0}]?(ms|us|µs|ns|s|m|h|%|[KMGT]i?B)?(?-u:\b)")
        .unwrap()
});

const MIN_RUN: usize = 3;
const MAX_CYCLE: usize = 8;
const KEEP_FIRST: usize = 2;
const TOP_CAP: usize = 40;

/// Mask volatile tokens so "same event, different timestamp" compares equal.
fn mask_line(l: &str) -> String {
    let s = M_TS.replace_all(l, "<ts>");
    let s = M_TIME.replace_all(&s, "<time>");
    let s = M_UUID.replace_all(&s, "<uuid>");
    let s = M_HEX.replace_all(&s, "<hex>");
    M_NUM.replace_all(&s, "<n>").into_owned()
}

/// Coarse template: non-alpha tokens -> <v> (groups "same event, different path").
/// Mirrors the JS reference exactly: `split(/\s+/)` yields a leading/trailing
/// EMPTY token on leading/trailing whitespace, which maps to `<v>` — so an
/// indented line and its unindented twin get DIFFERENT templates there too.
fn coarse_key(masked: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if masked.chars().next().is_some_and(char::is_whitespace) {
        parts.push("<v>");
    }
    for t in masked.split_whitespace() {
        parts.push(
            if !t.is_empty() && t.chars().all(|c| c.is_ascii_alphabetic()) {
                t
            } else {
                "<v>"
            },
        );
    }
    if masked.trim().len() < masked.trim_start().len() {
        parts.push("<v>"); // trailing whitespace -> trailing empty token in JS
    }
    parts.join(" ")
}

pub(crate) fn truncate_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

pub struct Distilled {
    pub distilled: String,
    pub stats: Value,
}

pub fn distill_log(text: &str, query: Option<&str>, context: usize) -> Distilled {
    let clean = ANSI.replace_all(text, "");
    let lines: Vec<&str> = clean.split('\n').collect();
    let orig_lines = lines.len();
    let masked: Vec<String> = lines.iter().map(|l| mask_line(l)).collect();
    let important: Vec<bool> = lines.iter().map(|l| IMPORTANT.is_match(l)).collect();
    let important_kept = important.iter().filter(|&&b| b).count();

    // pass 1: consecutive repetitions of near-identical blocks (chronology kept)
    let mut out: Vec<String> = Vec::with_capacity(lines.len() / 2);
    let mut collapsed_runs = 0usize;
    let mut i = 0usize;
    while i < lines.len() {
        let mut best_k = 0usize;
        let mut best_r = 0usize;
        let mut k = 1usize;
        while k <= MAX_CYCLE && i + 2 * k <= lines.len() {
            if important[i + k - 1] {
                break; // block would contain an error/warn line — never collapse
            }
            let mut r = 1usize;
            'reps: loop {
                let s = i + r * k;
                if s + k > lines.len() {
                    break;
                }
                for j in 0..k {
                    if important[s + j] || masked[s + j] != masked[i + j] {
                        break 'reps;
                    }
                }
                r += 1;
            }
            if r >= MIN_RUN && k * (r - 1) > best_k * best_r.saturating_sub(1) {
                best_k = k;
                best_r = r;
            }
            k += 1;
        }
        if best_k > 0 {
            for line in lines.iter().skip(i).take(best_k) {
                out.push((*line).to_string());
            }
            out.push(if best_k == 1 {
                format!("   [×{best_r} similar]")
            } else {
                format!("   [×{best_r} similar {best_k}-line blocks]")
            });
            collapsed_runs += 1;
            i += best_k * best_r;
        } else {
            out.push(lines[i].to_string());
            i += 1;
        }
    }

    // pass 2: global near-dupe suppression (exact masked key, then coarse template)
    // `ord` = insertion index: std HashMap iteration order is per-process
    // random, which fed the stable sort below random tie order (the summary
    // came out in a different order on every run). The TS engine's Map
    // iterates in insertion order; mirror that exactly.
    struct Entry {
        count: usize,
        ord: usize,
        exemplar: String,
    }
    let mut seen: HashMap<String, Entry> = HashMap::new();
    let mut coarse_seen: HashMap<String, Entry> = HashMap::new();
    let coarse_keep = KEEP_FIRST + 1;
    let mut pass2: Vec<String> = Vec::with_capacity(out.len());
    let mut suppressed = 0usize;
    let mut template_suppressed = 0usize;
    for l in out {
        if IMPORTANT.is_match(&l)
            || l.trim_start().starts_with("[×")
            || l.trim().chars().count() < 4
        {
            pass2.push(l);
            continue;
        }
        let key = mask_line(&l);
        if let Some(e) = seen.get_mut(&key) {
            e.count += 1;
            if e.count <= KEEP_FIRST {
                pass2.push(l);
            } else {
                suppressed += 1;
            }
            continue;
        }
        let ck = coarse_key(&key);
        seen.insert(
            key,
            Entry {
                count: 1,
                ord: seen.len(),
                exemplar: l.clone(),
            },
        );
        if let Some(c) = coarse_seen.get_mut(&ck) {
            c.count += 1;
            if c.count <= coarse_keep {
                pass2.push(l);
            } else {
                template_suppressed += 1;
            }
        } else {
            coarse_seen.insert(
                ck,
                Entry {
                    count: 1,
                    ord: coarse_seen.len(),
                    exemplar: l.clone(),
                },
            );
            pass2.push(l);
        }
    }
    let mut exact: Vec<&Entry> = seen.values().filter(|e| e.count > KEEP_FIRST).collect();
    exact.sort_by_key(|e| e.ord);
    let mut templ: Vec<&Entry> = coarse_seen.values().filter(|e| e.count > coarse_keep).collect();
    templ.sort_by_key(|e| e.ord);
    let mut top: Vec<(usize, &str, &str)> = exact
        .iter()
        .map(|e| (e.count, "exact", e.exemplar.as_str()))
        .chain(templ.iter().map(|e| (e.count, "template", e.exemplar.as_str())))
        .collect();
    top.sort_by_key(|e| std::cmp::Reverse(e.0)); // stable: ties keep first-seen order, exact before template
    top.truncate(TOP_CAP);
    if suppressed + template_suppressed > 0 {
        pass2.push(format!(
            "── {} repeated lines suppressed ({suppressed} exact ×N, {template_suppressed} same-template; first occurrences kept above) ──",
            suppressed + template_suppressed
        ));
        for (count, kind, exemplar) in &top {
            let tag = if *kind == "template" {
                " (template)"
            } else {
                ""
            };
            pass2.push(format!(
                "  ×{count}{tag}  {}",
                truncate_chars(exemplar.trim(), 160)
            ));
        }
    }

    // pass 3: optional query filter
    let final_lines: Vec<String> = if let Some(q) = query {
        let re = Regex::new(&format!("(?i){q}"))
            .unwrap_or_else(|_| Regex::new(&format!("(?i){}", regex::escape(q))).unwrap());
        let mut keep = vec![false; pass2.len()];
        for (idx, l) in pass2.iter().enumerate() {
            if re.is_match(l) || IMPORTANT.is_match(l) {
                let lo = idx.saturating_sub(context);
                let hi = (idx + context).min(pass2.len() - 1);
                for k in keep.iter_mut().take(hi + 1).skip(lo) {
                    *k = true;
                }
            }
        }
        let mut f = Vec::new();
        let mut omitted = 0usize;
        for (idx, l) in pass2.into_iter().enumerate() {
            if keep[idx] {
                if omitted > 0 {
                    f.push(format!("… {omitted} lines omitted"));
                    omitted = 0;
                }
                f.push(l);
            } else {
                omitted += 1;
            }
        }
        if omitted > 0 {
            f.push(format!("… {omitted} lines omitted"));
        }
        f
    } else {
        pass2
    };

    let distilled = final_lines.join("\n");
    let saved_pct = if text.is_empty() {
        0
    } else {
        ((1.0 - distilled.len() as f64 / text.len() as f64) * 100.0).round() as i64
    };
    let top_repeats: Vec<Value> = top
        .iter()
        .map(|(count, kind, exemplar)| {
            json!({ "kind": kind, "count": count, "exemplar": truncate_chars(exemplar.trim(), 160) })
        })
        .collect();
    let stats = json!({
        "origLines": orig_lines,
        "outLines": final_lines.len(),
        "origChars": text.len(),
        "outChars": distilled.len(),
        "savedPct": saved_pct,
        "collapsedRuns": collapsed_runs,
        "suppressedLines": suppressed,
        "templateSuppressed": template_suppressed,
        "importantKept": important_kept,
        "topRepeats": top_repeats,
        "query": query,
    });
    Distilled { distilled, stats }
}

#[cfg(test)]
mod order_tests {
    use super::*;

    /// Two exact groups with equal counts (a tie for the stable sort): the
    /// summary must list them in first-seen order, and two fresh runs must
    /// agree byte-for-byte (each run builds new HashMaps with new RandomState,
    /// so this fails loudly if map iteration order ever leaks again).
    #[test]
    fn summary_tie_order_is_first_seen_and_deterministic() {
        let mut lines: Vec<String> = Vec::new();
        for i in 0..12u32 {
            let (a, b) = ((b'a' + (i as u8 * 2) % 26) as char, (b'a' + (i as u8 * 2 + 1) % 26) as char);
            lines.push("alpha service heartbeat ok".to_string());
            lines.push(format!("fill{a}{a} words differ here"));
            lines.push("beta worker checkpoint ok".to_string());
            lines.push(format!("fill{b}{b} words also differ"));
        }
        let text = lines.join("\n");
        let one = distill_log(&text, None, 2);
        let two = distill_log(&text, None, 2);
        assert_eq!(one.distilled, two.distilled, "distill must be deterministic");
        let tail = &one.distilled[one.distilled.find("repeated lines suppressed").expect("summary present")..];
        let alpha = tail.find("alpha service").expect("alpha group in summary");
        let beta = tail.find("beta worker").expect("beta group in summary");
        assert!(alpha < beta, "equal-count groups must keep first-seen order");
    }
}
