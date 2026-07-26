//! Situation-aware cost model — the "codeburn calculation". Byte-compatible
//! port of `src/cost.ts` on `main`; see there for the full rationale. tanuki's
//! verdict compares token COUNTS, which equals real cost only when both sides
//! bill at the same rate. They do not: on Anthropic a cache-read costs ~0.1× a
//! fresh input token, while image (visual) tokens bill AT the input rate. Only
//! the RATIOS drive the verdict; absolute $/Mtok are labeled list prices,
//! overridable via TANUKI_RATES. Image-token COUNTS are provider-correct when
//! page dims are supplied: Anthropic 28px patches, OpenAI 512px high-detail
//! tiles (85 + 170/tile), Gemini 768px tiles (258/tile, ~approximate — their
//! crop rule has undocumented edges; the API usage field is authoritative).

use serde_json::{json, Value};

pub const RATES_AS_OF: &str = "2026-07";

/// How a family COUNTS image tokens: 28px patches, 512px tiles, or 768px tiles.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Anthropic,
    Openai,
    Gemini,
}

#[derive(Clone, Copy)]
pub struct Rate {
    pub input: f64,
    pub output: f64,
    pub cache_read_mult: f64,
    pub image_mult: f64,
    pub family: Family,
}

fn base_rate(key: &str) -> Rate {
    match key {
        // Anthropic — cache-read 0.1×, image tokens billed at the input rate (1×).
        "opus" => Rate { input: 15.0, output: 75.0, cache_read_mult: 0.1, image_mult: 1.0, family: Family::Anthropic },
        "sonnet" => Rate { input: 3.0, output: 15.0, cache_read_mult: 0.1, image_mult: 1.0, family: Family::Anthropic },
        "haiku" => Rate { input: 1.0, output: 5.0, cache_read_mult: 0.1, image_mult: 1.0, family: Family::Anthropic },
        // Non-Anthropic — image tokens are COUNTED by that provider's tile rule when
        // page dims are supplied; cache discounts differ (OpenAI 0.5×, Gemini 0.25×).
        "gpt" => Rate { input: 1.25, output: 10.0, cache_read_mult: 0.5, image_mult: 1.0, family: Family::Openai },
        "gemini" => Rate { input: 1.25, output: 10.0, cache_read_mult: 0.25, image_mult: 1.0, family: Family::Gemini },
        _ => Rate { input: 3.0, output: 15.0, cache_read_mult: 0.1, image_mult: 1.0, family: Family::Anthropic },
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
                match o.get("family").and_then(|x| x.as_str()) {
                    Some("anthropic") => r.family = Family::Anthropic,
                    Some("openai") => r.family = Family::Openai,
                    Some("gemini") => r.family = Family::Gemini,
                    _ => {}
                }
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

/// Per-provider image-token count from real page dims. Constants confirmed
/// against provider docs as of RATES_AS_OF; float ops in fixed order for
/// engine parity (TS mirrors exactly).
pub fn provider_image_tokens(dims: &[(u64, u64)], family: Family) -> u64 {
    let mut tok = 0.0f64;
    for &(w0, h0) in dims {
        if family == Family::Openai {
            // high detail: fit 2048×2048 (downscale only), then shortest side to
            // ≤768 (downscale only), then 85 + 170 per 512px tile.
            let (mut w, mut h) = (w0 as f64, h0 as f64);
            let s1 = (2048.0 / w.max(h)).min(1.0);
            w *= s1;
            h *= s1;
            let s2 = (768.0 / w.min(h)).min(1.0);
            w = (w * s2).ceil();
            h = (h * s2).ceil();
            tok += 85.0 + 170.0 * ((w / 512.0).ceil() * (h / 512.0).ceil());
        } else {
            // gemini: ≤384px both dims flat 258, else 258 per 768px tile.
            tok += if w0 <= 384 && h0 <= 384 {
                258.0
            } else {
                258.0 * ((w0 as f64 / 768.0).ceil() * (h0 as f64 / 768.0).ceil())
            };
        }
    }
    tok as u64
}

/// Price text-vs-image for a situation. Verdict rests only on stable ratios
/// (cache-read, image) and provider-correct counts; dollars use labeled,
/// overridable list prices.
pub fn cost_verdict(
    text_tokens: u64,
    image_tokens: u64,
    model: Option<&str>,
    cached: bool,
    geom: Option<&[(u64, u64)]>,
) -> Value {
    let (key, rate) = resolve_rate(model);
    let counted = match geom {
        Some(dims) if rate.family != Family::Anthropic => provider_image_tokens(dims, rate.family),
        _ => image_tokens,
    };
    let in_usd = rate.input / 1e6;
    let text_rate = in_usd * if cached { rate.cache_read_mult } else { 1.0 };
    let img_rate = in_usd * rate.image_mult;
    let text_usd = text_tokens as f64 * text_rate;
    let image_usd = counted as f64 * img_rate;
    let breakeven: i64 = if img_rate > 0.0 {
        ((text_tokens as f64 * text_rate) / img_rate).floor() as i64
    } else {
        i64::MAX
    };
    let cheaper = if image_usd < text_usd { "PIPELINE" } else { "TEXT" };
    let saved_pct = if text_usd > 0.0 { rnd((1.0 - image_usd / text_usd) * 100.0) } else { 0 };
    let mut notes: Vec<String> = Vec::new();
    match rate.family {
        Family::Openai => notes.push(
            if geom.is_some() {
                "image tokens counted with OpenAI's high-detail tile rule (85 + 170 per 512px tile)"
            } else {
                "no page dims supplied; image count falls back to Anthropic's 28px patch grid — approximate for openai"
            }
            .to_string(),
        ),
        Family::Gemini => notes.push(
            if geom.is_some() {
                "~approximate: Gemini's documented 768px-tile rule (258/tile); the API usage field is authoritative"
            } else {
                "no page dims supplied; image count falls back to Anthropic's 28px patch grid — approximate for gemini"
            }
            .to_string(),
        ),
        Family::Anthropic => {}
    }
    if cached {
        notes.push(format!(
            "text priced at cache-read rate ({}× input); imaging already-cached content usually loses",
            rate.cache_read_mult
        ));
    }
    json!({
        "model": key,
        "cached": cached,
        "ratesAsOf": RATES_AS_OF,
        "imageTokens": counted,
        "textUsd": usd(text_usd),
        "imageUsd": usd(image_usd),
        "cheaper": cheaper,
        "savedPct": saved_pct,
        "breakevenImageTokens": breakeven,
        "note": if notes.is_empty() { Value::Null } else { Value::String(notes.join("; ")) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TANUKI_RATES is process-global; every test that resolves a rate takes
    /// the lock so env_override_applies cannot race the others. std Mutex with
    /// poison recovery: a failed assertion elsewhere must not cascade, and one
    /// test-only lock does not justify a new dependency.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn cache_flips_verdict() {
        let _env = env_lock();
        // uncached: fewer image tokens win (image bills at input rate)
        let a = cost_verdict(1000, 400, Some("claude-opus-4"), false, None);
        assert_eq!(a["cheaper"], "PIPELINE");
        assert_eq!(a["breakevenImageTokens"], 1000);
        // cached: text at 0.1× beats 400 image tokens
        let b = cost_verdict(1000, 400, Some("claude-opus-4"), true, None);
        assert_eq!(b["cheaper"], "TEXT");
        assert_eq!(b["breakevenImageTokens"], 100);
        assert!(b["note"].as_str().unwrap().contains("cache-read"));
        // deep cut still wins when cached
        let c = cost_verdict(1000, 50, Some("opus"), true, None);
        assert_eq!(c["cheaper"], "PIPELINE");
        // non-Anthropic without dims falls back to the patch grid, flagged approximate
        let g = cost_verdict(1000, 400, Some("gpt-5"), false, None);
        assert!(g["note"].as_str().unwrap().contains("approximate"));
        assert_eq!(g["imageTokens"], 400);
    }

    #[test]
    fn env_override_applies() {
        let _env = env_lock();
        std::env::set_var("TANUKI_RATES", r#"{"opus":{"cacheReadMult":0.5}}"#);
        let o = cost_verdict(1000, 400, Some("opus"), true, None);
        assert_eq!(o["breakevenImageTokens"], 500);
        std::env::remove_var("TANUKI_RATES");
    }

    #[test]
    fn provider_math_is_exact_on_known_dims() {
        // full page 1568x728: fits 2048, shortest 728 <= 768 -> 4*2 tiles -> 85 + 170*8
        assert_eq!(provider_image_tokens(&[(1568, 728)], Family::Openai), 1445);
        // 1568x728 -> ceil(1568/768)*ceil(728/768) = 3*1 tiles * 258
        assert_eq!(provider_image_tokens(&[(1568, 728)], Family::Gemini), 774);
        assert_eq!(provider_image_tokens(&[(300, 200)], Family::Gemini), 258); // <=384 flat
        // openai downscale: 4096x4096 -> fit 2048 -> shortest 768 -> 768x768 -> 4 tiles
        assert_eq!(provider_image_tokens(&[(4096, 4096)], Family::Openai), 765);
    }

    #[test]
    fn geom_switches_counting_for_non_anthropic_only() {
        let _env = env_lock();
        let dims = [(1568u64, 728u64)];
        let o = cost_verdict(1456, 1456, Some("gpt-5"), false, Some(&dims));
        assert_eq!(o["imageTokens"], 1445);
        assert!(o["note"].as_str().unwrap().contains("512px tile"));
        let g = cost_verdict(1456, 1456, Some("gemini-2.5-pro"), false, Some(&dims));
        assert_eq!(g["imageTokens"], 774);
        assert!(g["note"].as_str().unwrap().contains("approximate"));
        // Anthropic keeps the patch-grid count even when dims are supplied
        let a = cost_verdict(1456, 1456, Some("claude-opus-4"), false, Some(&dims));
        assert_eq!(a["imageTokens"], 1456);
        assert_eq!(a["note"], Value::Null);
    }
}
