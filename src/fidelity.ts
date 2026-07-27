//! Read-back fidelity — DeepSeek-OCR's density cliff, made actionable.
//!
//! DeepSeek-OCR (arXiv:2510.18234, Fox Table 2) measures VLM transcription
//! precision against the compression ratio text-tokens / vision-tokens: ~98%
//! under 8x, ~97% at ~10x, ~87% by ~12x, and ~60% by ~20x. Our own tier sweep
//! (reference/tier-report.mjs) reproduces the curve — L0 (~4x) solves the task,
//! distill (~14x) is marginal. Font size is an orthogonal legibility axis the
//! ratio alone misses: the 4x6 `tiny` cell fails the task even at a low ratio
//! (measured 0/2 task, 3/10 needle recall), so it floors the band at `low`.
//!
//! Exact strings ride the verbatim sidecar as TEXT and are unaffected by this —
//! the signal bounds comprehension/read-back of the IMAGED bulk. `estimate`
//! reports it so the model reaches for a lossier tier knowingly, not blindly.
//!
//! Engine-parity: pure arithmetic on the same `rnd` (f64::round) the Rust port
//! uses; the ratio is a `Float` so whole values print `4.0` in both engines.
//! Object keys serialize sorted in both, so field order here is irrelevant.

import { Float, rnd } from "./serde.ts";

export type FidelityLevel = "high" | "good" | "degraded" | "low" | "unreliable";

export interface Fidelity {
  /** text tokens each vision token stands in for (DeepSeek-OCR compression ratio). */
  ratio: Float;
  level: FidelityLevel;
  /** approximate imaged read-back precision at this ratio (DeepSeek-OCR Fox curve). */
  approxAccuracy: string;
  note: string;
}

const ORDER: readonly FidelityLevel[] = ["high", "good", "degraded", "low", "unreliable"];

const CLEAN =
  "imaged pages read back cleanly; exact strings ride the verbatim sidecar as text";
const CLIFF =
  "imaged read-back degrades past the DeepSeek-OCR density cliff (arXiv:2510.18234) - use images for comprehension, not transcription; exact strings stay in the verbatim sidecar (default on), and a larger font or lower density restores read-back";
const TINY_CAP =
  " The 4x6 tiny font is past the legibility cliff (measured 3/10 needle recall) - reserve it for lossy bulk.";

/**
 * Map the imaged-config token ratio (+ tiny-font floor) to a read-back band.
 * Pure and engine-parity: same rounding, same thresholds as the Rust port.
 */
export function fidelity(textTokens: number, imageTokens: number, tiny: boolean): Fidelity {
  if (imageTokens <= 0) {
    return {
      ratio: new Float(0.0),
      level: "high",
      approxAccuracy: "~98%",
      note: "no imaged content",
    };
  }
  const r = rnd((textTokens / imageTokens) * 10.0) / 10.0;
  let level: FidelityLevel;
  let acc: string;
  if (r <= 8.0) {
    level = "high";
    acc = "~98%";
  } else if (r <= 12.0) {
    level = "good";
    acc = "~90-97%";
  } else if (r <= 16.0) {
    level = "degraded";
    acc = "~75-87%";
  } else if (r <= 20.0) {
    level = "low";
    acc = "~60-75%";
  } else {
    level = "unreliable";
    acc = "<60%";
  }
  // 4x6 glyphs sit past the legibility cliff regardless of ratio (measured):
  // floor the band at `low`.
  const capped = tiny && ORDER.indexOf(level) < ORDER.indexOf("low");
  if (capped) {
    level = "low";
    acc = "~60-75%";
  }
  const clean = level === "high" || level === "good";
  const note = clean ? CLEAN : CLIFF + (capped ? TINY_CAP : "");
  return { ratio: new Float(r), level, approxAccuracy: acc, note };
}

/** ponytail self-check: our own tier sweep should land on the documented bands. */
export function demo(): void {
  const assert = (c: boolean, m: string): void => {
    if (!c) throw new Error("fidelity demo: " + m);
  };
  // L0 normal ~4x -> high (task 2/2); distill ~14x -> degraded (1/2).
  assert(fidelity(3733, 896, false).level === "high", "L0 normal high");
  assert(fidelity(4000, 280, false).level === "degraded", "distill degraded");
  // L0 tiny at a low ratio still fails: font floor -> low (measured 0/2).
  assert(fidelity(3733, 560, true).level === "low", "tiny floored to low");
  // extreme density is unreliable for any read-back.
  assert(fidelity(30000, 1000, false).level === "unreliable", ">20x unreliable");
  // band edges land on the low side (<=), and empty is a no-op.
  assert(fidelity(800, 100, false).level === "high", "ratio 8 is high");
  assert(fidelity(0, 0, false).ratio.value === 0.0, "empty ratio 0");
  // eslint-disable-next-line no-console
  console.log("fidelity demo ok");
}

if (import.meta.main) demo();
