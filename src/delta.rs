//! Delta between runs (mirror of src/delta.ts): the same normalised command in
//! the same cwd ran before in this stash -> lead with what CHANGED (new and fixed
//! failures, changed counts, exit code) and replace the blocks identical to that
//! run by a pointer. The caller stashes the full capture.

use crate::distill::truncate_chars;
use crate::{sha256, stash};
use regex::{Captures, Regex};
use std::collections::HashSet;
use std::sync::LazyLock;

/// Runs below this many chars are not worth a delta block unless the command
/// already has a recorded run.
pub const DELTA_MIN: usize = 400;
/// A block of at least this many lines is collapsed when the previous run had it.
const BLOCK_MIN: usize = 3;
const ITEM_CAP: usize = 10;
const COUNT_CAP: usize = 5;
const ITEM_CHARS: usize = 160;

static RE_ENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

/// Same command = same argv (after leading `VAR=value` words) in the same cwd.
pub fn run_key(cmd: &[String], cwd: &str) -> String {
    let mut i = 0;
    while i + 1 < cmd.len() && RE_ENV_ASSIGN.is_match(&cmd[i]) {
        i += 1;
    }
    let mut id = sha256::hex(format!("{cwd}\0{}", cmd[i..].join("\0")).as_bytes());
    id.truncate(12);
    id
}

/// The last recorded run of `key`: (id, exit code, capture). Read-only; None on
/// any IO or shape problem.
pub fn previous_run(key: &str) -> Option<(String, i32, String)> {
    let raw = std::fs::read_to_string(stash::stash_dir().join("runs").join(key)).ok()?;
    let (id, code) = raw.strip_suffix('\n').unwrap_or(&raw).split_once(' ')?;
    let shaped = id.len() == 12 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let code: i32 = code.parse().ok().filter(|_| shaped)?;
    let text = stash::stash_read(id)?;
    Some((id.to_string(), code, text))
}

/// Remember `id` (a stashed capture) as the last run of `key`. Best effort.
pub fn record_run(key: &str, id: &str, code: i32) {
    use std::io::Write as _;
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    let dir = stash::stash_dir().join("runs");
    if std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(dir.join(key))
    {
        let _ = writeln!(f, "{id} {code}");
    }
}

static RE_TS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?").unwrap()
});
static RE_PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([0-9]{4,}\)").unwrap());
static RE_DUR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9_.])[0-9]+(?:\.[0-9]+)?(?:ns|µs|μs|us|ms|s)([^A-Za-z0-9_]|$)").unwrap()
});
static RE_DUR_MS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"duration_ms [0-9.]+").unwrap());
static RE_HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"0x[0-9a-f]{6,}").unwrap());
static RE_COUNT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]+ (?:passed|failed|passing|failing|pass|fail|skipped|ignored|pending|todo|cancelled|tests?|suites?|warnings?|errors?|total)(?:[^A-Za-z0-9_]|$)|(?:^|[^A-Za-z0-9_])(?:tests|suites|pass|fail|skipped|cancelled|todo|passed|failed) [0-9]+(?:[^0-9.]|$)").unwrap()
});
static RE_FAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^A-Za-z0-9_])(?:FAILED|FAIL|ERROR|not ok)(?:[^A-Za-z0-9_]|$)|^ *error\[[A-Za-z0-9]+\]:|error TS[0-9]+|[✖✕✗]").unwrap()
});

/// Tokens that differ on every run of an unchanged command (timestamps, thread
/// and process ids, durations, addresses) are masked; two lines equal after
/// this are "the same line".
fn norm(line: &str) -> String {
    let s = RE_TS.replace_all(line.trim(), "<ts>");
    let s = RE_PID.replace_all(&s, "(#)");
    let mut s = s.into_owned();
    // twice: "1s 2s" - the first match consumes the space the second one needs
    for _ in 0..2 {
        s = RE_DUR
            .replace_all(&s, |c: &Captures| format!("{}<t>{}", &c[1], &c[2]))
            .into_owned();
    }
    let s = RE_DUR_MS.replace_all(&s, "duration_ms <n>");
    RE_HEX.replace_all(&s, "0x#").into_owned()
}

