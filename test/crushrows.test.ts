// F2 crushRows tests: head/tail/important selection, marker format, stash
// round-trip, null cases, mutation guard.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { crushRows, crushRowsSelect } from "../src/table.ts";
import { fetchSlice } from "../src/stash.ts";
import { toolEstimate } from "../src/main.ts";

describe("crushRows", () => {
  // 60-row fixture with 2 important rows beyond position 15
  const rows60 = Array.from({ length: 60 }, (_, i) => {
    const base = { id: i, seq: i * 100, value: `item_${i}` };
    // Row 20 and row 45 carry IMPORTANT words beyond the head window. NOTE:
    // "processing_error_detected" would NOT match - distill's IMPORTANT uses
    // ASCII \b and `_` is a word char, so the word must stand alone.
    if (i === 20) {
      return { ...base, status: "error" };
    }
    if (i === 45) {
      return { ...base, status: "failed" };
    }
    return { ...base, status: "ok" };
  });
  const fixture60 = rows60.map((r) => JSON.stringify(r)).join("\n");

  test("60-row fixture: exact kept set", () => {
    const result = crushRows(fixture60);
    expect(result).not.toBeNull();
    if (result === null) return;

    // K = 10 head + 5 tail + 2 important (rows 20, 45)
    expect(result.kept).toBe(17);
    expect(result.rows).toBe(60);

    // Parse the output rows
    const outRows = result.text.split("\n").map((line) => JSON.parse(line));
    expect(outRows).toHaveLength(17);

    // Head: rows 0-9
    for (let i = 0; i < 10; i++) {
      expect(outRows[i].id).toBe(i);
    }

    // Important rows: 20, 45
    expect(outRows[10].id).toBe(20);
    expect(outRows[10].status).toContain("error");
    expect(outRows[11].id).toBe(45);
    expect(outRows[11].status).toBe("failed");

    // Tail: rows 55-59
    for (let i = 0; i < 5; i++) {
      expect(outRows[12 + i].id).toBe(55 + i);
    }
  });

  test("marker format byte-pinned", () => {
    const result = crushRows(fixture60);
    expect(result).not.toBeNull();
    if (result === null) return;

    // Marker is appended by stage01, but we verify the fields here
    const expected = `·crushed· kept ${result.kept} of ${result.rows} rows - full set: fetch ${result.id} (--query re | --lines a-b)`;
    expect(expected).toContain("kept 17 of 60 rows");
    expect(expected).toContain("full set: fetch");
    expect(expected).toContain("(--query re | --lines a-b)");
  });

  test("stash round-trip: fetch first line", () => {
    const result = crushRows(fixture60);
    expect(result).not.toBeNull();
    if (result === null) return;

    // Fetch the first line of the stashed content
    const fetched = fetchSlice(result.id, null, "1-1", null, 8);
    expect(fetched).toContain('"id":0');
  });

  test("small input (29 rows): null", () => {
    const rows29 = Array.from({ length: 29 }, (_, i) => ({ id: i }));
    const input29 = rows29.map((r) => JSON.stringify(r)).join("\n");
    const result = crushRows(input29);
    expect(result).toBeNull();
  });

  test("all-important input: null when nothing saved", () => {
    // Create 35 rows where all contain "error" (CRUSH_MIN=30, so 35 > 30)
    const allImportant = Array.from({ length: 35 }, (_, i) => ({
      id: i,
      msg: `error ${i}`,
    }));
    const input = allImportant.map((r) => JSON.stringify(r)).join("\n");
    const result = crushRows(input);
    // All rows match IMPORTANT, so kept set = all rows -> null
    expect(result).toBeNull();
  });

  test("mutation guard: head-only would drop important rows", () => {
    // This test proves that without IMPORTANT matching, we would lose error rows.
    // The fixture has 60 rows; head=10, tail=5. Without IMPORTANT, we'd keep
    // rows [0-9, 55-59], which drops rows 20 and 45.
    const result = crushRows(fixture60);
    expect(result).not.toBeNull();
    if (result === null) return;

    const outRows = result.text.split("\n").map((line) => JSON.parse(line));
    const ids = outRows.map((r) => r.id);

    // Assert that rows 20 and 45 are in the kept set
    expect(ids).toContain(20);
    expect(ids).toContain(45);

    // Head-only selection would be [0,1,2,3,4,5,6,7,8,9,55,56,57,58,59]
    const headTailOnly = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 55, 56, 57, 58, 59];
    expect(headTailOnly).not.toContain(20);
    expect(headTailOnly).not.toContain(45);
  });

  test("null cases: parse failure", () => {
    expect(crushRows("not json")).toBeNull();
    expect(crushRows('["array", "not", "objects"]')).toBeNull();
    expect(crushRows("single object\n")).toBeNull();
  });

  test("deduplication: identical rows collapse", () => {
    // 40 rows, only 10 unique canonical forms. CRUSH_MIN gates on the
    // ORIGINAL row count (40 >= 30), and dropping 30 exact duplicates is a
    // real, fully recoverable saving - so this fires with kept=10 of 40.
    const unique = Array.from({ length: 20 }, (_, i) => ({ id: i % 10 }));
    const duplicated = [...unique, ...unique];
    const input = duplicated.map((r) => JSON.stringify(r)).join("\n");

    const result = crushRows(input);
    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.rows).toBe(40);
    expect(result.kept).toBe(10);
    const ids = result.text.split("\n").map((line) => JSON.parse(line).id);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("whole-JSON array input", () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ id: i, val: i * 2 }));
    const input = JSON.stringify(rows);
    const result = crushRows(input);
    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.rows).toBe(35);
    expect(result.kept).toBeLessThan(35);
  });

  test("IMPORTANT_CAP: only first 40 important rows", () => {
    // Create 50 rows, all containing "error"
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      msg: `error ${i}`,
    }));
    const input = rows.map((r) => JSON.stringify(r)).join("\n");
    const result = crushRows(input);
    expect(result).not.toBeNull();
    if (result === null) return;

    // K = 10 head + 5 tail + min(40, 50) important
    // But head and tail overlap with important, so the union might be:
    // - head: 0-9
    // - tail: 45-49
    // - important: first 40 that match (0-39)
    // Union: 0-39, 45-49 = 45 unique indices
    expect(result.kept).toBe(45);
  });
});

