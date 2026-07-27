//! Read-back fidelity - DeepSeek-OCR's density cliff, made actionable.
//!
//! Parity mirror of `src/fidelity.ts`: identical thresholds, f64 rounding, and
//! byte-identical strings. serde_json serializes the f64 ratio like TS's Float
//! (whole values print `4.0`), and object keys sort in both engines, so field
//! order here is irrelevant.
//!
//! DeepSeek-OCR (arXiv:2510.18234, Fox Table 2): imaged read-back precision vs
//! the text/vision token ratio - ~98% under 8x, ~87% by 12x, ~60% by 20x. Our
//! own tier sweep reproduces the curve. The 4x6 tiny font sits past the
//! legibility cliff regardless of ratio (measured), so it floors the band.

use serde_json::{json, Value};

const CLEAN: &str = "imaged pages read back cleanly; exact strings ride the verbatim sidecar as text";
const CLIFF: &str = "imaged read-back degrades past the DeepSeek-OCR density cliff (arXiv:2510.18234) - use images for comprehension, not transcription; exact strings stay in the verbatim sidecar (default on), and a larger font or lower density restores read-back";
const TINY_CAP: &str = " The 4x6 tiny font is past the legibility cliff (measured 3/10 needle recall) - reserve it for lossy bulk.";

const ORDER: [&str; 5] = ["high", "good", "degraded", "low", "unreliable"];

fn order(l: &str) -> usize {
    ORDER.iter().position(|&x| x == l).unwrap()
}

/// Map the imaged-config token ratio (+ tiny-font floor) to a read-back band.
pub fn fidelity(text_tokens: u64, image_tokens: u64, tiny: bool) -> Value {
    if image_tokens == 0 {
        return json!({ "ratio": 0.0, "level": "high", "approxAccuracy": "~98%", "note": "no imaged content" });
    }
    let r = (text_tokens as f64 / image_tokens as f64 * 10.0).round() / 10.0;
    let (mut level, mut acc): (&str, &str) = if r <= 8.0 {
        ("high", "~98%")
    } else if r <= 12.0 {
        ("good", "~90-97%")
    } else if r <= 16.0 {
        ("degraded", "~75-87%")
    } else if r <= 20.0 {
        ("low", "~60-75%")
    } else {
        ("unreliable", "<60%")
    };
    // 4x6 glyphs sit past the legibility cliff regardless of ratio (measured):
    // floor the band at `low`.
    let capped = tiny && order(level) < order("low");
    if capped {
        level = "low";
        acc = "~60-75%";
    }
    let clean = level == "high" || level == "good";
    let note = if clean {
        CLEAN.to_string()
    } else {
        format!("{}{}", CLIFF, if capped { TINY_CAP } else { "" })
    };
    json!({ "ratio": r, "level": level, "approxAccuracy": acc, "note": note })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bands_and_floor() {
        // reproduces the tier sweep: L0 ~4x high, distill ~14x degraded.
        assert_eq!(fidelity(3733, 896, false)["level"], "high");
        assert_eq!(fidelity(4000, 280, false)["level"], "degraded");
        // tiny floors to low even at a low ratio (measured 0/2).
        assert_eq!(fidelity(3733, 560, true)["level"], "low");
        assert_eq!(fidelity(30000, 1000, false)["level"], "unreliable");
        assert_eq!(fidelity(0, 0, false)["ratio"], json!(0.0));
    }
}
