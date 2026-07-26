// Stash mode: park text outside context, fetch slices back, auto-imaged when
// pages clearly win. Storage isolated per-run via TANUKI_STASH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const DIR = mkdtempSync(`${tmpdir()}/tanuki-stash-test-`);
process.env.TANUKI_STASH = DIR;

const { stashText, fetchSlice } = await import("../src/stash.ts");
const { toolFetch, toolStash } = await import("../src/main.ts");

const LOG = Array.from(
  { length: 400 },
  (_, i) => `2026-07-26T02:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 5} copied /srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet ok`,
).join("\n");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("stash", () => {
  test("content-addressed: same text, same id, byte-identical overview", () => {
    const a = stashText(LOG);
    const b = stashText(LOG);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    expect(a.overview).toBe(b.overview);
  });

  test("overview carries the map: sizes, distill stats, repeats, fetch hint", () => {
    const { id, overview } = stashText(LOG);
    const lines = overview.split("\n");
    expect(lines[0]).toBe(`stashed ${id} · ${Buffer.byteLength(LOG)} bytes · 400 lines`);
    expect(lines[1]).toStartWith("distill map: 400 -> ");
    expect(overview).toContain("top repeats:");
    expect(overview).toContain(`fetch: tanuki_fetch {"id":"${id}"`);
    // the map is cheap: a few hundred tokens, not the corpus
    expect(overview.length / 4).toBeLessThan(400);
  });

  test("fetch by lines returns the exact slice", () => {
    const { id } = stashText(LOG);
    const slice = fetchSlice(id, null, "2-3");
    expect(slice).toBe(LOG.split("\n").slice(1, 3).join("\n"));
  });

  test("fetch by query routes through distill; error lines always reachable", () => {
    const { id } = stashText(`${LOG}\n2026-07-26T03:00:00Z ERROR worker-3 connection reset by peer`);
    const slice = fetchSlice(id, "connection reset", null);
    expect(slice).toContain("ERROR worker-3 connection reset by peer");
    expect(slice.length).toBeLessThan(LOG.length);
  });
  test("small slice stays text; big repetitive slice comes back as pages", () => {
    const { id } = stashText(LOG);
    const small = toolFetch({ id, lines: "1-2" }) as { type: string; text?: string }[];
    expect(small).toHaveLength(1);
    expect(small[0].type).toBe("text");

    const big = toolFetch({ id, lines: "1-400" }) as { type: string; text?: string }[];
    expect(big[0].type).toBe("text");
    expect(big[0].text).toStartWith(`[tanuki-context stash ${id}: slice of `);
    expect(big.some((c) => c.type === "image")).toBe(true);
  });

  test("errors are exact: unknown id, bad range, arg misuse", () => {
    const { id } = stashText(LOG);
    expect(() => fetchSlice("000000000000", "x", null)).toThrow("unknown stash id: 000000000000");
    expect(() => fetchSlice(id, null, "9-1")).toThrow("bad lines range");
    expect(() => fetchSlice(id, null, "abc")).toThrow("bad lines range");
    expect(() => fetchSlice(id, "x", "1-2")).toThrow("give exactly one of query or lines");
    expect(() => fetchSlice(id, null, null)).toThrow("give exactly one of query or lines");
  });

  test("toolStash returns the overview as a single text block", () => {
    const out = toolStash({ text: "alpha\nbeta\ngamma" }) as { type: string; text: string }[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("· 3 lines");
    expect(out[0].text).toContain("first: alpha");
    expect(out[0].text).toContain("last: gamma");
  });
});
