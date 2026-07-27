// Stash mode: park text outside context, fetch slices back, auto-imaged when
// pages clearly win. Storage isolated per-run via TANUKI_STASH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const DIR = mkdtempSync(`${tmpdir()}/tanuki-stash-test-`);
process.env.TANUKI_STASH = DIR;

const { stashText, fetchSlice, verifyValue } = await import("../src/stash.ts");
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

describe("run wrapper (rtk-style)", () => {
  test("exit code passes through; frames collapse; errors verbatim", () => {
    const script = 'for i in 1 2 3 4 5 6 7 8; do echo "copied file_$i.dat ok"; done; printf "pull: 10%%\\rpull: 99%%\\rpull: done\\n"; echo "ERROR real failure" >&2; exit 3';
    const r = Bun.spawnSync(["node", "dist/cli.js", "run", "--", "sh", "-c", script]);
    expect(r.exitCode).toBe(3);
    const out = r.stdout.toString();
    expect(out).toStartWith("[tanuki run] exit 3 ·");
    expect(out).toContain("pull: done");
    expect(out).not.toContain("pull: 10%");
    expect(out).toContain("ERROR real failure");
    expect(out).toContain("×8 (template)");
  });

  test("huge output is stashed with a fetch pointer", () => {
    const script = 'i=0; while [ $i -lt 3000 ]; do echo "line $i of much repeated output padding padding"; i=$((i+1)); done';
    const r = Bun.spawnSync(["node", "dist/cli.js", "run", "--", "sh", "-c", script], {
      env: { ...process.env, TANUKI_STASH: DIR },
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain("stashed");
    expect(out).toMatch(/fetch [0-9a-f]{12}|tanuki_fetch \{"id"/);
  });
});

describe("verify: disk-grounded exact check", () => {
  const NEEDLES = "alpha beta\nid 3451bd1b-13c4-4558-aa67-a62bc042905e end\ngamma cafe1234 and cafe1235 delta\n";

  test("exact match returns the line, no candidates", () => {
    const { id } = stashText(NEEDLES);
    const r = verifyValue(id, "3451bd1b-13c4-4558-aa67-a62bc042905e");
    expect(r.status).toBe("exact");
    expect(r.line).toBe(2);
    expect(r.found).toBe("3451bd1b-13c4-4558-aa67-a62bc042905e");
    expect(r.candidates).toEqual([]);
  });

  test("one-character misread is corrected to the unique on-disk value", () => {
    const { id } = stashText(NEEDLES);
    const r = verifyValue(id, "3451bd1b-13c4-4558-aa67-a62bc042905f"); // last char e->f
    expect(r.status).toBe("corrected");
    expect(r.found).toBe("3451bd1b-13c4-4558-aa67-a62bc042905e");
    expect(r.line).toBe(2);
  });

  test("adjacent transposition (digit swap) is corrected", () => {
    const { id } = stashText(NEEDLES);
    const r = verifyValue(id, "3451bd1b-13c4-4558-aa67-a62bc04290e5"); // ...905e -> ...90e5
    expect(r.status).toBe("corrected");
    expect(r.found).toBe("3451bd1b-13c4-4558-aa67-a62bc042905e");
    expect(r.line).toBe(2);
  });

  test("several distance-1 neighbours -> ambiguous shortlist, sorted", () => {
    const { id } = stashText(NEEDLES);
    const r = verifyValue(id, "cafe1230");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates).toEqual(["cafe1234", "cafe1235"]);
    expect(r.found).toBeNull();
  });

  test("no match -> absent, never a guess", () => {
    const { id } = stashText(NEEDLES);
    expect(verifyValue(id, "ffffffff-0000-0000-0000-000000000000").status).toBe("absent");
  });

  test("short values get exact-or-absent only (no fuzzy noise)", () => {
    const { id } = stashText(NEEDLES);
    expect(verifyValue(id, "cafe1234").status).toBe("exact");
    expect(verifyValue(id, "xyz").status).toBe("absent");
  });

  test("empty value and unknown id throw the contract errors", () => {
    const { id } = stashText(NEEDLES);
    expect(() => verifyValue(id, "")).toThrow("non-empty");
    expect(() => verifyValue("deadbeefcafe", "whatever")).toThrow("unknown stash id");
  });
});
