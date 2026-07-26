//! CLI `run` wrapper (rtk-style): spawn the real binary, mirror the TS
//! stash.test.ts "run wrapper" suite byte-for-byte on the checked substrings.

use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_tanuki-context");

#[test]
fn exit_code_passes_through_frames_collapse_errors_verbatim() {
    let script = "for i in 1 2 3 4 5 6 7 8; do echo \"copied file_$i.dat ok\"; done; \
                  printf \"pull: 10%%\\rpull: 99%%\\rpull: done\\n\"; \
                  echo \"ERROR real failure\" >&2; exit 3";
    let out = Command::new(BIN)
        .args(["run", "--", "sh", "-c", script])
        .output()
        .expect("spawn tanuki-context");
    assert_eq!(out.status.code(), Some(3));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.starts_with("[tanuki run] exit 3 ·"), "{stdout}");
    assert!(stdout.contains("pull: done"), "{stdout}");
    assert!(!stdout.contains("pull: 10%"), "{stdout}");
    assert!(stdout.contains("ERROR real failure"), "{stdout}");
    assert!(stdout.contains("×8 (template)"), "{stdout}");
    assert!(stdout.ends_with('\n'), "{stdout}");
}

#[test]
fn huge_output_is_stashed_with_a_fetch_pointer() {
    let dir = std::env::temp_dir().join(format!("tanuki-run-cli-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let script = "i=0; while [ $i -lt 3000 ]; do \
                  echo \"line $i of much repeated output padding padding\"; \
                  i=$((i+1)); done";
    let out = Command::new(BIN)
        .env("TANUKI_STASH", &dir)
        .args(["run", "--", "sh", "-c", script])
        .output()
        .expect("spawn tanuki-context");
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("stashed"), "{stdout}");
    let ptr = regex::Regex::new(r"fetch [0-9a-f]{12}").unwrap();
    assert!(ptr.is_match(&stdout), "{stdout}");
}
