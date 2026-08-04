// Stash mode: park text outside context, fetch slices back, auto-imaged when
// pages clearly win. Storage isolated per-run via TANUKI_STASH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DIR = mkdtempSync(`${tmpdir()}/tanuki-stash-test-`);
process.env.TANUKI_STASH = DIR;

// Dynamic on purpose: TANUKI_STASH must be set above before these modules are
// evaluated, so the whole suite reads and writes the throwaway dir on line 7.
const { stashText, fetchSlice, matchCount, verifyValue } = await import("../src/stash.ts");
const { toolFetch, toolStash } = await import("../src/main.ts");
const { redactCredentials } = await import("../src/needles.ts");

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

  // An imaged fetch used to ship pages with NO verbatim sidecar, on the very
  // path the manual recommends for large references: every id in the slice
  // rode as unprotected pixels, and an agent that could not read one just
  // fetched again (the loop thrash in EVALS §6).
  test("an imaged fetch ships its verbatim sidecar", () => {
    const withIds = Array.from(
      { length: 400 },
      (_, i) => `2026-07-26T01:00:00Z INFO worker copied /srv/data/shard/segment_${String(i).padStart(5, "0")}.parquet ok`,
    ).join("\n");
    const { id } = stashText(`${withIds}\nrelay dest=86:2b:11:51:58:03 sha 6c9224c done`);
    const out = toolFetch({ id, lines: "1-401" }) as { type: string; text?: string }[];
    expect(out.some((c) => c.type === "image")).toBe(true);
    const side = out.find((c) => c.type === "text" && (c.text ?? "").startsWith("·verbatim·"));
    expect(side).toBeDefined();
    expect(side?.text).toContain("86:2b:11:51:58:03");
    expect(side?.text).toContain("6c9224c");
    expect(out[0].text).toContain("·verbatim· block next carries");
    // exact strings must precede the pixels, not trail them
    expect(out.findIndex((c) => (c.text ?? "").startsWith("·verbatim·"))).toBeLessThan(out.findIndex((c) => c.type === "image"));
  });

  test("a needle-dense slice is never imaged", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a token=${String(i).padStart(4, "0")}cafebabe9f21`);
    const { id } = stashText(ids.join("\n"));
    const out = toolFetch({ id, lines: "1-400" }) as { type: string; text?: string }[];
    expect(out.some((c) => c.type === "image")).toBe(false);
    expect(out).toHaveLength(1);
  });

  // The credential gate only ever refused to IMAGE a secret; fetch handed one
  // straight back as text, which is the same secret in the same context window
  // by a shorter route. The stash still stores raw bytes - redact:false proves
  // it - but the default outgoing slice is masked, and says so.
  test("fetch redacts credential-shaped values by default; redact:false returns the bytes", () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRETdeadbeef";
    const { id } = stashText(`svc boot ok\napi_key="${secret}"\nAKIAIOSFODNN7EXAMPLE trailing\n`);
    const out = toolFetch({ id, lines: "1-3" }) as { type: string; text: string }[];
    expect(out).toHaveLength(1);
    expect(out[0].text).not.toContain(secret);
    expect(out[0].text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // visible, and the placeholder sits exactly where the value did
    expect(out[0].text).toStartWith("[2 credential(s) redacted - redact:false to include]\n");
    expect(out[0].text).toContain('api_key="[redacted:api-key]"');
    expect(out[0].text).toContain("[redacted:aws-key] trailing");
    // opt-out: byte-identical to the stashed original, no notice line
    const plain = toolFetch({ id, lines: "1-3", redact: false }) as { text: string }[];
    expect(plain[0].text).toBe(fetchSlice(id, null, "1-3"));
    expect(plain[0].text).toContain(secret);
    // credential-free content is untouched either way
    const clean = stashText(LOG);
    expect((toolFetch({ id: clean.id, lines: "1-2" }) as { text: string }[])[0].text).toBe(fetchSlice(clean.id, null, "1-2"));
  });

  // Slices cannot count what they do not show: the distilled slice is
  // context-padded and collapsed, so an agent comparing frequencies needs the
  // raw match count. Without it the "which unit logged the most errors" task
  // was unanswerable through the tools at all (EVALS §6).
  test("a query fetch reports how many raw lines matched", () => {
    const units = ["alpha", "beta", "gamma"];
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      const u = units[i % 3];
      // alpha gets 3x the errors of the others, by construction
      lines.push(u === "alpha" && i % 6 === 0 ? `svc ${u} ERROR boom` : i % 30 === 0 ? `svc ${u} ERROR boom` : `svc ${u} INFO ok`);
    }
    const { id } = stashText(`${lines.join("\n")}\n`);
    const counts = units.map((u) => {
      const out = toolFetch({ id, query: `${u} ERROR` }) as { type: string; text?: string }[];
      const m = /matched (\d+) of (\d+) lines/.exec(out[0].text ?? "");
      expect(m).not.toBeNull();
      return Number(m?.[1]);
    });
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[0]).toBeGreaterThan(counts[2]);
    // a lines fetch carries no query, so it reports no count
    const byLines = toolFetch({ id, lines: "1-3" }) as { text?: string }[];
    expect(byLines[0].text).not.toContain("matched");
  });

  // EVALS §7: the sidecar misses pure-random alphabetic ids (70-76% on the
  // adversarial shapes) because structure cannot tell them from words. That is
  // a documented bound, not unprotected data - verify covers what the sidecar
  // does not, with no model in the loop.
  test("ids the sidecar misses are still covered by verify", () => {
    const ids = ["UXASIMOWMOFRUAB", "oazhseiengfosy", "qsYfhjBOhAqAOqRRr"];
    const { id } = stashText(`${ids.map((v, i) => `2026-07-27T09:0${i}:00Z relay INFO ref=${v} ok`).join("\n")}\n`);
    for (const v of ids) {
      expect(verifyValue(id, v).status).toBe("exact");
      const flipped = `${v.slice(0, 4)}${v[4] === "a" ? "b" : "a"}${v.slice(5)}`;
      expect(verifyValue(id, flipped).status).toBe("corrected");
    }
  });

  test("errors are exact: unknown id, bad range, arg misuse", () => {
    const { id } = stashText(LOG);
    expect(() => fetchSlice("000000000000", "x", null)).toThrow("unknown stash id: 000000000000");
    expect(() => fetchSlice(id, null, "9-1")).toThrow("bad lines range");
    expect(() => fetchSlice(id, null, "abc")).toThrow("bad lines range");
    expect(() => fetchSlice(id, "x", "1-2")).toThrow("give exactly one of query, lines or find");
    expect(() => fetchSlice(id, null, null)).toThrow("give exactly one of query, lines or find");
  });

  // Issue #2: the id indexes a content-addressed file, so a caller-supplied
  // path is never a legitimate id. The sentinel is a REAL file one level out
  // of the stash dir, so a passing test means the read was refused, not that
  // it merely missed. All three read sites are covered because all three
  // built the path themselves, and `find`/`query` turn one into a grep oracle.
  test("traversal ids are refused at every read site", () => {
    const secret = `${DIR}/../tanuki-traversal-secret.txt`;
    writeFileSync(secret, "SENTINEL topsecret\n");
    try {
      const escapes = [
        "../tanuki-traversal-secret.txt",
        secret, // absolute: harmless here, but PathBuf::join drops the base in Rust
        "..",
        "DEADBEEFCAFE", // a sha256 hex prefix is lowercase
        "deadbeefcaf", // 11
        "deadbeefcafe1", // 13
      ];
      for (const bad of escapes) {
        const want = `unknown stash id: ${bad}`;
        expect(() => fetchSlice(bad, null, "1-2")).toThrow(want);
        expect(() => fetchSlice(bad, "SENTINEL", null)).toThrow(want);
        expect(() => fetchSlice(bad, null, null, "SENTINEL")).toThrow(want);
        expect(() => matchCount(bad, "SENTINEL")).toThrow(want);
        expect(() => verifyValue(bad, "topsecret")).toThrow(want);
      }
      // The guard rejects only what stashText cannot mint: real ids still read.
      const { id } = stashText(LOG);
      expect(fetchSlice(id, null, "1-1")).toContain("worker-0");
      expect(matchCount(id, "INFO").matched).toBe(400);
      expect(verifyValue(id, "segment_00000").status).toBe("exact");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  // The stash deliberately holds unredacted bytes, so creation is owner-only
  // rather than umask-default (0755/0644). Asserting the group/other bits are
  // clear rather than an exact mode keeps this true under any sane umask.
  test("stash is created owner-only", () => {
    const nested = `${DIR}/perm-check`;
    const prev = process.env.TANUKI_STASH;
    process.env.TANUKI_STASH = nested;
    try {
      const { id } = stashText("alpha\nbeta\n");
      expect(statSync(nested).mode & 0o077).toBe(0);
      expect(statSync(`${nested}/${id}`).mode & 0o077).toBe(0);
    } finally {
      process.env.TANUKI_STASH = prev;
    }
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
  // Real node subprocess: cold start on a shared CI runner has blown bun's
  // 5s default (5,266ms on GitHub Actions) while the logic passes in ~70ms
  // locally - the generous ceiling guards the runner, not the code.
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
  }, 20000);

  test("huge output is stashed with a fetch pointer", () => {
    const script = 'i=0; while [ $i -lt 3000 ]; do echo "line $i of much repeated output padding padding"; i=$((i+1)); done';
    const r = Bun.spawnSync(["node", "dist/cli.js", "run", "--", "sh", "-c", script], {
      env: { ...process.env, TANUKI_STASH: DIR },
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain("stashed");
    expect(out).toMatch(/fetch [0-9a-f]{12}|tanuki_fetch \{"id"/);
  }, 20000);
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
// The shape rules only catch vendors who prefix their tokens. An AWS SECRET
// access key is 40 chars of base64 with no marker, and it leaked straight
// through `fetch` until the named rule existed - the same "allowlist with an
// unbounded complement" failure the sidecar classifier had. Bounds here are
// measured against 19.7 MB of real logs: 2 hits in 166,985 lines, both real.

describe("named-secret redaction", () => {

  test("catches assignment-shaped secrets the shape rules miss", () => {
    for (const line of [
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI00K7MDENGbPxRfiCYEXAMPLEKEY",
      "db_password: hunter2000secret",
      '{"client_secret": "9f3a2b1c4d5e6f7a"}',
      "DATABASE_PASSWORD=p@ssw0rd-very-long",
    ]) {
      const r = redactCredentials(line);
      expect(r.count).toBe(1);
      expect(r.text).toContain("[redacted:named-secret]");
    }
  });

  test("leaves the key name readable - a masked slice must stay diagnosable", () => {
    const r = redactCredentials("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI00K7MDENGbPxRfiCYEXAMPLEKEY");
    expect(r.text).toBe("AWS_SECRET_ACCESS_KEY=[redacted:named-secret]");
  });

  test("does not fire on the shapes that made real logs false-positive", () => {
    for (const line of [
      "CACHE_KEY=abc12345678", // not a secret word
      "idempotency-key: 9f3a2b1c4d5e", // ditto
      "imageTokens: rev.tokens,", // plural: source code, 84 hits in git log
      "systemd-ask-password-console.path: Deactivated successfully.", // word not at key end, 8 hits
      "const token = `frame-allocator#${hex(r, 6)}`;", // backtick value, 2 hits
      "token=short", // under the 8-char floor
    ]) {
      expect(redactCredentials(line).count).toBe(0);
    }
  });

  test("never re-redacts a placeholder an earlier rule wrote", () => {
    // aws-key fires first; named-secret must not then eat [redacted:aws-key]
    // and double-count it (it did, until '[' was excluded from value starts)
    const r = redactCredentials('api_key="AKIAIOSFODNN7EXAMPLE"');
    expect(r.count).toBe(1);
    expect(r.text).toBe('api_key="[redacted:aws-key]"');
  });

  test("splices at the LAST occurrence, which is where Rust splices", () => {
    // `password=password`: an indexOf-based splice masks the key instead of
    // the value and silently diverges from the Rust engine
    expect(redactCredentials("password=password").text).toBe("password=[redacted:named-secret]");
  });
});

