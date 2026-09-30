//! Run output crushing — rtk-style stdout reduction.
//! Generic pass (spinners, progress bars) + per-tool rules (cargo, npm, etc.)
//! to keep signal and drop the noise. Prior art: rtk-ai/rtk Apache-2.0.

use crate::delta;
use regex::Regex;
use std::sync::LazyLock;

pub struct Crushed {
    pub text: String,
    pub rule: Option<String>,
}

/// The `run` wrapper's answer for one command's output (mirror of crush.ts
/// `routeOutput`): crush, delta vs the previous run of the same command in
/// this stash, distill, and stash the untouched capture when it is too big to
/// hand back whole. `pointer` names how the caller fetches a stash back.
pub fn route_output(
    cmd: &[String],
    captured: &str,
    code: i32,
    query: Option<&str>,
    pointer: &dyn Fn(&str) -> String,
) -> String {
    let crushed = crush_output(cmd, captured, code);
    let mut stashed: Option<(String, String)> = None;
    let track = std::env::var("TANUKI_DELTA").as_deref() != Ok("off") && !cmd.is_empty();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let key = if track { delta::run_key(cmd, &cwd) } else { String::new() };
    let prev = if track { delta::previous_run(&key) } else { None };
    let delta = prev.as_ref().map(|(id, pcode, ptext)| {
        let before = crush_output(cmd, ptext, *pcode).text;
        delta::diff_runs(id, *pcode, &before, ptext.split('\n').count(), &crushed.text, code)
    });
    if track && (prev.is_some() || captured.chars().count() >= delta::DELTA_MIN) {
        if let Ok(s) = crate::stash::stash_text(captured) {
            delta::record_run(&key, &s.0, code);
            stashed = Some(s);
        }
    }
    let head: &[String] = match &delta {
        Some(d) => &d.head,
        None => &[],
    };
    // split('\n').count(), not lines().count(): TS split("\n").length counts
    // the trailing empty segment and this header must match it.
    let captured_lines = captured.split('\n').count();
    let stash_of = |stashed: &mut Option<(String, String)>| -> (String, String) {
        stashed
            .get_or_insert_with(|| crate::stash::stash_text(captured).expect("write stash"))
            .clone()
    };
    let mut compose = |c: &Crushed, body: Option<&str>, map_only: bool, view: Option<(&str, &str)>| -> String {
        let (distilled, dist_lines) = {
            let d = crate::distill::distill_log(body.unwrap_or(c.text.as_str()), query, 2);
            (d.distilled, d.stats["outLines"].as_u64().unwrap_or(0))
        };
        let shown = head.iter().map(String::as_str).chain([distilled.as_str()]).collect::<Vec<_>>().join("\n");
        let saved_pct = crate::pct(captured.chars().count() as u64, shown.chars().count() as u64);
        let out_lines = dist_lines + head.len() as u64;
        let mut header = format!("[tanuki run] exit {code} · {captured_lines} -> {out_lines} lines · {saved_pct}% of chars removed");
        if let Some(rule) = &c.rule {
            header.push_str(&format!(" · rule {rule}"));
        }
        let mut lines = vec![header];
        // ponytail: fixed 8000-char inline budget (~2k tokens); make it a knob
        // if real usage ever wants one.
        if !map_only && (distilled.chars().count() <= crate::RUN_INLINE_MAX || captured.chars().count() <= crate::RUN_INLINE_MAX) {
            lines.push(shown);
            if captured.chars().count() > crate::RUN_INLINE_MAX || delta.as_ref().is_some_and(|d| d.collapsed) {
                lines.push(pointer(&stash_of(&mut stashed).0));
            }
        } else {
            lines.extend(head.iter().cloned());
            lines.push(crate::stash::stash_text_view(captured, view).expect("write stash").1);
        }
        lines.join("\n")
    };
    let finish = |answer: String| finish_row(captured, crushed.rule.as_deref(), answer);
    let body = delta.as_ref().map(|d| d.body.as_str());
    let out = compose(&crushed, body, false, None);
    if !crushed.rule.as_deref().is_some_and(|r| r.contains("managedfields")) {
        return finish(out);
    }
    // Dropping managedFields makes a document readable inline, but a larger
    // answer than the run wrapper gave before that rule existed is a
    // regression: then it is the map, described from the cleaned document.
    let before = compose(&crush_output_with(cmd, captured, code, false), None, false, None);
    if out.chars().count() <= before.chars().count() {
        return finish(out);
    }
    finish(compose(&crushed, body, true, Some((crushed.text.as_str(), "managedFields dropped"))))
}

/// Every answer that points at (or maps) the stash is a ledger row: the
/// tokens it saved now, so a later fetch can be charged against them.
fn finish_row(captured: &str, rule: Option<&str>, answer: String) -> String {
    let id = crate::stash::stash_id(captured);
    if answer.contains(&id) {
        let saved = crate::text_tokens(captured) as i64 - crate::text_tokens(&answer) as i64;
        crate::ledger::log_stash(&id, rule.unwrap_or("distill"), saved);
    }
    answer
}

// Spinner chars from Unicode Braille Patterns block
static SPINNER_CHARS: &str = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

static RE_SPINNER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{} \t]*$", regex::escape(SPINNER_CHARS))).unwrap()
});
static RE_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*[\[(]?[0-9]{1,3}%[\])]?\s*$").unwrap()
});

// cargo
static RE_CARGO_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(Compiling|Downloading|Downloaded|Checking|Fresh|Updating|Locking|Adding|Removing|Installing|Installed|Building|Blocking|Running) ").unwrap()
});
static RE_CARGO_FINISHED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*Finished ").unwrap()
});
static RE_CARGO_SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"test result:|^warning").unwrap()
});

