// The estimator is checked against Anthropic's own tokenizer, not against
// itself. Every `tokens` figure below came from /v1/messages/count_tokens
// (claude-sonnet-4-5, envelope overhead subtracted) on exactly the string the
// generator beside it produces - see EVALS §9.
//
// This is the test that would have caught `chars / 4`, which was off by -72%
// on base64 and +38% on prose. A test asserting the estimator equals its own
// formula would have passed happily throughout.

import { describe, expect, test } from "bun:test";
import { textTokens } from "../src/serde.ts";

const svcLog = Array.from(
  { length: 400 },
  (_, i) =>
    `2026-07-27T08:${String(i % 60).padStart(2, "0")}:0${i % 10}Z worker-${i % 5} INFO poll ok req=7f3a${((i * 2654435761) >>> 0).toString(16).slice(0, 8)} conn=${i % 40}/64 latency=${i % 900}ms`,
).join("\n");
const prose = Array.from(
  { length: 40 },
  () => "The router compares estimated token counts before it decides anything, so an estimate that is wrong quietly makes the decision wrong too.",
).join(" ");
const json = JSON.stringify(
  Array.from({ length: 300 }, (_, i) => ({ id: i, host: `node-${i % 12}.eu-west-1`, ok: i % 7 !== 0, ms: i % 900, hash: ((i * 2654435761) >>> 0).toString(16) })),
  null,
  2,
);
const hex = Array.from({ length: 500 }, (_, i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, "0")).join(" ");
const base64 = Buffer.from(Array.from({ length: 12000 }, (_, i) => i % 251)).toString("base64");
const csv = Array.from({ length: 700 }, (_, i) => `${i},node-${i % 12},${i % 900},${(i * 7) % 1000},ok`).join("\n");
const stack = Array.from({ length: 200 }, (_, i) => `  at com.example.svc.Handler$Inner.process(Handler.java:${100 + i})`).join("\n");

/** [name, text, tokens measured by the real tokenizer] */
const MEASURED: readonly (readonly [string, string, number])[] = [
  ["service-log", svcLog, 17300],
  ["prose", prose, 1000],
  ["json", json, 17074],
  ["hex", hex, 2904],
  ["base64", base64, 14037],
  ["csv", csv, 8400],
  ["stack-trace", stack, 4399],
];

describe("textTokens tracks the real tokenizer", () => {
  test("every measured sample lands within 25%", () => {
    for (const [name, text, real] of MEASURED) {
      const err = Math.abs(textTokens(text) / real - 1);
      expect(`${name} ${(err * 100).toFixed(1)}%`).toBe(`${name} ${(err * 100).toFixed(1)}%`);
      expect(err).toBeLessThan(0.25);
    }
  });

  test("chars/4 would fail this suite - the bound is not vacuous", () => {
    // If this ever stops failing, the samples no longer discriminate and the
    // suite above has quietly become decorative.
    const worst = Math.max(...MEASURED.map(([, t, real]) => Math.abs(t.length / 4 / real - 1)));
    expect(worst).toBeGreaterThan(0.5);
  });

  test("log-like content, the domain that matters, lands within 12%", () => {
    for (const [name, text, real] of [MEASURED[0], MEASURED[5], MEASURED[6]]) {
      const err = Math.abs(textTokens(text) / real - 1);
      expect([name, err < 0.12]).toEqual([name, true]);
    }
  });

  test("degenerate inputs do not throw or go negative", () => {
    for (const s of ["", " ", "\n", "a", "1", "!!!", "\u00e9\u4e2d\u6587", "\u{1f600}"]) {
      const n = textTokens(s);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(textTokens("")).toBe(0);
  });

  test("a word-like run is far cheaper per char than a random one", () => {
    // the split the whole model rests on: same length, different tokenisation
    expect(textTokens("consideration")).toBeLessThan(textTokens("f3a9c2e17b4d0"));
  });
});