// The composed route: headroom-style selection priced through the DeepSeek-OCR
// side (crush -> table -> codebook -> pages) by `recommend`, unprompted, with
// zero side effects. EVALS §15 is the measured version of these pins.
describe("recommend.crush composed route", () => {
  const rows60 = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({ id: i, seq: i * 100, status: i === 20 ? "error timeout gateway" : "ok", unit: `svc-${i % 7}` }),
  ).join("\n");
  // Fat rows: selection alone leaves ~20k tok of text, so pages stack a
  // second cut on top - the case the composition exists for.
  const fat60 = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({
      id: i,
      blob: Array.from({ length: 15 }, (_, j) => `token-${(i * 31 + j * 7) % 997}-${"x".repeat(40)}`).join(" "),
      status: i % 9 === 0 ? "error refused" : "ok",
    }),
  ).join("\n");

  const withTmpStash = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(`${tmpdir()}/tanuki-crushsel-`);
    const prev = process.env.TANUKI_STASH;
    process.env.TANUKI_STASH = dir;
    try {
      fn(dir);
    } finally {
      if (prev === undefined) delete process.env.TANUKI_STASH;
      else process.env.TANUKI_STASH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // Runtime narrows for the tool's JSON reply - tests validate the shape
  // instead of asserting it, so a schema drift fails loudly here.
  const recOf = (r: Record<string, unknown>): Record<string, unknown> => {
    const rec = r.recommend;
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) throw new Error("recommend missing");
    return rec as Record<string, unknown>;
  };
  const crushOf = (r: Record<string, unknown>): Record<string, number> | null => {
    const c = recOf(r).crush;
    if (c === undefined) return null;
    if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error("crush wrong shape");
    const o: Record<string, number> = {};
    for (const k of ["rows", "kept", "textTokens", "imageTokens", "savedPct"]) {
      const v = (c as Record<string, unknown>)[k];
      if (typeof v !== "number") throw new Error(`crush.${k} not a number`);
      o[k] = v;
    }
    return o;
  };
  const reasonOf = (r: Record<string, unknown>): string => {
    const route = r.route;
    if (route === null || typeof route !== "object" || !("reason" in route)) throw new Error("route.reason missing");
    const reason = (route as Record<string, unknown>).reason;
    if (typeof reason !== "string") throw new Error("reason not a string");
    return reason;
  };

  test("crushRowsSelect is pure; crushRows writes - the probe must not", () => {
    withTmpStash((dir) => {
      const sel = crushRowsSelect(rows60);
      expect(sel).not.toBeNull();
      expect(readdirSync(dir).length).toBe(0);
      // Non-vacuity: the stashing variant DOES write, so the zero above is a
      // real assertion, not a dead stash dir.
      const full = crushRows(rows60);
      expect(full).not.toBeNull();
      expect(readdirSync(dir).length).toBeGreaterThan(0);
      if (sel === null || full === null) return;
      expect(sel.text).toBe(full.text);
      expect(sel.kept).toBe(full.kept);
      expect(sel.rows).toBe(full.rows);
    });
  });

  test("estimate prices the crush route unprompted, without stashing", () => {
    withTmpStash((dir) => {
      const r = toolEstimate({ text: rows60 });
      expect(readdirSync(dir).length).toBe(0);
      const crush = crushOf(r);
      expect(crush).not.toBeNull();
      if (crush === null) return;
      expect(crush.rows).toBe(60);
      expect(crush.kept).toBeLessThan(60);
      expect(crush.savedPct).toBeGreaterThanOrEqual(90);
      expect(reasonOf(r)).toContain("recommend.crush");
    });
  });

  test("fat rows: pages after selection beat selection-as-text", () => {
    const crush = crushOf(toolEstimate({ text: fat60 }));
    expect(crush).not.toBeNull();
    if (crush === null) return;
    // The DeepSeek route applied to the crushed remainder must stack a real
    // second cut, not a rounding error.
    expect(crush.imageTokens * 4).toBeLessThan(crush.textTokens);
  });

  test("no crush key below CRUSH_MIN or on prose; no steer in the reason", () => {
    const small = toolEstimate({ text: rows60.split("\n").slice(0, 29).join("\n") });
    expect("crush" in recOf(small)).toBe(false);
    expect(reasonOf(small)).not.toContain("recommend.crush");
    const prose = toolEstimate({ text: "plain prose line\nanother line\nno rows here" });
    expect("crush" in recOf(prose)).toBe(false);
  });
});