// npm/pnpm/yarn/bun
static RE_NPM_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^npm (WARN|notice) |^> ").unwrap()
});
static RE_NPM_SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(added|removed|changed|up to date|audited|found [0-9]+ vulnerabilit|[0-9]+ vulnerabilit|Done in|[0-9]+ packages? installed)").unwrap()
});

// pytest
static RE_PYTEST_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[.FEsxX]{4,}$").unwrap()
});
static RE_PYTEST_SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^=+ .* =+$").unwrap()
});

// go test
static RE_GO_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^=== (RUN|PAUSE|CONT) ").unwrap()
});
static RE_GO_SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(ok|PASS)\b").unwrap()
});

// git status
static RE_GIT_STATUS_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*\(use "git .*\)$"#).unwrap()
});

// git diff/show
static RE_GIT_DIFF_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(diff --git|index |--- |\+\+\+ |@@ )").unwrap()
});

// eslint
static RE_ESLINT_SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(✖|.*problems? \()").unwrap()
});

fn basename(path: &str) -> &str {
    path.rsplit('/').next()
        .unwrap_or(path)
        .rsplit('\\').next()
        .unwrap_or(path)
        .strip_suffix(".exe")
        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path).rsplit('\\').next().unwrap_or(path))
}

/// Generic pass: drop \r-wrapped lines, spinners, and progress bars.
fn generic_pass(text: &str) -> (String, bool) {
    let mut lines = Vec::new();
    let mut changed = false;

    for line in text.split('\n') {
        // Take substring after last \r
        let clean = if line.contains('\r') {
            changed = true;
            line.rsplit('\r').next().unwrap_or("")
        } else {
            line
        };

        // Drop spinner-only lines (must contain at least one spinner char)
        if SPINNER_CHARS.chars().any(|c| clean.contains(c)) && RE_SPINNER.is_match(clean) {
            changed = true;
            continue;
        }

        // Drop bare progress lines
        if RE_PROGRESS.is_match(clean) {
            changed = true;
            continue;
        }

        lines.push(clean);
    }

    (lines.join("\n"), changed)
}

/// Apply one content rule to `text`; `f` sees the lines and returns the
/// replacement lines when it fires. The rule name chains onto an earlier one.
fn content_step(
    text: &mut String,
    rule: &mut Option<String>,
    name: &str,
    f: impl FnOnce(&[&str]) -> Option<Vec<String>>,
) {
    let r = {
        let lines: Vec<&str> = text.split('\n').collect();
        f(&lines)
    };
    if let Some(r) = r {
        *text = r.join("\n");
        *rule = Some(match rule.take() {
            None => name.to_string(),
            Some(p) => format!("{p}+{name}"),
        });
    }
}

/// Mirror of serde.ts `stripJsonSpace`: ASCII whitespace outside strings goes,
/// every byte inside a string stays. `t` must be valid JSON.
fn strip_json_space(t: &str) -> String {
    let mut out = Vec::with_capacity(t.len());
    let (mut in_str, mut esc) = (false, false);
    for &c in t.as_bytes() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
            continue;
        }
        out.push(c);
    }
    // only ASCII bytes were removed, so the rest is still valid UTF-8
    String::from_utf8(out).unwrap_or_default()
}

/// NDJSON, lossless (mirror of crush.ts `ndjsonLines`): every JSON object/array
/// line loses the whitespace between its tokens. Fires when JSON lines are >= 3
/// and at least as many as all other non-blank lines.
fn ndjson_lines(lines: &[&str]) -> Option<Vec<String>> {
    let (mut json, mut other) = (0usize, 0usize);
    let out: Vec<String> = lines
        .iter()
        .map(|l| {
            let t = l.trim();
            if (t.starts_with('{') || t.starts_with('['))
                && serde_json::from_str::<serde_json::Value>(t).is_ok()
            {
                json += 1;
                return strip_json_space(t);
            }
            if !t.is_empty() {
                other += 1;
            }
            (*l).to_string()
        })
        .collect();
    (json >= 3 && json >= other).then_some(out)
}

static RE_MF_YAML: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^( *)managedFields: *$").unwrap());
static RE_MF_JSON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^( *)"managedFields": \[$"#).unwrap());

/// kubectl managedFields (mirror of crush.ts `dropManagedFields`): each block
/// becomes one marker line naming how many lines it replaced.
fn drop_managed_fields(lines: &[&str]) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut hit = false;
    let mut i = 0;
    while i < lines.len() {
        if let Some(c) = RE_MF_YAML.captures(lines[i]) {
            let ind = c[1].len();
            let mut j = i + 1;
            while j < lines.len() {
                let l = lines[j];
                let s = l.bytes().take_while(|&b| b == b' ').count();
                if s == l.len() || !(s > ind || (s == ind && l[s..].starts_with("- "))) {
                    break;
                }
                j += 1;
            }
            out.push(format!("{}managedFields: [] # {} lines dropped", &c[1], j - i));
            hit = true;
            i = j;
            continue;
        }
        if let Some(c) = RE_MF_JSON.captures(lines[i]) {
            let close = format!("{}]", &c[1]);
            let close_comma = format!("{close},");
            let mut k = i + 1;
            while k < lines.len() && lines[k] != close && lines[k] != close_comma {
                k += 1;
            }
            if k < lines.len() {
                let comma = if lines[k].ends_with(',') { "," } else { "" };
                out.push(format!("{}\"managedFields\": [\"... {} lines dropped\"]{comma}", &c[1], k - i + 1));
                hit = true;
                i = k + 1;
                continue;
            }
        }
        out.push(lines[i].to_string());
        i += 1;
    }
    hit.then_some(out)
}

static RE_ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
static RE_TF_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z](?:[^\s:\[]|\[[^\]]*\])*: (Refreshing state\.\.\.|Reading\.\.\.|Read complete after )").unwrap()
});

