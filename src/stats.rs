//! pxpipe measurement-log summary (~/.pxpipe/events.jsonl), same math as the
//! node MCP: actual = every way input bytes get billed (input + cache reads +
//! cache creates) — ignoring cache_read would fake the savings.

use serde_json::{json, Value};
use std::path::PathBuf;

fn events_path() -> PathBuf {
    if let Ok(p) = std::env::var("TANUKI_EVENTS") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".pxpipe").join("events.jsonl")
}

pub fn px_stats() -> Value {
    let path = events_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return json!({ "available": false, "note": format!("no {} yet", path.display()) });
    };
    let (mut requests, mut compressed, mut orig_chars, mut images) = (0u64, 0u64, 0u64, 0u64);
    let (mut baseline, mut actual) = (0u64, 0u64);
    for l in content.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(e) = serde_json::from_str::<Value>(l) else {
            continue;
        };
        requests += 1;
        if e["compressed"].as_bool() == Some(true) {
            compressed += 1;
            orig_chars += e["orig_chars"].as_u64().unwrap_or(0);
            images += e["image_count"].as_u64().unwrap_or(0);
        }
        baseline += e["baseline_tokens"].as_u64().unwrap_or(0);
        actual += e["input_tokens"].as_u64().unwrap_or(0)
            + e["cache_read_tokens"].as_u64().unwrap_or(0)
            + e["cache_create_tokens"].as_u64().unwrap_or(0);
    }
    let saved = if baseline > 0 && actual > 0 {
        Some(((1.0 - actual as f64 / baseline as f64) * 1000.0).round() / 10.0)
    } else {
        None
    };
    json!({
        "available": true, "requests": requests, "compressedRequests": compressed,
        "imagedChars": orig_chars, "imagesEmitted": images,
        "baselineTokens": baseline, "actualInputTokens": actual,
        "estInputSavedPct": saved,
    })
}
