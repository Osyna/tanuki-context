// The no-regression gate's verdict (reference/gate.mjs compare): a number may
// move only in its good direction; speed gets a 2x noise band; a metric that
// stops being measured is a regression, a new one is not; hard limits bind.
import { expect, test } from "bun:test";
import { compare, SPEED_TOLERANCE } from "../reference/gate.mjs";

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