/// terraform progress (mirror of crush.ts `collapseTerraform`): the Refreshing
/// state / Reading / Read complete lines collapse into one count line at the
/// place of the first; every other line stays byte-exact.
fn collapse_terraform(lines: &[&str]) -> Option<Vec<String>> {
    let kinds = ["Refreshing state", "Reading", "Read complete"];
    let mut counts = [0usize; 3];
    let mut out: Vec<String> = Vec::new();
    let mut at: Option<usize> = None;
    for l in lines {
        let plain = RE_ANSI.replace_all(l, "");
        let Some(m) = RE_TF_PROGRESS.captures(&plain) else {
            out.push((*l).to_string());
            continue;
        };
        if at.is_none() {
            at = Some(out.len());
            out.push(String::new());
        }
        let k = &m[1];
        counts[if k.starts_with("Refreshing") { 0 } else if k.starts_with("Reading") { 1 } else { 2 }] += 1;
    }
    let n: usize = counts.iter().sum();
    if n < 3 {
        return None;
    }
    let parts: Vec<String> = kinds
        .iter()
        .zip(counts)
        .filter(|(_, c)| *c > 0)
        .map(|(k, c)| format!("{c} {k}"))
        .collect();
    out[at?] = format!("[terraform: {n} progress lines dropped: {}]", parts.join(", "));
    Some(out)
}

const TABLE_MIN_ROWS: usize = 3;

