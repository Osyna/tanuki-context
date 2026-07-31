//! Run output crushing — rtk-style stdout reduction.
//! Generic pass (spinners, progress bars) + per-tool rules (cargo, npm, etc.)
//! to keep signal and drop the noise. Prior art: rtk-ai/rtk Apache-2.0.

use regex::Regex;
use std::sync::LazyLock;

pub struct Crushed {
    pub text: String,
    pub rule: Option<String>,
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

pub fn crush_output(cmd: &[String], text: &str, exit_code: i32) -> Crushed {
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

        // list-cap
        (b, _, _) if matches!(b, "ls" | "find" | "grep" | "rg" | "fd")
                  || (b == "docker" && sub == "ps")
                  || (b == "kubectl" && sub == "get") => {
            let lines: Vec<&str> = after_generic.split('\n').collect();
            if lines.len() > 200 {
                let mut out: Vec<String> = lines[..200].iter().map(|s| (*s).to_string()).collect();
                out.push(format!("[... {} more lines]", lines.len() - 200));
                (out.join("\n"), Some("list-cap"))
            } else {
                (after_generic.clone(), None)
            }
        }

        _ => (after_generic.clone(), None),
    };

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
    let final_rule = if let Some(r) = rule_name {
        Some(r.to_string())
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
}
