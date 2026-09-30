// The no-regression gate's verdict (reference/gate.mjs compare): a number may
// move only in its good direction; speed gets a 2x noise band; a metric that
// stops being measured is a regression, a new one is not; hard limits bind.
import { expect, test } from "bun:test";
import { compare, driftPct, o200kCounter, SPEED_TOLERANCE } from "../reference/gate.mjs";
import { scoreReadback } from "../reference/readback-nightly.mjs";

const base = {
  saved: { value: 800, better: "higher" },
  chars: { value: 4495, better: "lower" },
  speed: { value: 1.0, better: "lower-speed" },
};

test("moves in the good direction pass and are listed as improvements", () => {
  const r = compare(base, { saved: { value: 810, better: "higher" }, chars: { value: 4400, better: "lower" }, speed: { value: 0.5, better: "lower-speed" } });
  expect(r.regressions).toEqual([]);
  expect(r.improvements).toEqual(["saved: 800 -> 810", "chars: 4495 -> 4400"]);
});

test("any move against the direction of a deterministic metric fails, by one unit", () => {
  const r = compare(base, { saved: { value: 799, better: "higher" }, chars: { value: 4496, better: "lower" }, speed: { value: 1, better: "lower-speed" } });
  expect(r.regressions).toHaveLength(2);
});

test("speed fails only past the noise band; hard limits bind whatever the baseline", () => {
  const within = { ...base, speed: { value: SPEED_TOLERANCE * 0.99, better: "lower-speed" } };
  expect(compare(base, within).regressions).toEqual([]);
  const past = { ...base, speed: { value: SPEED_TOLERANCE * 1.01, better: "lower-speed" } };
  expect(compare(base, past).regressions[0]).toStartWith("speed:");
  const quadratic = { ...base, scaling: { value: 9, better: "lower-speed", limit: 6 } };
  expect(compare(base, quadratic).regressions).toEqual(["scaling: 9 over its hard limit 6"]);
});

test("a metric that disappears fails; a new one does not", () => {
  const { saved: _gone, ...rest } = base;
  expect(compare(base, rest).regressions).toEqual(["saved: measured before (800), not measured now"]);
  expect(compare(base, { ...base, fresh: { value: 1, better: "higher" } }).regressions).toEqual([]);
});

test("a drift metric is gated downward; a baseline without it passes until --update records it", () => {
  const drift = { "estimator.drift_pct": { value: 35.69, better: "lower" } };
  expect(compare(drift, { "estimator.drift_pct": { value: 35.7, better: "lower" } }).regressions).toHaveLength(1);
  expect(compare(drift, { "estimator.drift_pct": { value: 30, better: "lower" } }).improvements).toEqual(["estimator.drift_pct: 35.69 -> 30"]);
  expect(compare({}, drift).regressions).toEqual([]);
});

test("driftPct averages per-payload error so opposite errors cannot cancel, and skips empty payloads", () => {
  expect(driftPct([[120, 100], [80, 100]])).toBe(20); // a sum-of-totals drift would say 0
  expect(driftPct([[5, 0], [110, 100]])).toBe(10);
  expect(driftPct([])).toBe(0);
});

test("the o200k counter is the real BPE, not chars/4", async () => {
  const tok = await o200kCounter();
  expect(tok("hello world")).toBe(2);
  expect(tok("a <|endoftext|> b")).toBeGreaterThan(3); // special-token text is counted as text, not rejected
});

test("read-back scoring is exact containment: one wrong character is a miss, prose and JSON both count", () => {
  const needles = [{ kind: "hex12 id", value: "b83839621bf0" }, { kind: "hex12 id", value: "45c55f8bd0a6" }, { kind: "uuid", value: "3451bd1b-13c4-4558-aa67-a62bc042905e" }];
  const s = scoreReadback(needles, 'I read ["b83839621bf0", "45c55f8bd0a8"] and the id 3451bd1b-13c4-4558-aa67-a62bc042905e');
  expect(s).toEqual({ hits: 2, total: 3, by_kind: { "hex12 id": 1, uuid: 1 }, misses: ["45c55f8bd0a6"] });
});

test("a digest is scored on its hex: dropping the sha256: label is not a misread, one wrong hex digit is", () => {
  const needles = [{ kind: "sha256:16", value: "sha256:26e7f9e3971a538a" }, { kind: "sha256:16", value: "sha256:79ea81cbb2651001" }];
  expect(scoreReadback(needles, '["26e7f9e3971a538a", "sha256:79ea81cbb2651002"]').hits).toBe(1);
});