/// Column-aligned tables (mirror of crush.ts `tableTabs`): the padding between
/// columns becomes one TAB. Columns are runs of positions where some line has a
/// non-space, so a value is never split; a run with a blank header or only
/// empty data cells belongs to the previous column.
fn table_tabs(lines: &[&str]) -> Option<Vec<String>> {
    let mut end = lines.len();
    while end > 0 && lines[end - 1].is_empty() {
        end -= 1;
    }
    if end < 1 + TABLE_MIN_ROWS {
        return None;
    }
    let mut rows: Vec<Vec<char>> = Vec::with_capacity(end);
    let mut width = 0usize;
    let mut before = 0usize;
    for l in &lines[..end] {
        if l.is_empty() || l.starts_with(' ') || l.contains('\t') || l.trim().is_empty() {
            return None;
        }
        let cs: Vec<char> = l.chars().collect();
        width = width.max(cs.len());
        before += cs.len();
        rows.push(cs);
    }
    let mut gutter = vec![true; width];
    for r in &rows {
        for (p, c) in r.iter().enumerate() {
            if *c != ' ' {
                gutter[p] = false;
            }
        }
    }
    let cell = |r: &[char], from: usize, to: usize| -> String {
        let to = to.min(r.len());
        let from = from.min(to);
        r[from..to].iter().collect::<String>().trim_matches(' ').to_string()
    };
    let mut starts: Vec<usize> = Vec::new();
    let mut p = 0;
    while p < width {
        if gutter[p] {
            p += 1;
            continue;
        }
        let mut q = p;
        while q < width && !gutter[q] {
            q += 1;
        }
        if starts.is_empty()
            || (!cell(&rows[0], p, q).is_empty() && rows[1..].iter().any(|r| !cell(r, p, q).is_empty()))
        {
            starts.push(p);
        }
        p = q;
    }
    if starts.len() < 2 {
        return None;
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut after = 0usize;
    for r in &rows {
        let cells: Vec<String> = starts
            .iter()
            .enumerate()
            .map(|(c, s)| cell(r, *s, if c + 1 < starts.len() { starts[c + 1] } else { r.len() }))
            .collect();
        let row = cells.join("\t").trim_end_matches('\t').to_string();
        if row.is_empty() || row.starts_with('\t') {
            return None;
        }
        after += row.chars().count();
        out.push(row);
    }
    if before.saturating_sub(after) * 10 < before {
        return None;
    }
    out.extend(lines[end..].iter().map(|s| (*s).to_string()));
    Some(out)
}

pub fn crush_output(cmd: &[String], text: &str, exit_code: i32) -> Crushed {
    crush_output_with(cmd, text, exit_code, true)
}

/// `managed` = false skips the kubectl managedFields rule (the answer the run
/// wrapper gave before that rule existed, kept as the never-grow yardstick).
fn crush_output_with(cmd: &[String], text: &str, exit_code: i32, managed: bool) -> Crushed {
    if cmd.is_empty() {
        return Crushed { text: text.to_string(), rule: None };
    }

    let orig_chars = text.chars().count();
    let (after_generic, generic_changed) = generic_pass(text);

    let b = basename(&cmd[0]);
    let sub = cmd.get(1).map(String::as_str).unwrap_or("");

    // Rule pass
    let (after_rule, rule_name) = match (b, sub, exit_code) {
        // cargo: success elision on exit 0, noise drop on any exit
        ("cargo", _, _) => {
            let lines: Vec<&str> = after_generic.split('\n').collect();
            let drop_noise = |ls: &[&str]| -> Vec<String> {
                ls.iter()
                    .filter(|l| !RE_CARGO_NOISE.is_match(l) && !RE_CARGO_FINISHED.is_match(l))
                    .map(|l| (*l).to_string())
                    .collect()
            };
            if exit_code == 0 {
                let success: Vec<&str> =
                    lines.iter().copied().filter(|l| RE_CARGO_SUCCESS.is_match(l)).collect();
                if !success.is_empty() {
                    (success.join("\n"), Some("cargo"))
                } else {
                    let kept = drop_noise(&lines);
                    let changed = kept.len() != lines.len();
                    (kept.join("\n"), if changed { Some("cargo") } else { None })
                }
            } else {
                let kept = drop_noise(&lines);
                let changed = kept.len() != lines.len();
                (kept.join("\n"), if changed { Some("cargo") } else { None })
            }
        }

        // npm-install: success elision on exit 0, WARN/notice drop on any exit
        (b, s, _) if matches!(b, "npm" | "pnpm" | "yarn" | "bun")
                  && matches!(s, "install" | "i" | "add" | "ci" | "update" | "up") => {
            let lines: Vec<&str> = after_generic.split('\n').collect();
            if exit_code == 0 {
                let success: Vec<&str> =
                    lines.iter().copied().filter(|l| RE_NPM_SUCCESS.is_match(l)).collect();
                if !success.is_empty() {
                    (success.join("\n"), Some("npm-install"))
                } else {
                    let kept: Vec<&str> =
                        lines.iter().copied().filter(|l| !RE_NPM_NOISE.is_match(l)).collect();
                    (kept.join("\n"), if kept.len() != lines.len() { Some("npm-install") } else { None })
                }
            } else {
                let kept: Vec<&str> =
                    lines.iter().copied().filter(|l| !RE_NPM_NOISE.is_match(l)).collect();
                (kept.join("\n"), if kept.len() != lines.len() { Some("npm-install") } else { None })
            }
        }

        // pytest: dots-progress dropped at ANY exit, banner elision on exit 0
        (b, _, _) if matches!(b, "pytest" | "py.test") => {
            let mut lines: Vec<&str> = after_generic.split('\n').collect();
            let mut rule = None;
            let filtered: Vec<&str> =
                lines.iter().copied().filter(|l| !RE_PYTEST_NOISE.is_match(l)).collect();
            if filtered.len() != lines.len() {
                lines = filtered;
                rule = Some("pytest");
            }
            if exit_code == 0 {
                let success: Vec<&str> =
                    lines.iter().copied().filter(|l| RE_PYTEST_SUCCESS.is_match(l)).collect();
                if !success.is_empty() {
                    lines = success;
                    rule = Some("pytest");
                }
            }
            (lines.join("\n"), rule)
        }

        // go-test: RUN/PAUSE/CONT dropped at ANY exit, ok/PASS elision on exit 0
        ("go", "test", _) => {
            let mut lines: Vec<&str> = after_generic.split('\n').collect();
            let mut rule = None;
            let filtered: Vec<&str> =
                lines.iter().copied().filter(|l| !RE_GO_NOISE.is_match(l)).collect();
            if filtered.len() != lines.len() {
                lines = filtered;
                rule = Some("go-test");
            }
            if exit_code == 0 {
                let success: Vec<&str> =
                    lines.iter().copied().filter(|l| RE_GO_SUCCESS.is_match(l)).collect();
                if !success.is_empty() {
                    lines = success;
                    rule = Some("go-test");
                }
            }
            (lines.join("\n"), rule)
        }

        // git-status
        ("git", "status", _) => {
            let lines: Vec<&str> = after_generic.split('\n').collect();
            let kept: Vec<&str> = lines.iter()
                .copied()
                .filter(|l| !RE_GIT_STATUS_NOISE.is_match(l))
                .collect();
            (kept.join("\n"), if kept.len() < lines.len() { Some("git-status") } else { None })
        }

        // git-diff
        ("git", s, _) if matches!(s, "diff" | "show") => {
            let lines: Vec<&str> = after_generic.split('\n').collect();
            let total = lines.len();
            let mut out: Vec<String> = Vec::new();
            let mut in_hunk = false;
            let mut hunk_body: Vec<&str> = Vec::new();
            // Owned strings here: the truncation marker is synthesized, so the
            // buffer cannot borrow from the input.
            let mut flush = |out: &mut Vec<String>, hunk_body: &mut Vec<&str>| {
                if hunk_body.len() > 100 {
                    let truncated = hunk_body.len() - 100;
                    out.extend(hunk_body[..100].iter().map(|s| (*s).to_string()));
                    out.push(format!("[... {truncated} lines truncated]"));
                } else {
                    out.extend(hunk_body.iter().map(|s| (*s).to_string()));
                }
                hunk_body.clear();
            };
            for line in &lines {
                if RE_GIT_DIFF_HEADER.is_match(line) {
                    if in_hunk {
                        flush(&mut out, &mut hunk_body);
                    }
                    out.push((*line).to_string());
                    in_hunk = line.starts_with("@@ ");
                } else if in_hunk {
                    hunk_body.push(line);
                } else {
                    out.push((*line).to_string());
                }
            }
            if in_hunk {
                flush(&mut out, &mut hunk_body);
            }
            (out.join("\n"), if out.len() < total { Some("git-diff") } else { None })
        }

        // tsc
        ("tsc", _, _) => {
            let lines: Vec<&str> = after_generic.split('\n')
                .filter(|l| !l.trim().is_empty())
                .collect();
            (lines.join("\n"), if lines.len() < after_generic.split('\n').count() { Some("tsc") } else { None })
        }

        // eslint: blank lines dropped at ANY exit, summary elision on exit 0
        ("eslint", _, _) => {
            let mut lines: Vec<&str> = after_generic.split('\n').collect();
            let mut rule = None;
            let filtered: Vec<&str> =
                lines.iter().copied().filter(|l| !l.trim().is_empty()).collect();
            if filtered.len() != lines.len() {
                lines = filtered;
                rule = Some("eslint");
            }
            if exit_code == 0 {
                let success: Vec<&str> =
                    lines.iter().copied().filter(|l| RE_ESLINT_SUCCESS.is_match(l)).collect();
                if !success.is_empty() {
                    lines = success;
                    rule = Some("eslint");
                }
            }
            (lines.join("\n"), rule)
        }

        _ => (after_generic.clone(), None),
    };

    // Content rules: the shape of the output, not the command name. They chain
    // after a command rule ("cargo+ndjson"); mirror of crush.ts section 2b.
    let specific = rule_name.is_some();
    let mut after_rule = after_rule;
    let mut rule: Option<String> = rule_name.map(str::to_string);
    if managed && b == "kubectl" {
        content_step(&mut after_rule, &mut rule, "managedfields", drop_managed_fields);
    }
    if b == "terraform" || b == "tofu" {
        content_step(&mut after_rule, &mut rule, "terraform", collapse_terraform);
    }
    content_step(&mut after_rule, &mut rule, "ndjson", ndjson_lines);
    if !specific {
        content_step(&mut after_rule, &mut rule, "table", table_tabs);
    }
    if matches!(b, "ls" | "find" | "grep" | "rg" | "fd")
        || (b == "docker" && sub == "ps")
        || (b == "kubectl" && sub == "get")
    {
        // a document whose managedFields went is "everything else byte-exact", not a row list to cap
        let doc = rule.as_deref().is_some_and(|r| r.contains("managedfields"));
        content_step(&mut after_rule, &mut rule, "list-cap", |lines| {
            (lines.len() > 200 && !doc).then(|| {
                let mut out: Vec<String> = lines[..200].iter().map(|s| (*s).to_string()).collect();
                out.push(format!("[... {} more lines]", lines.len() - 200));
                out
            })
        });
    }

    // Empty/whitespace -> "ok"
    let final_text = if after_rule.trim().is_empty() {
        "ok".to_string()
    } else {
        after_rule
    };

    // never-worse guard
    let result_chars = final_text.chars().count();
    if result_chars >= orig_chars {
        return Crushed { text: text.to_string(), rule: None };
    }

    // Determine final rule name
    let final_rule = if rule.is_some() {
        rule
    } else if generic_changed {
        Some("generic".to_string())
    } else {
        None
    };

    Crushed { text: final_text, rule: final_rule }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cargo_success_elision() {
        let output = r#"   Compiling foo v0.1.0
   Compiling bar v0.2.0
    Checking baz v0.3.0
    Finished dev [unoptimized + debuginfo] target(s) in 2.34s
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
"#;
        let cmd = vec!["cargo".to_string(), "test".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
        assert_eq!(c.rule, Some("cargo".to_string()));
    }

    #[test]
    fn test_cargo_no_success_drops_noise() {
        let output = r#"   Compiling foo v0.1.0
   Checking bar v0.2.0
    Finished dev [unoptimized] target(s) in 1.2s
     Running target/debug/app
Server started
"#;
        let cmd = vec!["cargo".to_string(), "run".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert!(c.text.contains("Server started"));
        assert!(!c.text.contains("Compiling"));
        assert_eq!(c.rule, Some("cargo".to_string()));
    }

    #[test]
    fn test_npm_install_success() {
        let output = r#"npm WARN deprecated some-pkg@1.0.0
> postinstall script
added 42 packages in 3s
"#;
        let cmd = vec!["npm".to_string(), "install".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "added 42 packages in 3s");
        assert_eq!(c.rule, Some("npm-install".to_string()));
    }

    #[test]
    fn test_pytest_dots_removed() {
        let output = r#"......................
=== 22 passed in 1.2s ===
"#;
        let cmd = vec!["pytest".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "=== 22 passed in 1.2s ===");
        assert_eq!(c.rule, Some("pytest".to_string()));
    }

    #[test]
    fn test_go_test_success() {
        let output = r#"=== RUN   TestFoo
=== PAUSE TestFoo
=== CONT  TestFoo
ok  	example.com/pkg	0.123s
"#;
        let cmd = vec!["go".to_string(), "test".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text.trim(), "ok  	example.com/pkg	0.123s");
        assert_eq!(c.rule, Some("go-test".to_string()));
    }

    #[test]
    fn test_git_status_hint_removed() {
        let output = r#"On branch main
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   foo.txt
"#;
        let cmd = vec!["git".to_string(), "status".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert!(!c.text.contains("use \"git"));
        assert!(c.text.contains("modified:   foo.txt"));
        assert_eq!(c.rule, Some("git-status".to_string()));
    }

    #[test]
    fn test_git_diff_hunk_truncation() {
        let mut lines = vec!["diff --git a/foo.txt b/foo.txt", "index abc123..def456 100644", "--- a/foo.txt", "+++ b/foo.txt", "@@ -1,3 +1,3 @@"];
        for _i in 0..150 {
            lines.push(" context line");
        }
        let output = lines.join("\n");
        let cmd = vec!["git".to_string(), "diff".to_string()];
        let c = crush_output(&cmd, &output, 0);
        assert!(c.text.contains("[... 50 lines truncated]"));
        assert_eq!(c.rule, Some("git-diff".to_string()));
    }

    #[test]
    fn test_list_cap() {
        let mut lines = Vec::new();
        for i in 0..250 {
            lines.push(format!("file{}.txt", i));
        }
        let output = lines.join("\n");
        let cmd = vec!["ls".to_string()];
        let c = crush_output(&cmd, &output, 0);
        assert!(c.text.contains("[... 50 more lines]"));
        assert_eq!(c.rule, Some("list-cap".to_string()));
    }

    #[test]
    fn test_generic_spinner() {
        // Trailing "\n" survives as an empty final segment, exactly like the
        // TS split("\n") - .lines() would silently eat it and break parity.
        let output = "⠋  \n⠙  \nDone\n";
        let cmd = vec!["some-tool".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "Done\n");
        assert_eq!(c.rule, Some("generic".to_string()));
    }

    #[test]
    fn test_generic_progress() {
        let output = "Starting\n50%\n100%\nComplete\n";
        let cmd = vec!["another-tool".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "Starting\nComplete\n");
        assert_eq!(c.rule, Some("generic".to_string()));
    }

    #[test]
    fn test_generic_carriage_return() {
        let output = "Downloading\rDownloading: 10%\rDownloading: 100%\rDone\n";
        let cmd = vec!["dl".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "Done\n");
        assert_eq!(c.rule, Some("generic".to_string()));
    }

    #[test]
    fn test_empty_becomes_ok() {
        // Whitespace-only lines are not spinner/progress lines, so the
        // generic pass leaves them alone: the ok fallback fires with NO rule
        // attribution - identical to the TS engine.
        let output = "   \n\n  \n";
        let cmd = vec!["quiet-cmd".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "ok");
        assert_eq!(c.rule, None);
    }

    #[test]
    fn test_never_worse_guard() {
        let output = "short";
        let cmd = vec!["echo".to_string()];
        let c = crush_output(&cmd, output, 0);
        assert_eq!(c.text, "short");
        assert_eq!(c.rule, None);
    }

    #[test]
    fn test_exit_nonzero_keeps_errors() {
        let output = r#"   Compiling foo v0.1.0
error: expected `;`, found `}`
error: aborting due to previous error
"#;
        let cmd = vec!["cargo".to_string(), "build".to_string()];
        let c = crush_output(&cmd, output, 1);
        assert!(c.text.contains("error:"));
        // Non-zero exit -> no success elision, only noise removal
    }

    // ---- content rules: ndjson, table, managedFields, terraform ----

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_string()).collect()
    }

    fn json_lines(t: &str) -> Vec<serde_json::Value> {
        t.split('\n')
            .filter(|l| l.trim_start().starts_with('{'))
            .map(|l| serde_json::from_str(l.trim()).expect("json line"))
            .collect()
    }

    #[test]
    fn ndjson_fixture_is_lossless_and_chained() {
        let text = include_str!("../tests/fixtures/crush/cargo-test-json.log");
        let cmd = sv(&["cargo", "test", "--", "-Z", "unstable-options", "--format", "json", "--report-time"]);
        let c = crush_output(&cmd, text, 101);
        assert_eq!(c.rule.as_deref(), Some("cargo+ndjson"));
        assert!(c.text.len() < text.len());
        let (before, after) = (json_lines(text), json_lines(&c.text));
        assert!(before.len() >= 13, "fixture must carry many JSON lines");
        assert_eq!(before, after);
        assert!(c.text.split('\n').all(|l| !l.starts_with("{ ")), "{}", c.text);
        // planted strings survive byte-exact inside their JSON string
        assert!(c.text.contains("apply_fee(50, 200) >= 0"));
        assert!(c.text.contains("panicked at src/lib.rs:104:9"));
        assert!(c.text.contains(r#"left: Err(\"bad amount \\\"$ 7.00\\\": invalid digit found in string\")"#));
        assert!(c.text.contains(r#"right: Ok(700)"#));
    }

    #[test]
    fn ndjson_boundary_three_json_three_other_fires() {
        let text = "{ \"a\": 1 }\n{ \"a\": 2 }\n{ \"a\": 3 }\nx\ny\nz\n";
        let c = crush_output(&sv(&["somecmd"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("ndjson"));
        assert_eq!(c.text, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\nx\ny\nz\n");
    }

    #[test]
    fn ndjson_boundary_three_json_four_other_does_not_fire() {
        let text = "{ \"a\": 1 }\n{ \"a\": 2 }\n{ \"a\": 3 }\nw\nx\ny\nz\n";
        let c = crush_output(&sv(&["somecmd"]), text, 0);
        assert_eq!(c.rule, None);
        assert_eq!(c.text, text);
    }

    #[test]
    fn ndjson_keeps_inner_string_spaces() {
        let text = "{ \"k\": \"x   y\" }\n{ \"k\": \"p  q\" }\n[ 1,  2 ]\n";
        let c = crush_output(&sv(&["somecmd"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("ndjson"));
        assert_eq!(c.text, "{\"k\":\"x   y\"}\n{\"k\":\"p  q\"}\n[1,2]\n");
    }

    fn assert_table_lossless(cmd: &[&str], text: &str) -> String {
        let c = crush_output(&sv(cmd), text, 0);
        assert_eq!(c.rule.as_deref(), Some("table"), "{}", c.text);
        assert!(c.text.contains('\t'));
        let (a, b): (Vec<&str>, Vec<&str>) = (text.split('\n').collect(), c.text.split('\n').collect());
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.split_whitespace().collect::<Vec<_>>(), y.split_whitespace().collect::<Vec<_>>());
        }
        c.text
    }

    #[test]
    fn table_docker_ps_rows_stay_intact() {
        let text = include_str!("../tests/fixtures/crush/docker-ps.log");
        let out = assert_table_lossless(&["docker", "ps"], text);
        let row = out.split('\n').find(|l| l.starts_with("bcbd396ae96f")).unwrap();
        let cells: Vec<&str> = row.split('\t').collect();
        assert!(cells.contains(&"nginx:alpine"), "{cells:?}");
        assert!(cells.contains(&"todo-ui-1"), "{cells:?}");
    }

    #[test]
    fn table_ps_aux_keeps_command_whole() {
        let text = include_str!("../tests/fixtures/crush/ps-aux.log");
        let out = assert_table_lossless(&["ps", "aux"], text);
        let row = out.split('\n').find(|l| l.contains("8002")).unwrap();
        assert!(row.split('\t').any(|c| c == "python3 -m http.server 8002 --bind 127.0.0.1"), "{row:?}");
    }

    #[test]
    fn table_df_and_kubectl_get_pods() {
        assert_table_lossless(&["df", "-h"], include_str!("../tests/fixtures/crush/df-h.log"));
        let text = include_str!("../tests/fixtures/crush/kubectl-get-pods.log");
        let out = assert_table_lossless(&["kubectl", "get", "pods", "-A"], text);
        let row = out.split('\n').find(|l| l.starts_with("shop\tapi-69c5d8857d-5kvql")).unwrap();
        assert!(row.split('\t').any(|c| c == "ContainerCreating"), "{row:?}");
    }

    const PADDED: &str = "NAME          ROLE          CITY\nalice         admin         paris\nbob           dev           rome\ncarol         ops           oslo\n";

    #[test]
    fn table_positive_control() {
        let c = crush_output(&sv(&["somecmd"]), PADDED, 0);
        assert_eq!(c.rule.as_deref(), Some("table"));
        assert_eq!(c.text, "NAME\tROLE\tCITY\nalice\tadmin\tparis\nbob\tdev\trome\ncarol\tops\toslo\n");
    }

    fn assert_untouched(text: &str) {
        let c = crush_output(&sv(&["somecmd"]), text, 0);
        assert_eq!(c.rule, None, "{:?}", c.text);
        assert_eq!(c.text, text);
    }

    #[test]
    fn table_rejections() {
        // aligned but unpadded: a TAB would save nothing
        assert_untouched("a b c d\ne f g h\ni j k l\nm n o p\n");
        // blank line in the middle
        assert_untouched(&PADDED.replacen("bob", "\nbob", 1));
        // a row starting with a space
        assert_untouched(&PADDED.replacen("bob", " bob", 1));
        // a line already holding a TAB
        assert_untouched(&PADDED.replacen("dev  ", "dev\t ", 1));
        // header + only 2 rows
        assert_untouched("NAME          ROLE          CITY\nalice         admin         paris\nbob           dev           rome\n");
    }

    #[test]
    fn table_empty_middle_cell_survives_as_consecutive_tabs() {
        let text = "NAME          ROLE          CITY\nalice         admin         paris\nbob                         rome\ncarol         dev           oslo\n";
        let c = crush_output(&sv(&["somecmd"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("table"));
        assert!(c.text.split('\n').any(|l| l == "bob\t\trome"), "{:?}", c.text);
    }

    #[test]
    fn managedfields_yaml_replays_input_exactly() {
        let text = include_str!("../tests/fixtures/crush/kubectl-get-yaml.log");
        let cmd = sv(&["kubectl", "get", "deployments,services,configmaps", "-A", "-o", "yaml", "--show-managed-fields"]);
        let c = crush_output(&cmd, text, 0);
        assert_eq!(c.rule.as_deref(), Some("managedfields"));
        let inp: Vec<&str> = text.split('\n').collect();
        let out: Vec<&str> = c.text.split('\n').collect();
        let mark = Regex::new(r"^( *)managedFields: \[\] # (\d+) lines dropped$").unwrap();
        let (mut i, mut dropped, mut markers) = (0usize, 0usize, 0usize);
        for o in &out {
            if let Some(m) = mark.captures(o) {
                let n: usize = m[2].parse().unwrap();
                let ind = m[1].len();
                assert_eq!(inp[i], format!("{}managedFields:", &m[1]));
                for l in &inp[i + 1..i + n] {
                    let s = l.len() - l.trim_start_matches(' ').len();
                    assert!(s > ind || (s == ind && l[s..].starts_with("- ")), "swallowed a foreign line: {l:?}");
                }
                if let Some(next) = inp.get(i + n) {
                    let s = next.len() - next.trim_start_matches(' ').len();
                    assert!(next.is_empty() || s < ind || (s == ind && !next[s..].starts_with("- ")), "block ended early at {next:?}");
                }
                i += n;
                dropped += n;
                markers += 1;
            } else {
                assert_eq!(*o, inp[i]);
                i += 1;
            }
        }
        assert_eq!(i, inp.len());
        let planted = inp.iter().filter(|l| l.trim() == "managedFields:").count();
        assert!(planted >= 10);
        assert_eq!(markers, planted);
        assert_eq!(dropped - markers, inp.len() - out.len());
        assert!(out.iter().all(|l| !l.contains("fieldsV1:")));
        assert!(inp.iter().any(|l| l.contains("fieldsV1:")));
        assert!(c.text.contains("owner: backend-team@example.org"));
        assert!(c.text.contains("replicas: 2"));
        assert!(c.text.contains("last-applied-configuration"));
    }

    #[test]
    fn managedfields_json_excerpt_stays_valid_json() {
        let text = "{\n  \"metadata\": {\n    \"managedFields\": [\n      {\n        \"manager\": \"kubectl\"\n      }\n    ],\n    \"name\": \"x\"\n  },\n  \"spec\": {\n    \"managedFields\": [\n      { \"a\": 1 }\n    ]\n  }\n}\n";
        let c = crush_output(&sv(&["kubectl", "get", "pod", "-o", "json"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("managedfields"));
        let v: serde_json::Value = serde_json::from_str(&c.text).expect("valid json");
        assert_eq!(v["metadata"]["managedFields"], serde_json::json!(["... 5 lines dropped"]));
        assert_eq!(v["spec"]["managedFields"], serde_json::json!(["... 3 lines dropped"]));
        assert_eq!(v["metadata"]["name"], "x");
        assert!(c.text.contains("\"managedFields\": [\"... 5 lines dropped\"],\n"));
    }

    #[test]
    fn managedfields_unterminated_json_block_is_untouched() {
        let text = "{\n  \"metadata\": {\n    \"managedFields\": [\n      {\n        \"manager\": \"kubectl\"\n      }\n    \"name\": \"x\"\n  }\n";
        let c = crush_output(&sv(&["kubectl", "get", "pod", "-o", "json"]), text, 0);
        assert_eq!(c.rule, None);
        assert_eq!(c.text, text);
    }

    #[test]
    fn managedfields_only_for_kubectl() {
        let text = include_str!("../tests/fixtures/crush/kubectl-get-yaml.log");
        let c = crush_output(&sv(&["cat", "pods.yaml"]), text, 0);
        assert_eq!(c.rule, None);
        assert_eq!(c.text, text);
    }

    #[test]
    fn managedfields_answer_never_grows_and_map_describes_cleaned_doc() {
        let text = include_str!("../tests/fixtures/crush/kubectl-get-yaml.log");
        let cmd = sv(&["kubectl", "get", "deployments,services,configmaps", "-A", "-o", "yaml", "--show-managed-fields"]);
        crate::stash::with_test_dir("kube-never-grow", || {
            let out = route_output(&cmd, text, 0, None, &|id| format!("fetch {id}"));
            // measured on HEAD (0.22.1, no managedFields rule): 2847 chars
            assert!(out.chars().count() <= 2847, "{} chars", out.chars().count());
            assert!(out.contains("distill map (managedFields dropped): "), "{out}");
            assert!(!out.contains("fieldsV1") && !out.contains("operation: Update"), "{out}");
            assert!(out.contains(&format!(" · {} bytes", text.len())), "the stash holds the raw capture");
            let small = format!(
                "metadata:\n  managedFields:\n{}  name: x\n  uid: 7\n",
                (0..60).map(|i| format!("  - manager: m{i}\n")).collect::<String>()
            );
            let s = route_output(&sv(&["kubectl", "get", "x", "-o", "yaml"]), &small, 0, None, &|id| format!("fetch {id}"));
            assert!(s.contains("managedFields: [] # 61 lines dropped") && !s.contains("distill map"), "{s}");
        });
    }

    fn plain(l: &str) -> String {
        Regex::new(r"\x1b\[[0-9;]*m").unwrap().replace_all(l, "").into_owned()
    }

    fn check_terraform(text: &str, code: i32) -> (String, usize) {
        let c = crush_output(&sv(&["terraform", "plan"]), text, code);
        assert_eq!(c.rule.as_deref(), Some("terraform"));
        let prog = Regex::new(r"^\S+: (Refreshing state\.\.\.|Reading\.\.\.|Read complete after )").unwrap();
        let mut counts = [0usize; 3];
        let mut expected: Vec<String> = Vec::new();
        let mut at = None;
        for l in text.split('\n') {
            match prog.captures(&plain(l)) {
                Some(m) => {
                    at.get_or_insert_with(|| {
                        expected.push(String::new());
                        expected.len() - 1
                    });
                    counts[["Refreshing", "Reading.", "Read c"].iter().position(|k| m[1].starts_with(k)).unwrap()] += 1;
                }
                None => expected.push(l.to_string()),
            }
        }
        let n: usize = counts.iter().sum();
        assert!(n >= 3);
        let parts: Vec<String> = ["Refreshing state", "Reading", "Read complete"]
            .iter()
            .zip(counts)
            .filter(|(_, c)| *c > 0)
            .map(|(k, c)| format!("{c} {k}"))
            .collect();
        expected[at.unwrap()] = format!("[terraform: {n} progress lines dropped: {}]", parts.join(", "));
        assert_eq!(c.text.split('\n').map(String::from).collect::<Vec<_>>(), expected);
        (c.text, n)
    }

    #[test]
    fn terraform_plan_replays_and_keeps_headers() {
        let text = include_str!("../tests/fixtures/crush/terraform-plan.log");
        let (out, n) = check_terraform(text, 0);
        assert!(n >= 10);
        assert!(out.contains("\x1b[1mPlan:\x1b[0m \x1b[0m4 to add, 0 to change, 2 to destroy."));
        let headers: Vec<&str> = text.split('\n').filter(|l| plain(l).contains(" # ") || plain(l).starts_with('#')).collect();
        assert!(!headers.is_empty());
        let kept: Vec<&str> = out.split('\n').collect();
        for h in headers {
            assert!(kept.contains(&h), "lost {h:?}");
        }
    }

    #[test]
    fn terraform_plan_fail_keeps_error_lines() {
        let text = include_str!("../tests/fixtures/crush/terraform-plan-fail.log");
        let (out, _) = check_terraform(text, 1);
        let errors: Vec<&str> = text.split('\n').filter(|l| plain(l).contains("Error") || plain(l).contains("Planning failed")).collect();
        assert!(errors.len() >= 2);
        let kept: Vec<&str> = out.split('\n').collect();
        for e in errors {
            assert!(kept.contains(&e), "lost {e:?}");
        }
    }

    #[test]
    fn terraform_fewer_than_three_progress_lines_untouched() {
        let text = "aws_vpc.main: Refreshing state... [id=vpc-1]\naws_vpc.b: Refreshing state... [id=vpc-2]\nNo changes. Your infrastructure matches the configuration.\n";
        let c = crush_output(&sv(&["terraform", "plan"]), text, 0);
        assert_eq!(c.rule, None);
        assert_eq!(c.text, text);
    }

    #[test]
    fn terraform_diff_line_mentioning_reading_is_kept_and_tofu_fires() {
        let text = "aws_instance.web: Refreshing state... [id=i-0123456789abcdef0]\ndata.aws_ami.base: Reading...\ndata.aws_ami.base: Read complete after 0s [id=ami-0123456789abcdef0]\n  + name = \"x: Reading... y\"\nPlan: 1 to add, 0 to change, 0 to destroy.\n";
        let c = crush_output(&sv(&["/usr/bin/tofu", "plan"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("terraform"));
        assert_eq!(
            c.text,
            "[terraform: 3 progress lines dropped: 1 Refreshing state, 1 Reading, 1 Read complete]\n  + name = \"x: Reading... y\"\nPlan: 1 to add, 0 to change, 0 to destroy.\n"
        );
    }

    #[test]
    fn chaining_kubectl_table_and_list_cap() {
        let text = include_str!("../tests/fixtures/crush/kubectl-get-pods.log");
        let c = crush_output(&sv(&["kubectl", "get", "pods", "-A"]), text, 0);
        assert_eq!(c.rule.as_deref(), Some("table"));

        let mut big = String::from("NAME                    STATUS         RESTARTS\n");
        for i in 0..250 {
            big.push_str(&format!("pod-{i:03}                 Running        0\n"));
        }
        let c = crush_output(&sv(&["kubectl", "get", "pods"]), &big, 0);
        assert_eq!(c.rule.as_deref(), Some("table+list-cap"));
        assert!(c.text.contains("[... 52 more lines]"), "{}", c.text.rsplit('\n').next().unwrap());
        assert!(c.text.starts_with("NAME\tSTATUS\tRESTARTS\npod-000\tRunning\t0\n"));
    }
}
