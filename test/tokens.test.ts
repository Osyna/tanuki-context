// The estimator is checked against Anthropic's own tokenizer, not against
// itself. Every `tokens` figure below came from /v1/messages/count_tokens
// (claude-sonnet-4-5, envelope overhead subtracted) on exactly the string the
// generator beside it produces - see EVALS §9.
//
// This is the test that would have caught `chars / 4`, which was off by -72%
// on base64 and +38% on prose. A test asserting the estimator equals its own
// formula would have passed happily throughout.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// ---- held-out families, measured AFTER the weights were fitted -------------
// These were never in the fit. They are what turns "worst residual 19.8%" (the
// fit flattering itself) into a defensible bound: median 3.3% / worst 16.2% on
// real content, with one named pathological case. See EVALS section 9.
const uuid = Array.from({ length: 400 }, (_, i) => {
  const h = (n: number) => ((i * 2654435761 + n) >>> 0).toString(16).padStart(8, "0");
  return `${h(1)}-${h(2).slice(0, 4)}-${h(3).slice(0, 4)}-${h(4).slice(0, 4)}-${h(5)}${h(6).slice(0, 4)}`;
}).join("\n").slice(0, 24000);
const paths = Array.from({ length: 400 }, (_, i) => `/srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet`).join("\n").slice(0, 24000);
const mixedIds = Array.from({ length: 350 }, (_, i) =>
  `req=7f3a${((i * 2654435761) >>> 0).toString(16).slice(0, 8)} pod=api-7d9f${(i % 97).toString(16)}-x${i % 9} mac=${[0, 1, 2, 3, 4, 5].map((k) => ((i * 7 + k) % 256).toString(16).padStart(2, "0")).join(":")}`,
).join("\n").slice(0, 24000);
const camel = Array.from({ length: 300 }, (_, i) => `someLongCamelCaseIdentifierNumber${i} = anotherCamelCaseValue${i * 3};`).join("\n").slice(0, 24000);

const HELD_OUT: readonly (readonly [string, string, number])[] = [
  ["uuid", uuid, 10076],
  ["paths", paths, 6799],
  ["mixed-ids", mixedIds, 14442],
];

describe("held-out content the weights never saw", () => {
  test("real-world families stay inside the documented 20% bound", () => {
    for (const [name, text, real] of HELD_OUT) {
      const err = Math.abs(textTokens(text) / real - 1);
      expect([name, err < 0.2]).toEqual([name, true]);
    }
  });

  test("the camelCase pathology is a KNOWN bound, pinned so it cannot drift silently", () => {
    // Not a bug to fix: splitting runs at case transitions repairs this case but
    // costs 2.4 median points on all real content (EVALS section 9), so it was
    // measured and rejected. This test documents the ceiling, and fails if the
    // error moves materially in EITHER direction.
    const err = textTokens(camel) / 7799 - 1;
    expect(err).toBeGreaterThan(1.5);
    expect(err).toBeLessThan(3.5);
  });

  test("real source code does NOT trigger that pathology", () => {
    // punctuation, keywords and digits break the runs up
    const src = readFileSync(new URL("../src/needles.ts", import.meta.url), "utf8").slice(0, 24000);
    expect(Math.abs(textTokens(src) / 6724 - 1)).toBeLessThan(0.2);
  });
});
