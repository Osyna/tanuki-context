//! Net-savings ledger (mirror of ledger.ts): what a crushed/stashed output saved
//! and what the model then paid to fetch it back. One append-only TSV next to
//! the stash (`ledger.tsv`), two row kinds:
//!   s <id> <rule> <savedTokens>
//!   f <id> <tokens>
//! A fetch belongs to the LATEST `s` row of its id. Capped at LEDGER_MAX (the
//! older half of the rows goes). Writes are best-effort. The summary is
//! parity-locked byte-for-byte with the TS engine. No back-off: measured live
//! it cost more than it saved.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::PathBuf;

const LEDGER_MAX: u64 = 256 * 1024;

fn ledger_path() -> PathBuf {
    crate::stash::stash_dir().join("ledger.tsv")
}

fn append(line: &str) {
    let _ = try_append(line);
}

fn try_append(line: &str) -> std::io::Result<()> {
    let p = ledger_path();
    let mut db = std::fs::DirBuilder::new();
    db.recursive(true);
    let mut opts = std::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
        db.mode(0o700);
        opts.mode(0o600);
    }
    db.create(crate::stash::stash_dir())?;
    writeln!(opts.open(&p)?, "{line}")?;
    if std::fs::metadata(&p)?.len() <= LEDGER_MAX {
        return Ok(());
    }
    // Over the cap: keep the newer half. The kept rows go to a temp file of our own and are
    // renamed over the ledger, so a reader never sees a half-written file and two writers
    // never share a temp; the size is re-read first so a writer that lost the race to
    // another trim does not trim a second time. A row appended between the read and the
    // rename is lost - a cap trim is rare (every ~128 KiB) and a ledger row is an estimate.
    let text = std::fs::read_to_string(&p)?;
    let ls: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    if ls.join("\n").len() as u64 <= LEDGER_MAX {
        return Ok(());
    }
    let tmp = crate::toolusage::private_temp(&p);
    let mut wopts = std::fs::OpenOptions::new();
    wopts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        wopts.mode(0o600);
    }
    let written = wopts
        .open(&tmp)
        .and_then(|mut f| write!(f, "{}\n", ls[ls.len() >> 1..].join("\n")))
        .and_then(|()| std::fs::rename(&tmp, &p));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// A stash was handed to the model (pointer or map) in place of `saved` tokens.
pub fn log_stash(id: &str, rule: &str, saved: i64) {
    append(&format!("s\t{id}\t{rule}\t{saved}"));
}

/// The model paid `tokens` to read a slice of stash `id` back.
pub fn log_fetch(id: &str, tokens: u64) {
    if id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        append(&format!("f\t{id}\t{tokens}"));
    }
}

fn rows() -> Vec<Vec<String>> {
    let Ok(text) = std::fs::read_to_string(ledger_path()) else { return Vec::new() };
    text.split('\n').filter(|l| !l.is_empty()).map(|l| l.split('\t').map(String::from).collect()).collect()
}

/// Index of the `s` row each `f` row belongs to (None: its stash left the ledger).
fn attribute(all: &[Vec<String>]) -> Vec<Option<usize>> {
    let mut latest: HashMap<&str, usize> = HashMap::new();
    all.iter()
        .enumerate()
        .map(|(i, r)| {
            match r[0].as_str() {
                "s" => {
                    latest.insert(r.get(1).map_or("", String::as_str), i);
                    None
                }
                "f" => latest.get(r.get(1).map_or("", String::as_str)).copied(),
                _ => None,
            }
        })
        .collect()
}

fn col(r: &[String], i: usize) -> &str {
    r.get(i).map_or("", String::as_str)
}

#[derive(Default, Clone)]
struct Net {
    stashes: i64,
    saved: i64,
    fetches: i64,
    fetched: i64,
    net: i64,
}

impl Net {
    fn json(&self) -> Value {
        json!({ "stashes": self.stashes, "savedTokens": self.saved,
                "fetches": self.fetches, "fetchedTokens": self.fetched, "netTokens": self.net })
    }
}

