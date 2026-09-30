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

// ---- run-delta, end to end: shim `cargo` / `npm` that replay a fixture ----

const FAIL1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/crush/cargo-test-fail-1.log");
const FAIL2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/crush/cargo-test-fail-2.log");
const NPM1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/crush/npm-test-1.log");
const NPM2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/crush/npm-test-2.log");

/// A scratch dir with `bin/{cargo,npm}` shims and an empty `stash/`, removed on drop.
struct Rig(std::path::PathBuf);

impl Rig {
    fn new(name: &str) -> Rig {
        use std::os::unix::fs::PermissionsExt as _;
        let root = std::env::temp_dir().join(format!("tanuki-run-delta-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        for tool in ["cargo", "npm"] {
            let p = root.join("bin").join(tool);
            std::fs::write(&p, "#!/bin/sh\ncat \"$SHIM_OUT\"\nexit \"$SHIM_CODE\"\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Rig(root)
    }

    fn stash(&self) -> std::path::PathBuf {
        self.0.join("stash")
    }

    /// `tanuki-context run -- <tool> test` where the shim replays `fixture` and exits `code`.
    fn run(&self, tool: &str, fixture: &str, code: i32, delta_off: bool) -> String {
        let path = format!("{}:{}", self.0.join("bin").display(), std::env::var("PATH").unwrap_or_default());
        let mut c = Command::new(BIN);
        c.env("PATH", path)
            .env("TANUKI_STASH", self.stash())
            .env("SHIM_OUT", fixture)
            .env("SHIM_CODE", code.to_string())
            .current_dir(&self.0)
            .args(["run", "--", tool, "test"]);
        if delta_off {
            c.env("TANUKI_DELTA", "off");
        }
        let out = c.output().expect("spawn tanuki-context");
        assert_eq!(out.status.code(), Some(code));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn second_cargo_run_leads_with_what_changed() {
    let rig = Rig::new("cargo");
    let first = rig.run("cargo", FAIL1, 101, false);
    assert!(!first.contains("[tanuki delta]"), "{first}");
    let second = rig.run("cargo", FAIL2, 101, false);
    assert!(second.contains("[tanuki delta] vs previous run"), "{second}");
    assert!(second.contains("1 fixed · 1 new"), "{second}");
    assert!(second.contains("fixed: test tests::fee_never_negative ... FAILED"), "{second}");
    assert!(second.contains("new: test tests::interest_compounds_yearly ... FAILED"), "{second}");
    assert!(second.contains("(same as previous run: 4 lines, fetch id "), "{second}");
    assert!(regex::Regex::new(r"fetch [0-9a-f]{12}").unwrap().is_match(&second), "{second}");
}

#[test]
fn identical_npm_rerun_collapses_to_a_pointer() {
    let rig = Rig::new("npm");
    let first = rig.run("npm", NPM1, 0, false);
    let second = rig.run("npm", NPM2, 0, false);
    assert!(second.contains("output identical"), "{second}");
    assert!(second.len() * 5 < first.len(), "second {} vs first {}\n{second}", second.len(), first.len());
}

#[test]
fn delta_off_records_nothing_and_prints_no_delta() {
    let rig = Rig::new("off");
    rig.run("cargo", FAIL1, 101, true);
    let second = rig.run("cargo", FAIL2, 101, true);
    assert!(!second.contains("[tanuki delta]"), "{second}");
    assert!(!rig.stash().join("runs").exists());
}

#[test]
fn tiny_first_run_writes_no_run_record() {
    let rig = Rig::new("tiny");
    let out = Command::new(BIN)
        .env("TANUKI_STASH", rig.stash())
        .current_dir(&rig.0)
        .args(["run", "--", "echo", "hi"])
        .output()
        .expect("spawn tanuki-context");
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).len() < 400);
    assert!(!rig.stash().join("runs").exists());
}
