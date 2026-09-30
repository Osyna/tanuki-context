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
    let mut r = events_summary();
    if let (Some(net), Some(o)) = (crate::ledger::stash_net(), r.as_object_mut()) {
        o.insert("stashNet".into(), net);
    }
    r
}

fn events_summary() -> Value {
    let path = events_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return json!({ "available": false, "note": format!("no {} yet", path.display()) });
    };
    summarize(&content)
}

fn summarize(content: &str) -> Value {
    let (mut requests, mut compressed, mut orig_chars, mut images) = (0u64, 0u64, 0u64, 0u64);
    let (mut baseline, mut actual, mut output) = (0u64, 0u64, 0u64);
    let mut saved_ca = 0i64;
    // T2b: the estimator's prediction next to what was billed, over the rows
    // that carry both (an error response bills nothing and scrapes no usage)
    let (mut estimated, mut est_billed) = (0u64, 0u64);
    // F4 diagnostic accumulators
    let (mut break_count, mut break_rebilled) = (0u64, 0u64);
    let mut last_break: Option<(u64, String)> = None;
    let (mut tax_requests, mut tax_tokens) = (0u64, 0u64);
    let mut last_tax_unused: Vec<String> = Vec::new();
    let mut volatile_count = 0u64;
    let (mut pruned_requests, mut pruned_tokens, mut last_pruned_tools) = (0u64, 0u64, 0u64);
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
        let billed = e["input_tokens"].as_u64().unwrap_or(0)
            + e["cache_read_tokens"].as_u64().unwrap_or(0)
            + e["cache_create_tokens"].as_u64().unwrap_or(0);
        actual += billed;
        let est = e["est_input_tokens"].as_u64().unwrap_or(0);
        if est > 0 && billed > 0 {
            estimated += est;
            est_billed += billed;
        }
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
        // --prune-tools: tools left out of the forwarded request
        if e["pruned_tools"].as_u64().unwrap_or(0) > 0 {
            pruned_requests += 1;
            pruned_tokens += e["pruned_tool_tokens"].as_u64().unwrap_or(0);
            last_pruned_tools = e["pruned_tools"].as_u64().unwrap_or(0);
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
    // T2b: how far the estimator that gates every imaging decision sits from the
    // bill (100 = exact). Only when the log has rows that carry both figures.
    if est_billed > 0 {
        out["estimatedInputTokens"] = json!(estimated);
        out["billedInputTokens"] = json!(est_billed);
        out["estimatorRatioPct"] =
            json!(((estimated as f64 / est_billed as f64) * 1000.0).round() / 10.0);
    }
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
    if pruned_requests > 0 {
        let per = crate::cost::rnd(pruned_tokens as f64 / pruned_requests as f64);
        out["toolPrune"] = json!(format!("tool prune: {per} tok/request left out ({last_pruned_tools} tools, {pruned_requests} requests)"));
    }
    if volatile_count > 0 {
        out["volatileSystem"] =
            json!("volatile system prompt: uuid/timestamp/jwt content busts the prefix cache");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(est: u64, input: u64, read: u64, create: u64) -> String {
        json!({ "tool": "proxy", "est_input_tokens": est, "input_tokens": input, "cache_read_tokens": read, "cache_create_tokens": create }).to_string()
    }

    /// T2b: estimated and billed totals over the rows that carry both, and their ratio.
    #[test]
    fn stats_report_estimated_vs_billed() {
        let log = [row(100, 60, 30, 10), row(300, 200, 100, 0), row(50, 0, 0, 0), json!({ "tool": "proxy", "input_tokens": 5 }).to_string()].join("\n");
        let st = summarize(&log);
        // the zero-billed row (an error response) and the row without an estimate are excluded
        assert_eq!(st["estimatedInputTokens"], 400);
        assert_eq!(st["billedInputTokens"], 400);
        assert_eq!(st["estimatorRatioPct"].to_string(), "100.0");
        assert_eq!(st["actualInputTokens"], 405);
        // nothing to compare -> the keys are absent
        assert!(summarize(&row(0, 5, 0, 0))["estimatorRatioPct"].is_null());
        // an underestimating estimator reads below 100
        assert_eq!(summarize(&row(70, 60, 30, 10))["estimatorRatioPct"].to_string(), "70.0");
    }
}