type Items = Vec<(String, String)>;

/// normalised line -> first original (trimmed), for failure lines and count lines.
fn classify(lines: &[&str]) -> (Items, Items) {
    let (mut fail, mut count): (Items, Items) = (Vec::new(), Vec::new());
    let (mut fail_seen, mut count_seen) = (HashSet::new(), HashSet::new());
    for l in lines {
        let n = norm(l);
        if n.is_empty() {
            continue;
        }
        let (into, seen) = if RE_COUNT.is_match(&n) {
            (&mut count, &mut count_seen)
        } else if RE_FAIL.is_match(&n) {
            (&mut fail, &mut fail_seen)
        } else {
            continue;
        };
        if seen.insert(n.clone()) {
            into.push((n, l.trim().to_string()));
        }
    }
    (fail, count)
}

/// Originals of the items in `a` that `b` does not have.
fn gone<'a>(a: &'a Items, b: &Items) -> Vec<&'a str> {
    let have: HashSet<&str> = b.iter().map(|(k, _)| k.as_str()).collect();
    a.iter().filter(|(k, _)| !have.contains(k.as_str())).map(|(_, v)| v.as_str()).collect()
}

fn diff_list(label: &str, items: &[&str], cap: usize) -> Vec<String> {
    let mut out: Vec<String> = items
        .iter()
        .take(cap)
        .map(|s| format!("{label}: {}", truncate_chars(s, ITEM_CHARS)))
        .collect();
    if items.len() > cap {
        out.push(format!("{label}: ... {} more", items.len() - cap));
    }
    out
}

pub struct Delta {
    /// lines that lead the routed output
    pub head: Vec<String>,
    /// the current crushed text with identical blocks replaced by pointers
    pub body: String,
    /// true when any block or the whole output was replaced by a pointer
    pub collapsed: bool,
}

