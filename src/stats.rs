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
    // F4 diagnostic accumulators
    let (mut break_count, mut break_rebilled) = (0u64, 0u64);
    let mut last_break: Option<(u64, String)> = None;
    let (mut tax_requests, mut tax_tokens) = (0u64, 0u64);
    let mut last_tax_unused: Vec<String> = Vec::new();
    let mut volatile_count = 0u64;
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
        // F4: collect cache break / tool tax / volatile prompt stats
        if e["cacheBreak"].is_object() {
            break_count += 1;
            break_rebilled += e["cacheBreak"]["rebilled"].as_u64().unwrap_or(0);
            if let (Some(i), Some(k)) =
                (e["cacheBreak"]["index"].as_u64(), e["cacheBreak"]["kind"].as_str())
            {
                last_break = Some((i, k.to_string()));
            }
        }
        if e["toolTax"].is_object() {
            tax_requests += 1;
            tax_tokens += e["toolTax"]["tokens"].as_u64().unwrap_or(0);
            if let Some(u) = e["toolTax"]["unused"].as_array() {
                last_tax_unused = u.iter().filter_map(|n| n.as_str()).map(str::to_string).collect();
            }
        }
        if e["volatileSystem"].as_bool() == Some(true) {
            volatile_count += 1;
        }
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
    let mut out = json!({
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
    });
    if break_count > 0 {
        if let Some((i, k)) = &last_break {
            out["cacheBreaks"] = json!(format!(
                "cache breaks: {break_count}/{requests} requests \u{b7} {break_rebilled} tok rebilled \u{b7} last: block {i} {k}"
            ));
        }
    }
    if tax_requests > 0 {
        // same half-away-from-zero rnd convention as the TS engine
        let per = crate::cost::rnd(tax_tokens as f64 / tax_requests as f64);
        let first3: Vec<&str> = last_tax_unused.iter().take(3).map(String::as_str).collect();
        let extra = last_tax_unused.len() as i64 - 3;
        let names = if extra > 0 {
            format!("{} +{extra} more", first3.join(","))
        } else {
            first3.join(",")
        };
        out["toolTax"] = json!(format!("tool tax: {per} tok/request never invoked ({names})"));
    }
    if volatile_count > 0 {
        out["volatileSystem"] =
            json!("volatile system prompt: uuid/timestamp/jwt content busts the prefix cache");
    }
    out
}
