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
// The shape rules only catch vendors who prefix their tokens. An AWS SECRET
// access key is 40 chars of base64 with no marker, and it leaked straight
// through `fetch` until the named rule existed - the same "allowlist with an
// unbounded complement" failure the sidecar classifier had. Bounds here are
// measured against 19.7 MB of real logs: 2 hits in 166,985 lines, both real.
const { redactCredentials } = await import("../src/needles.ts");

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
