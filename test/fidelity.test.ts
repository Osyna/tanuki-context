// Research-driven fidelity work (DeepSeek-OCR density cliff + OCR-B/UTS-39
// confusability, arXiv:2510.18234 / ECMA-1073): the estimate fidelity band and
// the codebook-sigil confusability guard. The band tests pin the cliff mapping
// to our own tier-sweep outcomes; the guard proves no sigil is more confusable
// with a content char than 0 and O already are, at the production 5x8 cell.
import { describe, expect, test } from "bun:test";
import { fidelity } from "../src/fidelity.ts";
import { SIGILS } from "../src/codebook.ts";
import { CELL_H, CELL_W, coverage, isWide, rank } from "../src/atlas.ts";

describe("fidelity: DeepSeek-OCR density cliff", () => {
  test("bands map ratio to read-back accuracy", () => {
    expect(fidelity(800, 100, false).level).toBe("high"); // 8x edge
    expect(fidelity(1200, 100, false).level).toBe("good"); // 12x
    expect(fidelity(1600, 100, false).level).toBe("degraded"); // 16x
    expect(fidelity(2000, 100, false).level).toBe("low"); // 20x
    expect(fidelity(3000, 100, false).level).toBe("unreliable"); // 30x
  });

  test("reproduces our tier sweep outcomes", () => {
    // L0 normal ~4x solved 2/2; distill ~14x marginal 1/2.
    expect(fidelity(3733, 896, false).level).toBe("high");
    expect(fidelity(4000, 280, false).level).toBe("degraded");
  });

  test("tiny 4x6 font floors the band at low regardless of ratio", () => {
    // ratio 6.7x would be "high" on a normal font, but 4x6 sits past the
    // legibility cliff (measured 0/2 task, 3/10 needle) -> capped low.
    const f = fidelity(3733, 560, true);
    expect(f.level).toBe("low");
    expect(f.note).toContain("tiny font");
  });

  test("ratio is a float and empty input is a no-op", () => {
    expect(fidelity(4000, 280, false).ratio.value).toBeCloseTo(14.3, 5);
    expect(fidelity(0, 0, false).ratio.value).toBe(0);
    expect(fidelity(0, 0, false).level).toBe("high");
  });
});

describe("codebook sigils: OCR-B/UTS-39 confusability guard", () => {
  const cp = (c: string): number => c.codePointAt(0)!;
  const cov = (c: string): Uint8Array | null => {
    const r = rank(cp(c));
    if (r < 0 || isWide(r)) return null;
    return coverage(r);
  };
  const dist = (a: Uint8Array, b: Uint8Array): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d;
  };
  // The tolerated baseline: 0 and O are a real confusable pair every model
  // already lives with. No project sigil may be closer to any content glyph.
  const baseline = dist(coverage(rank(cp("O")))!, coverage(rank(cp("0")))!);

  test("baseline 0/O is a genuine near-pair (sanity)", () => {
    expect(baseline).toBeGreaterThan(0);
    // distinct letters are far more separated than the 0/O pair
    expect(dist(coverage(rank(cp("A")))!, coverage(rank(cp("B")))!)).toBeGreaterThan(baseline);
  });

  test("every sigil is a single 5x8 cell, in the atlas", () => {
    for (const s of SIGILS) {
      const r = rank(cp(s));
      expect(r).toBeGreaterThanOrEqual(0);
      expect(isWide(r)).toBe(false);
      expect(coverage(r).length).toBe(CELL_W * CELL_H);
    }
  });

  test("no sigil is more confusable with a content char than 0/O", () => {
    const ascii: string[] = [];
    for (let c = 0x20; c <= 0x7e; c++) ascii.push(String.fromCodePoint(c));
    for (const s of SIGILS) {
      const a = cov(s)!;
      let min = Infinity;
      let who = "";
      for (const c of ascii) {
        const b = cov(c);
        if (b === null || b.length !== a.length) continue;
        const d = dist(a, b);
        if (d < min) {
          min = d;
          who = c;
        }
      }
      expect(min).toBeGreaterThan(baseline);
    }
  });

  test("sigils are mutually distinct (no two share a near-identical glyph)", () => {
    const arr = [...SIGILS];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = cov(arr[i]);
        const b = cov(arr[j]);
        if (a && b && a.length === b.length) {
          expect(dist(a, b)).toBeGreaterThan(baseline);
        }
      }
    }
  });
});
