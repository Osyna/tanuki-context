//! Which tools a client's conversations actually call: the evidence behind
//! `--prune-tools`. One small JSON map, tool name -> { adv, used }: in how many
//! conversations the tool was advertised, and in how many it was called. The
//! proxy bumps it as requests pass (names only, never arguments), so the file
//! fills while pruning is still off. Best-effort like every stats file here:
//! an unreadable or unwritable file means "no evidence", which prunes nothing.
//! Mirror of toolusage.ts.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// tool name -> (conversations advertising it, conversations calling it)
pub type UsageMap = BTreeMap<String, (u64, u64)>;

pub trait UsageStore {
    fn load(&self) -> UsageMap;
    /// count one more conversation for each name advertised / used for the first time
    fn bump(&mut self, adv: &[String], used: &[String]);
}

pub fn usage_path() -> PathBuf {
    if let Some(p) = std::env::var_os("TANUKI_TOOL_USAGE").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".tanuki").join("tool-usage.json")
}

/// `<path>.<pid>.<nanos>.tmp`: unique per writer and call (create_new refuses a clash).
pub(crate) fn private_temp(path: &std::path::Path) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{nanos:x}.tmp", std::process::id()));
    PathBuf::from(tmp)
}

pub struct FileUsage;

impl UsageStore for FileUsage {
    fn load(&self) -> UsageMap {
        let mut out = UsageMap::new();
        let Ok(text) = std::fs::read_to_string(usage_path()) else { return out };
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&text) else { return out };
        for (k, v) in m {
            if v.is_object() {
                out.insert(k, (v["adv"].as_u64().unwrap_or(0), v["used"].as_u64().unwrap_or(0)));
            }
        }
        out
    }

    fn bump(&mut self, adv: &[String], used: &[String]) {
        let mut m = self.load();
        for n in adv {
            m.entry(n.clone()).or_insert((0, 0)).0 += 1;
        }
        for n in used {
            m.entry(n.clone()).or_insert((0, 0)).1 += 1;
        }
        let p = usage_path();
        if let Some(dir) = p.parent() {
            let mut db = std::fs::DirBuilder::new();
            db.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                db.mode(0o700);
            }
            let _ = db.create(dir);
        }
        let obj: serde_json::Map<String, Value> = m.into_iter().map(|(k, (a, u))| (k, json!({ "adv": a, "used": u }))).collect();
        // a temp name of our own, then rename: concurrent proxies never write the same
        // file, and a reader sees the old file or the new one, never half of one
        let tmp = private_temp(&p);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            opts.mode(0o600);
        }
        let done = opts
            .open(&tmp)
            .and_then(|mut f| std::io::Write::write_all(&mut f, format!("{}\n", Value::Object(obj)).as_bytes()))
            .and_then(|()| std::fs::rename(&tmp, &p));
        if done.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}