/// Runs of non-blank lines as half-open index ranges.
fn blocks(ls: &[&str]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < ls.len() {
        if ls[i].trim().is_empty() {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < ls.len() && !ls[j].trim().is_empty() {
            j += 1;
        }
        out.push((i, j));
        i = j;
    }
    out
}

/// Blocks compare as sets of normalised lines: parallel test runners print the
/// same lines in a different order.
fn block_key(b: &[&str]) -> String {
    let mut n: Vec<String> = b.iter().map(|l| norm(l)).collect();
    n.sort();
    n.join("\n")
}

/// Compare this run with the previous one. `prev_text` and `cur_text` are the
/// CRUSHED outputs; `prev_lines` is the line count of the previous raw capture,
/// the number the pointer quotes.
pub fn diff_runs(
    prev_id: &str,
    prev_code: i32,
    prev_text: &str,
    prev_lines: usize,
    cur_text: &str,
    cur_code: i32,
) -> Delta {
    let pl: Vec<&str> = prev_text.split('\n').collect();
    let cl: Vec<&str> = cur_text.split('\n').collect();
    let exit = if prev_code == cur_code {
        format!("exit {cur_code} (same)")
    } else {
        format!("exit {prev_code} -> {cur_code}")
    };
    let at = format!("[tanuki delta] vs previous run {prev_id} · {exit}");
    let mut pn: Vec<String> = pl.iter().map(|l| norm(l)).collect();
    let mut cn: Vec<String> = cl.iter().map(|l| norm(l)).collect();
    pn.sort();
    cn.sort();
    if pn == cn {
        return Delta {
            head: vec![format!("{at} · output identical")],
            body: format!("(same as previous run: {prev_lines} lines, fetch id {prev_id})"),
            collapsed: true,
        };
    }
    let (pf, pc) = classify(&pl);
    let (cf, cc) = classify(&cl);
    let fixed = gone(&pf, &cf);
    let fresh = gone(&cf, &pf);
    let mut head = vec![format!("{at} · {} fixed · {} new", fixed.len(), fresh.len())];
    head.extend(diff_list("fixed", &fixed, ITEM_CAP));
    head.extend(diff_list("new", &fresh, ITEM_CAP));
    head.extend(diff_list("was", &gone(&pc, &cc), COUNT_CAP));
    head.extend(diff_list("now", &gone(&cc, &pc), COUNT_CAP));

    let seen: HashSet<String> = blocks(&pl)
        .into_iter()
        .filter(|(a, b)| b - a >= BLOCK_MIN)
        .map(|(a, b)| block_key(&pl[a..b]))
        .collect();
    let mut body: Vec<String> = Vec::new();
    let mut at2 = 0;
    let mut collapsed = false;
    for (a, b) in blocks(&cl) {
        body.extend(cl[at2..a].iter().map(|s| (*s).to_string()));
        if b - a >= BLOCK_MIN && seen.contains(&block_key(&cl[a..b])) {
            body.push(format!("(same as previous run: {} lines, fetch id {prev_id})", b - a));
            collapsed = true;
        } else {
            body.extend(cl[a..b].iter().map(|s| (*s).to_string()));
        }
        at2 = b;
    }
    body.extend(cl[at2..].iter().map(|s| (*s).to_string()));
    Delta { head, body: body.join("\n"), collapsed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crush::crush_output;

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_string()).collect()
    }

    const FAIL1: &str = include_str!("../tests/fixtures/crush/cargo-test-fail-1.log");
    const FAIL2: &str = include_str!("../tests/fixtures/crush/cargo-test-fail-2.log");

    fn lines(t: &str) -> usize {
        t.split('\n').count()
    }

    #[test]
    fn norm_masks_the_run_dependent_tokens() {
        assert_eq!(norm("2026-09-30T10:11:12Z ok"), "<ts> ok");
        assert_eq!(norm("2026-09-30 10:11:12.345+02:00 ok"), "<ts> ok");
        assert_eq!(norm("thread 'a' (487013) panicked"), "thread 'a' (#) panicked");
        assert_eq!(norm("✔ creates a sku (0.482998ms)"), "✔ creates a sku (<t>)");
        assert_eq!(norm("finished in 1.2s"), "finished in <t>");
        assert_eq!(norm("a 1s 2s b"), "a <t> <t> b");
        assert_eq!(norm("duration_ms 12.5 end"), "duration_ms <n> end");
        assert_eq!(norm("ptr 0xdeadbeef01 x"), "ptr 0x# x");
        // short ids, words ending in s, and version-like tokens are data, not noise
        assert_eq!(norm("(123) items tests v1.2s3"), "(123) items tests v1.2s3");
    }

    #[test]
    fn run_key_ignores_env_words_but_not_cwd_or_argv() {
        let a = run_key(&sv(&["FOO=1", "cargo", "test"]), "/w");
        assert_eq!(a, run_key(&sv(&["cargo", "test"]), "/w"));
        assert_eq!(a, run_key(&sv(&["FOO=1", "BAR=2", "cargo", "test"]), "/w"));
        assert_eq!(a.len(), 12);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, run_key(&sv(&["cargo", "test"]), "/other"));
        assert_ne!(a, run_key(&sv(&["cargo", "build"]), "/w"));
    }

    #[test]
    fn cargo_pair_reports_fixed_new_and_collapses_the_persistent_failure() {
        let cmd = sv(&["cargo", "test"]);
        let before = crush_output(&cmd, FAIL1, 101).text;
        let after = crush_output(&cmd, FAIL2, 101).text;
        let d = diff_runs("0123456789ab", 101, &before, lines(FAIL1), &after, 101);
        assert!(d.head[0].contains("exit 101 (same)"), "{:?}", d.head);
        assert!(d.head[0].ends_with("1 fixed · 1 new"), "{:?}", d.head);
        assert!(d.head.contains(&"fixed: test tests::fee_never_negative ... FAILED".to_string()), "{:?}", d.head);
        assert!(d.head.contains(&"new: test tests::interest_compounds_yearly ... FAILED".to_string()), "{:?}", d.head);
        // the failure both runs have is in neither list, though its thread id changed
        assert!(!d.head.iter().any(|h| h.contains("parse_handles_whitespace")), "{:?}", d.head);
        assert!(d.collapsed);
        assert!(d.body.contains("(same as previous run: 4 lines, fetch id 0123456789ab)"), "{}", d.body);
        // and its detail block is gone from the body, while the changed one stays
        assert!(!d.body.contains("invalid digit found in string"), "{}", d.body);
        assert!(d.body.contains("left: 110000"), "{}", d.body);
    }

    #[test]
    fn npm_pair_is_identical_and_points_at_the_previous_run() {
        let (a, b) = (
            include_str!("../tests/fixtures/crush/npm-test-1.log"),
            include_str!("../tests/fixtures/crush/npm-test-2.log"),
        );
        assert_ne!(a, b, "the fixture pair must differ in durations only");
        let cmd = sv(&["npm", "test"]);
        let d = diff_runs("abcabcabcabc", 0, &crush_output(&cmd, a, 0).text, lines(a), &crush_output(&cmd, b, 0).text, 0);
        assert_eq!(d.head.len(), 1);
        assert!(d.head[0].contains("exit 0 (same) · output identical"), "{:?}", d.head);
        assert_eq!(d.body, format!("(same as previous run: {} lines, fetch id abcabcabcabc)", lines(a)));
        assert!(d.collapsed);
    }

    #[test]
    fn exit_code_change_is_named_in_the_header() {
        let d = diff_runs("aaaaaaaaaaaa", 101, "test x ... FAILED\nother", 2, "all fine\nother", 0);
        assert!(d.head[0].contains("exit 101 -> 0"), "{:?}", d.head);
        assert!(d.head[0].ends_with("1 fixed · 0 new"), "{:?}", d.head);
    }

    #[test]
    fn fixed_items_are_capped_at_ten_plus_a_count_line() {
        let prev: Vec<String> = (0..12).map(|i| format!("test case_{i:02} ... FAILED")).collect();
        let d = diff_runs("bbbbbbbbbbbb", 1, &prev.join("\n"), 12, "everything is fine now", 0);
        assert!(d.head[0].ends_with("12 fixed · 0 new"), "{:?}", d.head);
        assert_eq!(d.head.len(), 1 + 10 + 1, "{:?}", d.head);
        assert_eq!(d.head[1], "fixed: test case_00 ... FAILED");
        assert_eq!(d.head[10], "fixed: test case_09 ... FAILED");
        assert_eq!(d.head[11], "fixed: ... 2 more");
        assert!(!d.head.iter().any(|h| h.contains("case_10")));
    }

    #[test]
    fn changed_counts_are_listed_as_was_and_now() {
        let d = diff_runs("cccccccccccc", 0, "5 passed\nx", 2, "6 passed\ny", 0);
        assert!(d.head.contains(&"was: 5 passed".to_string()), "{:?}", d.head);
        assert!(d.head.contains(&"now: 6 passed".to_string()), "{:?}", d.head);
    }

    #[test]
    fn only_blocks_of_three_lines_collapse() {
        let prev = "a1\na2\n\nb1\nb2\nb3\n\nend 1";
        let cur = "a1\na2\n\nb1\nb2\nb3\n\nend 2";
        let d = diff_runs("dddddddddddd", 0, prev, 8, cur, 0);
        assert_eq!(d.body, "a1\na2\n\n(same as previous run: 3 lines, fetch id dddddddddddd)\n\nend 2");
    }
}