/// Saved minus fetched-back tokens, per rule and in total; None with no rows.
pub fn stash_net() -> Option<Value> {
    let all = rows();
    if all.is_empty() {
        return None;
    }
    let owner = attribute(&all);
    let mut rules: BTreeMap<String, Net> = BTreeMap::new();
    for (i, r) in all.iter().enumerate() {
        if r[0] == "s" {
            let n = rules.entry(col(r, 2).to_string()).or_default();
            n.stashes += 1;
            n.saved += col(r, 3).parse::<i64>().unwrap_or(0);
        } else if r[0] == "f" {
            let name = owner[i].map_or("untracked".to_string(), |o| col(&all[o], 2).to_string());
            let n = rules.entry(name).or_default();
            n.fetches += 1;
            n.fetched += col(r, 2).parse::<i64>().unwrap_or(0);
        }
    }
    let mut total = Net::default();
    let mut out = serde_json::Map::new();
    for (name, n) in rules.iter_mut() {
        n.net = n.saved - n.fetched;
        total.stashes += n.stashes;
        total.saved += n.saved;
        total.fetches += n.fetches;
        total.fetched += n.fetched;
        total.net += n.net;
        out.insert(name.clone(), n.json());
    }
    Some(json!({ "rules": out, "total": total.json() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stash::with_test_dir;

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    /// Letters only (distill masks digits and hex).
    fn word(seed: &str) -> String {
        crate::sha256::hex(seed.as_bytes())
            .chars()
            .map(|c| if c.is_ascii_digit() { (103 + c.to_digit(10).unwrap() as u8) as char } else { c })
            .take(14)
            .collect()
    }
    fn big(tag: &str) -> String {
        (0..300).map(|i| format!("{} {} {}", word(&format!("{tag}{i}")), word(&format!("{tag}{i}b")), word(&format!("{tag}{i}c")))).collect::<Vec<_>>().join("\n")
    }
    fn route(cmd: &[&str], text: &str, code: i32) -> String {
        crate::crush::route_output(&sv(cmd), text, code, None, &|id| format!("fetch {id}"))
    }
    fn id_of(out: &str) -> String {
        let b = out.as_bytes();
        let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
        let mut last = None;
        let mut i = 0;
        while i + 12 <= b.len() {
            if b[i..i + 12].iter().all(|&c| hex(c)) {
                last = Some(i);
                i += 12;
            } else {
                i += 1;
            }
        }
        out[last.unwrap()..last.unwrap() + 12].to_string()
    }
    fn rule(name: &str, k: &str) -> i64 {
        stash_net().unwrap()["rules"][name][k].as_i64().unwrap()
    }

    #[test]
    fn fetch_is_charged_against_saved() {
        with_test_dir("ledger-net", || {
            std::env::remove_var("TANUKI_DELTA");
            let out = route(&["mytool", "--all"], &big("a"), 0);
            assert_eq!(rule("distill", "stashes"), 1);
            assert!(rule("distill", "savedTokens") > 0);
            crate::tool_fetch(&json!({ "id": id_of(&out), "lines": "1-5" })).unwrap();
            assert_eq!(rule("distill", "fetches"), 1);
            assert!(rule("distill", "fetchedTokens") > 0);
            assert_eq!(rule("distill", "netTokens"), rule("distill", "savedTokens") - rule("distill", "fetchedTokens"));
            assert_eq!(stash_net().unwrap()["total"], stash_net().unwrap()["rules"]["distill"]);
        })
    }

    #[test]
    fn rule_owns_its_stash_and_manual_stash_counts() {
        with_test_dir("ledger-rule", || {
            std::env::remove_var("TANUKI_DELTA");
            let mut lines = vec!["Compiling a v0.1.0".to_string()];
            lines.extend((0..400).map(|i| format!("   Compiling {} v0.1.0", word(&format!("c{i}")))));
            lines.push("error[E0308]: mismatched types".into());
            lines.push("  --> src/lib.rs:3:5".into());
            let out = route(&["cargo", "build"], &lines.join("\n"), 101);
            assert_eq!(rule("cargo", "stashes"), 1);
            crate::tool_fetch(&json!({ "id": id_of(&out), "find": "mismatched types" })).unwrap();
            assert_eq!(rule("cargo", "fetches"), 1);
            let ov = crate::tool_stash(&json!({ "text": big("m") })).unwrap()[0]["text"].as_str().unwrap().to_string();
            crate::tool_fetch(&json!({ "id": id_of(&ov), "lines": "1-5" })).unwrap();
            assert_eq!((rule("stash", "stashes"), rule("stash", "fetches")), (1, 1));
        })
    }

    #[test]
    fn untracked_latest_stash_and_empty() {
        with_test_dir("ledger-latest", || {
            assert!(stash_net().is_none());
            log_fetch("0123456789ab", 40);
            let u = &stash_net().unwrap()["rules"]["untracked"];
            assert_eq!((u["stashes"].as_i64(), u["fetches"].as_i64(), u["fetchedTokens"].as_i64(), u["netTokens"].as_i64()), (Some(0), Some(1), Some(40), Some(-40)));
            log_stash("aaaaaaaaaaaa", "one", 100);
            log_stash("aaaaaaaaaaaa", "two", 100);
            log_fetch("aaaaaaaaaaaa", 30);
            assert_eq!(rule("one", "fetches"), 0);
            assert_eq!(rule("two", "fetches"), 1);
            log_fetch("not-an-id", 5); // malformed ids are not logged
            let t = &stash_net().unwrap()["total"];
            assert_eq!((t["stashes"].as_i64(), t["savedTokens"].as_i64(), t["fetchedTokens"].as_i64(), t["netTokens"].as_i64()), (Some(2), Some(200), Some(70), Some(130)));
        })
    }

    #[test]
    fn cap_drops_older_half() {
        with_test_dir("ledger-cap", || {
            for i in 0..9000 {
                log_stash("aaaaaaaaaaaa", &format!("rule{i:0>20}"), 1);
            }
            let n = rows().len();
            assert!(n < 9000 && n > 2000, "{n}");
            assert!(std::fs::metadata(ledger_path()).unwrap().len() <= LEDGER_MAX);
        })
    }
}
