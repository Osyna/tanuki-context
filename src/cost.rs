//! Situation-aware cost model — the "codeburn calculation". Byte-compatible
//! port of `src/cost.ts` on `main`; see there for the full rationale. tanuki's
//! verdict compares token COUNTS, which equals real cost only when both sides
//! bill at the same rate. They do not: on Anthropic a cache-read costs ~0.1× a
//! fresh input token, while image (visual) tokens bill AT the input rate. Only
//! the RATIOS drive the verdict; absolute $/Mtok are labeled list prices,
//! overridable via TANUKI_RATES. Image-token COUNTS are Anthropic's 28px patch
//! grid, so the dollars are calibrated for Anthropic — flagged in `note`.

use serde_json::{json, Value};

pub const RATES_AS_OF: &str = "2026-07";

#[derive(Clone, Copy)]
pub struct Rate {
    pub input: f64,
    pub output: f64,
    pub cache_read_mult: f64,
    pub image_mult: f64,
    pub anthropic_grid: bool,
}

fn base_rate(key: &str) -> Rate {
    match key {
        "opus" => Rate { input: 15.0, output: 75.0, cache_read_mult: 0.1, image_mult: 1.0, anthropic_grid: true },
        "sonnet" => Rate { input: 3.0, output: 15.0, cache_read_mult: 0.1, image_mult: 1.0, anthropic_grid: true },
        "haiku" => Rate { input: 1.0, output: 5.0, cache_read_mult: 0.1, image_mult: 1.0, anthropic_grid: true },
        // Non-Anthropic: image token COUNTING differs (tiles); OpenAI cache is 0.5×.
        "gpt" => Rate { input: 1.25, output: 10.0, cache_read_mult: 0.5, image_mult: 1.0, anthropic_grid: false },
        "gemini" => Rate { input: 1.25, output: 10.0, cache_read_mult: 0.25, image_mult: 1.0, anthropic_grid: false },
        _ => Rate { input: 3.0, output: 15.0, cache_read_mult: 0.1, image_mult: 1.0, anthropic_grid: true },
    }
}

/// `base_rate(key)` with a `TANUKI_RATES` JSON override merged in (per-key
/// partial). ponytail: a malformed override falls back to list prices.
fn rate_for(key: &str) -> Rate {
    let mut r = base_rate(key);
    if let Ok(env) = std::env::var("TANUKI_RATES") {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&env) {
            if let Some(Value::Object(o)) = map.get(key) {
                if let Some(v) = o.get("input").and_then(|x| x.as_f64()) { r.input = v; }
                if let Some(v) = o.get("output").and_then(|x| x.as_f64()) { r.output = v; }
                if let Some(v) = o.get("cacheReadMult").and_then(|x| x.as_f64()) { r.cache_read_mult = v; }
                if let Some(v) = o.get("imageMult").and_then(|x| x.as_f64()) { r.image_mult = v; }
                if let Some(v) = o.get("anthropicGrid").and_then(|x| x.as_bool()) { r.anthropic_grid = v; }
            }
        }
    }
    r
}

/// Resolve a model string to (key, rate) by substring; unknown -> "default".
pub fn resolve_rate(model: Option<&str>) -> (&'static str, Rate) {
    let m = model.unwrap_or("").to_lowercase();
    for key in ["opus", "sonnet", "haiku", "gpt", "gemini"] {
        if m.contains(key) {
            return (key, rate_for(key));
        }
    }
    ("default", rate_for("default"))
}

/// Rust f64::round: half away from zero (matches stats/main pct).
fn rnd(x: f64) -> i64 {
    if x < 0.0 { -((-x).round() as i64) } else { x.round() as i64 }
}
fn usd(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// Price text-vs-image for a situation. Verdict rests on stable ratios; dollars
/// use labeled, overridable list prices.
pub fn cost_verdict(text_tokens: u64, image_tokens: u64, model: Option<&str>, cached: bool) -> Value {
    let (key, rate) = resolve_rate(model);
    let in_usd = rate.input / 1e6;
    let text_rate = in_usd * if cached { rate.cache_read_mult } else { 1.0 };
    let img_rate = in_usd * rate.image_mult;
    let text_usd = text_tokens as f64 * text_rate;
    let image_usd = image_tokens as f64 * img_rate;
    let breakeven: i64 = if img_rate > 0.0 {
        ((text_tokens as f64 * text_rate) / img_rate).floor() as i64
    } else {
        i64::MAX
    };
    let cheaper = if image_usd < text_usd { "PIPELINE" } else { "TEXT" };
    let saved_pct = if text_usd > 0.0 { rnd((1.0 - image_usd / text_usd) * 100.0) } else { 0 };
    let note: Value = if !rate.anthropic_grid {
        json!(format!(
            "image-token counts use Anthropic's 28px patch grid; {} prices images on a different (tile) model — treat dollars as approximate",
            key
        ))
    } else if cached {
        json!(format!(
            "text priced at cache-read rate ({}× input); imaging already-cached content usually loses",
            rate.cache_read_mult
        ))
    } else {
        Value::Null
    };
    json!({
        "model": key,
        "cached": cached,
        "ratesAsOf": RATES_AS_OF,
        "textUsd": usd(text_usd),
        "imageUsd": usd(image_usd),
        "cheaper": cheaper,
        "savedPct": saved_pct,
        "breakevenImageTokens": breakeven,
        "note": note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_flips_verdict() {
        // uncached: fewer image tokens win (image bills at input rate)
        let a = cost_verdict(1000, 400, Some("claude-opus-4"), false);
        assert_eq!(a["cheaper"], "PIPELINE");
        assert_eq!(a["breakevenImageTokens"], 1000);
        // cached: text at 0.1× beats 400 image tokens
        let b = cost_verdict(1000, 400, Some("claude-opus-4"), true);
        assert_eq!(b["cheaper"], "TEXT");
        assert_eq!(b["breakevenImageTokens"], 100);
        // deep cut still wins when cached
        let c = cost_verdict(1000, 50, Some("opus"), true);
        assert_eq!(c["cheaper"], "PIPELINE");
        // non-Anthropic note
        let g = cost_verdict(1000, 400, Some("gpt-5"), false);
        assert!(g["note"].as_str().unwrap().contains("approximate"));
    }

    #[test]
    fn env_override_applies() {
        std::env::set_var("TANUKI_RATES", r#"{"opus":{"cacheReadMult":0.5}}"#);
        let o = cost_verdict(1000, 400, Some("opus"), true);
        assert_eq!(o["breakevenImageTokens"], 500);
        std::env::remove_var("TANUKI_RATES");
    }
}