describe("find mode", () => {
  test("word boundary scores 3, substring scores 1, tie breaks by line asc", () => {
    // Line 1: "error_code" - substring match for "error" = 1
    // Line 3: "error occurred" - word boundary match for "error" = 3
    // Line 5: "ERROR log" - word boundary match for "error" (case insensitive) = 3
    // Line 7: "the error" - word boundary match = 3
    const text = [
      "error_code=500",      // 1: substring only
      "info message",        // 2: no match
      "error occurred",      // 3: word boundary
      "debug trace",         // 4: no match
      "ERROR log",           // 5: word boundary
      "warning here",        // 6: no match
      "the error",           // 7: word boundary
      "another line",        // 8: no match
      "final error_msg",     // 9: substring only
    ].join("\n");
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "error", 3);
    // Top 3 by score: lines 3,5,7 (all score 3), tie-break by line asc
    // Windows: 3 -> [1,5], 5 -> [3,7], 7 -> [5,9]
    // Merged: [1,9] (all adjacent/overlapping)
    expect(result).toContain("·find· L1-9 score 3");
    expect(result).toContain("error_code=500");
    expect(result).toContain("final error_msg");
    expect(result).toContain("·find· 1 words · 5 lines matched · 1 windows");
  });

  test("substring-only scoring would change ranking (mutation guard)", () => {
    // If all hits scored 1, line 1 and 9 would rank equally with 3,5,7
    // and might be selected instead, proving word-boundary logic matters
    const text = [
      "error_code=500",
      "info message",
      "error occurred",
    ].join("\n");
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "error", 1);
    // With correct scoring, line 3 (score 3) wins over line 1 (score 1)
    expect(result).toContain("error occurred");
    // Line 1 might be included via context window, but not as the anchor
    // The key is that the window is centered on line 3, not line 1
    expect(result).toContain("·find· L1-3 score 3");
  });

  test("window merge: adjacent windows collapse", () => {
    const text = [
      "line 1",
      "line 2",
      "error at 3",    // 3: word match
      "line 4",
      "line 5",
      "error at 6",    // 6: word match
      "line 7",
    ].join("\n");
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "error", 2);
    // Anchors: 3,6 -> windows [1,5] and [4,7] -> merged to [1,7]
    expect(result).toContain("·find· L1-7 score 3");
    expect(result).toContain("·find· 1 words · 2 lines matched · 1 windows");
  });

  test("h==0: no matches returns zero-match message", () => {
    const text = "alpha\nbeta\ngamma";
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "notfound xyz", 8);
    expect(result).toBe("·find· 2 words · 0 lines matched");
  });

  test("exclusivity: cannot mix find with query or lines", () => {
    const { id } = stashText("test");
    expect(() => fetchSlice(id, "x", null, "word", 8)).toThrow("give exactly one of query, lines or find");
    expect(() => fetchSlice(id, null, "1-2", "word", 8)).toThrow("give exactly one of query, lines or find");
    expect(() => fetchSlice(id, "x", "1-2", "word", 8)).toThrow("give exactly one of query, lines or find");
    expect(() => fetchSlice(id, null, null, null, 8)).toThrow("give exactly one of query, lines or find");
  });

  test("top clamp: 1..32, default 8", () => {
    // Anchors 6 lines apart: windows [n-2, n+2] never touch (gap of 1 line),
    // so window count == anchor count and the clamp is observable. A fixture
    // of CONSECUTIVE matches would merge into one window and prove nothing.
    const text = Array.from({ length: 200 }, (_, i) =>
      (i + 1) % 6 === 0 ? `error line ${i + 1}` : `quiet line ${i + 1}`,
    ).join("\n");
    const { id } = stashText(text);
    // top = 0 clamps to 1
    expect(fetchSlice(id, null, null, "error", 0)).toContain("· 1 windows");
    // top = 100 clamps to 32 (33 matching lines exist)
    expect(fetchSlice(id, null, null, "error", 100)).toContain("· 32 windows");
    // default = 8
    expect(fetchSlice(id, null, null, "error")).toContain("· 8 windows");
  });

  test("redaction still applied in find mode", () => {
    // Redaction lives in the CALLER (toolFetch/CLI), same as the query and
    // lines paths - fetchSlice itself returns the raw bytes.
    const text = ["line 1", 'api_key="AKIAIOSFODNN7EXAMPLE"', "error occurred key nearby"].join("\n");
    const { id } = stashText(text);
    expect(fetchSlice(id, null, null, "error key", 8)).toContain("AKIAIOSFODNN7EXAMPLE");
    const out = toolFetch({ id, find: "error key" }) as { type: string; text?: string }[];
    const joined = out.map((c) => c.text ?? "").join("\n");
    expect(joined).toContain("[redacted:aws-key]");
    expect(joined).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("find output is never imaged, even when pages would win", () => {
    // 300 long prose-ish lines, every 6th matching: enough window bytes that
    // the fetch imaging gate WOULD fire (this exact case shipped as pixels
    // first - retrieval-report.mjs scored the answer ABSENT and caught it).
    const text = Array.from({ length: 300 }, (_, i) =>
      (i + 1) % 6 === 0
        ? `entry ${i + 1} ERROR request failed with a long explanatory tail that pads the window bytes`
        : `entry ${i + 1} quiet routine heartbeat line with a long explanatory tail that pads the window`,
    ).join("\n");
    const { id } = stashText(text);
    const out = toolFetch({ id, find: "ERROR request failed", top: 32 }) as { type: string; text?: string }[];
    expect(out.some((c) => c.type === "image")).toBe(false);
    expect(out.map((c) => c.text ?? "").join("\n")).toContain("·find·");
  });

  test("find needs at least one word", () => {
    const { id } = stashText("test");
    expect(() => fetchSlice(id, null, null, "", 8)).toThrow("find needs at least one word");
    expect(() => fetchSlice(id, null, null, "   ", 8)).toThrow("find needs at least one word");
  });

  test("multiple words: scores accumulate", () => {
    const text = [
      "error occurred",      // 1: "error" 3 + "occurred" 3 = 6
      "the error",          // 2: "error" 3 = 3
      "line occurred here", // 3: "occurred" 3 = 3
    ].join("\n");
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "error occurred", 1);
    // Line 1 has highest score (6)
    expect(result).toContain("error occurred");
    expect(result).toContain("·find· 2 words · 3 lines matched · 1 windows");
  });

  test("redaction path: find result contains credentials that will be redacted by caller", () => {
    const text = [
      "line 1",
      'api_key="AKIAIOSFODNN7EXAMPLE"',
      "error occurred",
    ].join("\n");
    const { id } = stashText(text);
    const result = fetchSlice(id, null, null, "error", 8);
    // The slice contains the credential
    expect(result).toContain("AKIAIOSFODNN7EXAMPLE");
    // When passed through redactCredentials (same path as query/lines), it gets masked
    const redacted = redactCredentials(result);
    expect(redacted.text).toContain("[redacted:aws-key]");
    expect(redacted.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
