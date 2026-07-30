//! pxpipe measurement-log summary (~/.pxpipe/events.jsonl), same math as the
//! node MCP: actual = every way input bytes get billed (input + cache reads +
//! cache creates) — ignoring cache_read would fake the savings.
//!
//! Two savings numbers, honestly labeled: `estInputSavedPct` prices every
//! avoided token at the full input rate (the optimistic counterfactual every
//! tool in this category reports), `estInputSavedPctCacheAware` prices
//! replayed blocks at the provider's cache-read rate and charges the first
//! text->pages flip at the cache-write premium. The honest number is between
//! them, and only a paired run (reference/paired-report.mjs) pins it.

use serde_json::{json, Value};
use std::path::PathBuf;

pub(crate) fn events_path() -> PathBuf {
    // Empty means unset, the same rule TANUKI_STASH uses. Without it,
    // `TANUKI_EVENTS=` resolved the events path to "" instead of the default.
    if let Some(p) = std::env::var("TANUKI_EVENTS").ok().filter(|p| !p.is_empty()) {
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
    let (mut baseline, mut actual, mut output) = (0u64, 0u64, 0u64);
    let mut saved_ca = 0i64;
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
        saved_ca += e["saved_tokens_cache_aware"].as_i64().unwrap_or(0);
        actual += e["input_tokens"].as_u64().unwrap_or(0)
            + e["cache_read_tokens"].as_u64().unwrap_or(0)
            + e["cache_create_tokens"].as_u64().unwrap_or(0);
        output += e["output_tokens"].as_u64().unwrap_or(0);
    }
    let saved = if baseline > 0 && actual > 0 {
        Some(((1.0 - actual as f64 / baseline as f64) * 1000.0).round() / 10.0)
    } else {
        None
    };
    let baseline_ca = actual as i64 + saved_ca;
    let saved_ca_pct = if baseline_ca > 0 && actual > 0 {
        Some(((1.0 - actual as f64 / baseline_ca as f64) * 1000.0).round() / 10.0)
    } else {
        None
    };
    json!({
        "available": true, "requests": requests, "compressedRequests": compressed,
        "imagedChars": orig_chars, "imagesEmitted": images,
        "baselineTokens": baseline, "actualInputTokens": actual,
        // optimistic counterfactual: avoided text at the full input rate
        "estInputSavedPct": saved,
        // cache-aware counterfactual: replays at the cache-read rate, first
        // flips charged the cache-write premium. Negative = imaging cost money.
        "baselineCacheAwareTokens": baseline_ca,
        "estInputSavedPctCacheAware": saved_ca_pct,
        "outputTokens": output,
        // the honest boundary: no input-side tool can cut this share of the bill
        "outputSharePct": if output > 0 {
            json!(((output as f64 / (actual + output) as f64) * 1000.0).round() / 10.0)
        } else {
            Value::Null
        },
    })
}
