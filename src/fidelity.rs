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

/// Models measured as unable to read dense pages at all: their TEXT arm holds
/// at 100% while their IMAGE arm collapses to 0% on the same task and corpus
/// (EVALS section 3, n=8). The band is calibrated to a capable reader, so for
/// these it is not merely optimistic - it is wrong. Safe to pin, unlike a
/// model->context-window table: a model id names an immutable snapshot. The
/// list only grows; an unmeasured model is treated as capable.
const WEAK_READERS: [&str; 2] = ["claude-haiku-4-5", "claude-sonnet-4-5"];

pub fn weak_reader(model: Option<&str>) -> bool {
    model.is_some_and(|m| WEAK_READERS.iter().any(|w| m.starts_with(w)))
}

const WEAK_NOTE: &str = "this model is measured at 0% task success on imaged pages while scoring 100% on the same task as text (EVALS \u{a7}3) - it cannot read dense pages; keep this content as text";

/// Map the imaged-config token ratio (+ tiny-font floor, + reader capability)
/// to a read-back band.
pub fn fidelity(text_tokens: u64, image_tokens: u64, tiny: bool, weak: bool) -> Value {
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
    // A reader measured at 0% on pages makes the density band moot: no ratio
    // is "clean" for a model that cannot read the page at all.
    if weak {
        return json!({ "ratio": r, "level": "unreliable", "approxAccuracy": "0% (measured, this model)", "note": WEAK_NOTE });
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
        assert_eq!(fidelity(3733, 896, false, false)["level"], "high");
        assert_eq!(fidelity(4000, 280, false, false)["level"], "degraded");
        // tiny floors to low even at a low ratio (measured 0/2).
        assert_eq!(fidelity(3733, 560, true, false)["level"], "low");
        assert_eq!(fidelity(30000, 1000, false, false)["level"], "unreliable");
        assert_eq!(fidelity(0, 0, false, false)["ratio"], json!(0.0));
    }
}
#[cfg(test)]
mod reader_tests {
    use super::*;

    /// EVALS section 3 (n=8): these ids score 100% on the task as text and 0%
    /// on the same task as imaged pages.
    #[test]
    fn weak_reader_floors_the_band() {
        let clean = fidelity(3733, 896, false, false);
        assert_eq!(clean["level"], "high");
        let weak = fidelity(3733, 896, false, true);
        assert_eq!(weak["level"], "unreliable");
        assert_eq!(weak["ratio"], clean["ratio"]); // density fine, reader is not
        assert!(weak["note"].as_str().unwrap().contains("cannot read dense pages"));
    }

    #[test]
    fn only_measured_ids_are_weak() {
        assert!(!weak_reader(None));
        assert!(!weak_reader(Some("claude-opus-5")));
        assert!(!weak_reader(Some("claude-sonnet-5")));
        assert!(!weak_reader(Some("some-future-model")));
        assert!(weak_reader(Some("claude-haiku-4-5")));
        assert!(weak_reader(Some("claude-sonnet-4-5")));
        assert!(weak_reader(Some("claude-haiku-4-5-20251001")));
        assert!(weak_reader(Some("claude-sonnet-4-5-20250929")));
    }
}
