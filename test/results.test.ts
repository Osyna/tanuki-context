// Results suite: proves the three density knobs (pack / codebook / tiny font)
// deliver their claimed savings on real corpora, that every claimed-lossless
// transform round-trips byte-exact, and that the shipped dist/cli.js serves
// it all over MCP. `bun test` prints the measured table — the "result".

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  INDENT_ALPHABET,
  NL_LITERAL,
  NL_SENTINEL,
  estimateText,
  neutralizePack,
  reflowPack,
  renderText,
} from "../src/render.ts";
import { apply as codebookApply } from "../src/codebook.ts";
import { SIDECAR_MIN_CHARS, scanCredentials, scanNeedles, sidecarBudget } from "../src/needles.ts";
import { toolEstimate, toolRender } from "../src/main.ts";
import { DEFAULT_TOOL_NAMES, TOOLS, visibleTools } from "../src/tools.ts";
import { PROXY_DEFAULTS, transformRequestBody } from "../src/proxy.ts";

// ------------------------------------------------------------------ corpora

const PROSE = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const LOG = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    const shard = i % 7;
    lines.push(
      `2026-07-26T01:${String(i % 60).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}Z ` +
        `INFO  worker-${shard} copied /srv/data/prod/batch-2026-07/shard-${shard}/segment_${String(i).padStart(5, "0")}.parquet ` +
        `-> /mnt/cold-storage/archive/2026/07/shard-${shard}/ (ok, 4.${i % 10} MiB)`,
    );
    if (i % 97 === 0 && i > 0) {
      lines.push(`ERROR worker-${shard} checksum mismatch on /srv/data/prod/batch-2026-07/shard-${shard}/segment_${String(i).padStart(5, "0")}.parquet — retrying`);
    }
  }
  return lines.join("\n");
})();

const textTokens = (s: string): number => Math.round([...s].length / 4);
const est = (text: string, pack: boolean, font: "normal" | "tiny"): number =>
  estimateText(text, true, pack, font).tokens;

// ------------------------------------------------- pack: lossless round-trip

// Inverse of neutralizePack + reflowPack, from the documented sentinel
// grammar alone (what a reader of the page — human or model — applies):
//   split ↵ · ⇥X -> N spaces (X = INDENT_ALPHABET[N]) · → -> \t · ⇢ -> → · ⇨ -> ⇥ · ⏎ -> ↵
function unpack(stream: string): string {
  const TAB_MARK = "\u2192", TAB_LITERAL = "\u21E2";
  const INDENT_MARK = "\u21E5", INDENT_LITERAL = "\u21E8";
  const lines = stream.split(NL_SENTINEL).map((line) => {
    let s = line;
    if (s.startsWith(INDENT_MARK) && s.length > 1) {
      const n = INDENT_ALPHABET.indexOf(s[1]);
      if (n >= 0) s = " ".repeat(n) + s.slice(2);
    }
    s = s.replaceAll(TAB_MARK, "\t");
    s = s.replaceAll(TAB_LITERAL, TAB_MARK).replaceAll(INDENT_LITERAL, INDENT_MARK);
    return s;
  });
  return lines.join("\n").replaceAll(NL_LITERAL, NL_SENTINEL);
}

describe("pack is lossless", () => {
  const tricky = [
    "fn main() {",
    "\tlet x = 1;", // leading tab
    "    indented four", // RLE'd run
    "  two spaces stay literal", // < MIN_INDENT, kept as-is
    " one",
    `${" ".repeat(20)}deep indent`,
    `${" ".repeat(61)}max alphabet run`,
    "mid\ttab and a literal \u2192 arrow plus \u21E5 indent mark", // collides with sentinels
    "a hard \u21B5 return char in the source",
    "}",
  ].join("\n");

  test("neutralizePack+reflowPack round-trips byte-exact", () => {
    const packed = reflowPack(neutralizePack(tricky));
    expect(unpack(packed)).toBe(tricky);
  });

  test("source corpus round-trips byte-exact", () => {
    // minify-canonical form (no trailing ws, <4 blank runs) == SOURCE itself
    const packed = reflowPack(neutralizePack(SOURCE));
    expect(unpack(packed)).toBe(SOURCE);
  });

  test("width-trim flips the small-payload verdict", () => {
    const small = "ERROR: disk quota exceeded on /srv/data — retry in 30s (attempt 3/5)";
    const raw = textTokens(small);
    const padded = est(small, false, "normal");
    const packed = est(small, true, "normal");
    expect(padded).toBeGreaterThan(raw); // pxpipe-faithful: full-width page loses
    expect(packed).toBeLessThan(raw); // pack: image wins even at one line
  });
});

// -------------------------------------------------- codebook: reversibility

// Expansion a reader performs: parse the trailing `·legend·` line, replace
// each sigil with its value everywhere in the body.
function expandCodebook(encoded: string): string {
  const at = encoded.lastIndexOf("\n\u00B7legend\u00B7 ");
  if (at < 0) return encoded;
  let body = encoded.slice(0, at);
  const legend = encoded.slice(at + "\n\u00B7legend\u00B7 ".length);
  for (const entry of legend.split(" ")) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    body = body.replaceAll(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return body;
}

describe("codebook is reversible", () => {
  test("path-heavy log: entries chosen, expansion restores original", () => {
    const cb = codebookApply(LOG);
    expect(cb.entries).toBeGreaterThan(0);
    expect([...cb.text].length).toBeLessThan([...LOG].length);
    expect(expandCodebook(cb.text)).toBe(LOG);
  });

  test("no candidates -> text unchanged", () => {
    const cb = codebookApply("short words only here\nnothing repeats thrice");
    expect(cb.entries).toBe(0);
    expect(cb.text).toBe("short words only here\nnothing repeats thrice");
  });

  test("sigils already in the source are never assigned", () => {
    const poisoned = `§¤¢£¥µ¶ª°±¬×÷ØÞßæðøþ¡¿\n${LOG}`;
    const cb = codebookApply(poisoned);
    expect(cb.entries).toBe(0); // every sigil taken -> nothing encodable
    expect(expandCodebook(cb.text)).toBe(poisoned);
  });
});

// ------------------------------------------------------- the results table

describe("measured savings vs pxpipe baseline", () => {
  // Conservative regression floors on the live corpora (PROSE = README.md,
  // SOURCE = main.ts, LOG = synthetic) under the 28-px patch model. README
  // doubles as its own corpus, so the prose cut drifts ~a point as docs grow
  // (now ~29); the floor sits below the current measured cut, never at it, so
  // ordinary doc edits don't trip it — only a real compression regression does.
  const FLOORS = { prose: 28, source: 38, log: 55 };

  test("stacked knobs clear the claimed floors on all three corpora", () => {
    const rows: string[] = [];
    const header = `${"corpus".padEnd(10)}${"rawText".padStart(9)}${"baseline".padStart(10)}${"+pack".padStart(8)}${"+codebook".padStart(11)}${"+tiny".padStart(8)}${"stacked".padStart(9)}${"cut".padStart(6)}`;
    for (const [name, text] of [["prose", PROSE], ["source", SOURCE], ["log", LOG]] as const) {
      const raw = textTokens(text);
      const base = est(text, false, "normal");
      const pack = est(text, true, "normal");
      const cbText = codebookApply(text).text;
      const cb = est(cbText, true, "normal");
      const tiny = est(text, true, "tiny");
      const stacked = est(cbText, true, "tiny");
      const cut = Math.round((100 * (base - stacked)) / base);
      rows.push(
        `${name.padEnd(10)}${String(raw).padStart(9)}${String(base).padStart(10)}${String(pack).padStart(8)}${String(cb).padStart(11)}${String(tiny).padStart(8)}${String(stacked).padStart(9)}${String(`-${cut}%`).padStart(6)}`,
      );
      expect(cut).toBeGreaterThanOrEqual(FLOORS[name]);
      expect(stacked).toBeLessThanOrEqual(pack); // knobs never hurt
      expect(pack).toBeLessThanOrEqual(base);
    }
    console.log(`\n  image-tokens per knob (level 0, reflow on)\n  ${header}\n  ${rows.join("\n  ")}\n`);
  });
});

// -------------------------------------------------- recommend: ladder walk

describe("recommend: server-side knob walk in one estimate call", () => {
  test("repetitive log: reversible walk priced, distill route priced separately", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const log = Array.from(
      { length: 400 },
      (_, i) => `2026-07-26 INFO copied /srv/data/prod/batch/segment_${String(i % 9).padStart(5, "0")}.parquet ok`,
    ).join("\n");
    const e = toolEstimate({ text: log, level: 0 });
    // unchecked cast: toolEstimate returns Record<string, unknown>; shape is asserted below
    const rec = e.recommend as { codebook: boolean; imageTokens: number; pages: number; table: boolean; tinyImageTokens: number; withDistill: { codebook: boolean; imageTokens: number }; text: { transform: string; tokens: number; savedPct: number; withDistill: number } };
    expect(Object.keys(rec).sort()).toEqual(["codebook", "imageTokens", "pages", "table", "text", "tinyImageTokens", "withDistill"]);
    // reversible headline never uses distill; the log route is priced under withDistill
    expect(rec.imageTokens).toBeLessThanOrEqual(e.imageTokens as number);
    expect(rec.withDistill.imageTokens).toBeLessThan(rec.imageTokens);
    expect(rec.tinyImageTokens).toBeLessThanOrEqual(rec.imageTokens);
    // stays-as-text route (no pxpipe): whitespace is the lossless headline, distill
    // the lossy log sibling — priced as text; the wider router's TEXT-verdict answer
    expect(["whitespace", "none"]).toContain(rec.text.transform);
    expect(rec.text.tokens).toBeLessThanOrEqual(e.rawTextTokens as number);
    expect(rec.text.savedPct).toBeGreaterThanOrEqual(0);
    expect(rec.text.withDistill).toBeLessThan(rec.text.tokens);
  });

  test("plain short prose: zero knobs recommended (earliest combo wins ties)", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: "One plain paragraph that repeats nothing and is not a log.", level: 0 });
    // unchecked cast: shape asserted in the sibling test
    const rec = e.recommend as { codebook: boolean; withDistill: { codebook: boolean }; text: { transform: string } };
    expect(rec.codebook).toBe(false);
    expect(rec.withDistill.codebook).toBe(false);
    // no trailing ws / blank runs and not a log -> nothing safe to cut, stays raw
    expect(rec.text.transform).toBe("none");
  });
});

describe("route: hybrid pick over cost and fidelity, not just tokens", () => {
  const LOGX = Array.from({ length: 300 }, (_, i) => `2026-07-27T09:${String(i % 60).padStart(2, "0")}:00Z worker INFO poll ok latency=${i % 40}ms`).join("\n");

  test("clean, cheaper imaging -> pick image", () => {
    const e = toolEstimate({ text: LOGX, level: 0 });
    // unchecked cast: route shape asserted here
    const r = e.route as { pick: string; fidelity: string; savedPct: number };
    expect(r.pick).toBe("image");
    expect(["high", "good"]).toContain(r.fidelity);
    expect(r.savedPct).toBeGreaterThan(0);
  });

  test("credentials -> never imaged, route stays text-side and exact", () => {
    const e = toolEstimate({ text: 'api_key="sk-ant-api03-SECRETSECRETSECRETSECRETdeadbeef"\nsurrounding config line for padding and context here\n', level: 0 });
    // unchecked cast: route shape asserted here
    const r = e.route as { pick: string; fidelity: string; reason: string };
    expect(["text", "raw"]).toContain(r.pick);
    expect(r.fidelity).toBe("exact");
    expect(r.reason).toContain("credential");
  });

  test("cached content -> real dollars flip the pick to the text side", () => {
    const e = toolEstimate({ text: LOGX, level: 0, model: "claude-opus-4", cached: true });
    // unchecked cast: route shape asserted here
    const r = e.route as { pick: string; reason: string };
    expect(["text", "raw"]).toContain(r.pick);
    expect(r.reason).toContain("cached");
  });
});

// ------------------------------------------ cost: situation-aware verdict

describe("cost: real-dollar verdict flips on cache state and provider", () => {
  // content that images cheaper by TOKEN COUNT (fewer image tokens than text tokens)
  const log = Array.from(
    { length: 400 },
    (_, i) => `2026-07-26 INFO copied /srv/data/prod/batch/segment_${String(i % 9).padStart(5, "0")}.parquet ok`,
  ).join("\n");

  test("no situation arg: no cost field, token result unchanged", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: log, level: 0 });
    expect(e.cost).toBeUndefined();
    expect(e.verdict).toBe("PIPELINE cheaper");
  });

  test("uncached Anthropic: cost agrees with the token verdict (image bills at input rate)", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: log, level: 0, model: "claude-opus-4" });
    const cost = e.cost as { cheaper: string; savedPct: number };
    expect(cost.cheaper).toBe("PIPELINE");
    expect(cost.savedPct).toBeGreaterThan(0);
  });

  test("cached content flips to TEXT: a cache-read token is 0.1x, imaging loses", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: log, level: 0, model: "claude-opus-4", cached: true });
    const cost = e.cost as { cheaper: string; savedPct: number; note?: string; breakevenImageTokens: number };
    // token verdict still says PIPELINE, but real cost says TEXT
    expect(e.verdict).toBe("PIPELINE cheaper");
    expect(cost.cheaper).toBe("TEXT");
    expect(cost.savedPct).toBeLessThan(0);
    expect(cost.breakevenImageTokens).toBeLessThan(e.imageTokens as number);
    expect(cost.note).toContain("cache-read");
  });

  test("openai: image tokens counted by the 512px tile rule, not the patch grid", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: log, level: 0, model: "gpt-5" });
    const cost = e.cost as { imageTokens: number; note?: string };
    expect(cost.note).toContain("512px tile");
    // full page 1568x728: fits 2048, shortest 728 <= 768 -> ceil(1568/512)*ceil(728/512) = 4*2 = 8 tiles
    // -> 85 + 170*8 = 1445/page, vs Anthropic's 1456 patch count. Counts must differ.
    expect(cost.imageTokens).not.toBe(e.imageTokens as number);
    expect(cost.imageTokens).toBeGreaterThan(0);
  });

  test("gemini: 768px tile rule, flagged approximate, cheaper pages than the patch grid", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const e = toolEstimate({ text: log, level: 0, model: "gemini-2.5-pro" });
    const cost = e.cost as { imageTokens: number; note?: string };
    expect(cost.note).toContain("approximate");
    // full page 1568x728 -> ceil(1568/768)*ceil(728/768) = 3*1 tiles * 258 = 774/page,
    // roughly half of Anthropic's 1456 - gemini pages are cheaper, verdict must see that
    expect(cost.imageTokens).toBeLessThan(e.imageTokens as number);
  });

  test("provider math is exact on known dims", async () => {
    const { providerImageTokens } = await import("../src/cost.ts");
    expect(providerImageTokens([[1568, 728]], "openai")).toBe(85 + 170 * 8); // 1445
    expect(providerImageTokens([[1568, 728]], "gemini")).toBe(258 * 3); // 774
    expect(providerImageTokens([[300, 200]], "gemini")).toBe(258); // <=384 flat
    // openai downscale: 4096x4096 -> fit 2048 -> shortest 768 -> 768x768 -> 4 tiles
    expect(providerImageTokens([[4096, 4096]], "openai")).toBe(85 + 170 * 4);
  });
});

// ------------------------------------------------ table: columnar whole-JSON

describe("table: value-lossless columnar encoding for whole-JSON input", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ts: `2026-07-26T03:${String(i % 60).padStart(2, "0")}:00Z`,
    level: i % 7 === 0 ? "error" : "info",
    unit: `worker-${i % 4}.service`,
    message: `copied segment_${String(i % 9).padStart(5, "0")}.parquet ok`,
    pid: 1000 + (i % 32),
  }));
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
  const asArray = JSON.stringify(rows, null, 2);

  test("round-trip: decode(encode(x)) preserves every value (NDJSON and array forms)", async () => {
    const { tableEncode, tableDecode } = await import("../src/table.ts");
    for (const src of [ndjson, asArray]) {
      const t = tableEncode(src);
      expect(t).not.toBeNull();
      const back = tableDecode(t!.text);
      expect(back).not.toBeNull();
      const decoded = back!.split("\n").map((l) => JSON.parse(l));
      expect(decoded).toEqual(rows);
    }
  });

  test("keys stated once: encoded form is materially smaller and rows/cols are counted", async () => {
    const { tableEncode } = await import("../src/table.ts");
    const t = tableEncode(ndjson);
    expect(t!.rows).toBe(200);
    expect(t!.cols).toBe(5);
    // 5 keys x ~200 rows of repeated '"key":' scaffolding deleted
    expect(t!.text.length).toBeLessThan(ndjson.length * 0.75);
  });

  test("gate: mixed prose+JSON stays text; the SIZE gate (not row count) decides tiny inputs", async () => {
    const { tableEncode } = await import("../src/table.ts");
    expect(tableEncode("some prose\n" + ndjson)).toBeNull();
    expect(tableEncode('{"a":1}')).toBeNull(); // single object, not rows
    // two rows with DISJOINT 1-char keys: the ·cols· header costs more than it saves
    expect(tableEncode('{"a":1}\n{"b":2}')).toBeNull();
    // two rows SHARING a key: scaffolding removal already wins
    expect(tableEncode('{"aa":1}\n{"aa":2}')).not.toBeNull();
  });

  test("absent keys become empty cells and survive the round trip", async () => {
    const { tableEncode, tableDecode } = await import("../src/table.ts");
    const sparse = '{"a":1,"b":"x"}\n{"a":2}\n{"b":"y","c":true}';
    const t = tableEncode(sparse);
    expect(t).not.toBeNull();
    const back = tableDecode(t!.text)!.split("\n").map((l) => JSON.parse(l));
    expect(back).toEqual([{ a: 1, b: "x" }, { a: 2 }, { b: "y", c: true }]);
  });

  test("tabs and newlines inside string values cannot break the grammar", async () => {
    const { tableEncode, tableDecode } = await import("../src/table.ts");
    const tricky = '{"msg":"a\\tb\\nc","n":1}\n{"msg":"plain","n":2}';
    const t = tableEncode(tricky);
    expect(t).not.toBeNull();
    const back = tableDecode(t!.text)!.split("\n").map((l) => JSON.parse(l));
    expect(back[0].msg).toBe("a\tb\nc");
  });

  test("estimate: table knob applies, reports rows x cols, and beats the untabled run", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const plain = toolEstimate({ text: ndjson, level: 0 });
    const tabled = toolEstimate({ text: ndjson, level: 0, table: true });
    expect(tabled.table).toEqual({ rows: 200, cols: 5 });
    expect(plain.table).toBe(false);
    expect(tabled.imageTokens as number).toBeLessThanOrEqual(plain.imageTokens as number);
    // recommend probes table on its own - no knob required
    const rec = plain.recommend as { table: boolean };
    expect(rec.table).toBe(true);
  });

  test("table + distill compose: distill still collapses tabled rows", async () => {
    const { toolEstimate } = await import("../src/main.ts");
    const dup = Array.from({ length: 300 }, (_, i) => JSON.stringify({
      ts: `2026-07-26T03:00:${String(i % 3).padStart(2, "0")}Z`,
      level: "info",
      message: "heartbeat ok",
    })).join("\n");
    const tabledOnly = toolEstimate({ text: dup, level: 0, table: true });
    const tabledDistilled = toolEstimate({ text: dup, level: 0, distill: true, table: true });
    // composition claim: identical rows collapse harder AFTER tabling, so the
    // stack strictly beats table alone. (When distill already flattens raw
    // NDJSON to a couple of exemplars, the ·cols· header can cost ~1 token vs
    // no-table - that is honest overhead, not a regression.)
    expect(tabledDistilled.imageTokens as number).toBeLessThan(tabledOnly.imageTokens as number);
  });
});

// ------------------------------------------------ append-stable pagination

describe("append-stable pages (prompt-cache reuse)", () => {
  test("appending to a multi-page doc leaves earlier pages byte-identical", () => {
    const base = `${LOG}\n${SOURCE}`; // ~3 pages packed
    const grown = `${base}\n2026-07-26T02:00:00Z INFO appended after the fact`;
    const a = renderText(base, true, true, "normal");
    const b = renderText(grown, true, true, "normal");
    expect(a.pages.length).toBeGreaterThanOrEqual(2);
    expect(b.pages.length).toBeGreaterThanOrEqual(a.pages.length);
    for (let i = 0; i < a.pages.length - 1; i++) {
      expect(Buffer.from(b.pages[i].png).equals(Buffer.from(a.pages[i].png))).toBe(true);
    }
  });
});

// --------------------------------------------------------- MCP end to end

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
}

interface RpcMsg {
  id?: number;
  result?: {
    serverInfo?: { name: string };
    tools?: { name: string }[];
    content?: ToolContent[];
  };
}

interface EstimateOut {
  font: string;
  pack: boolean;
  codebook: number | false;
  imageTokens: number;
  verdict: string;
}

describe("dist/cli.js MCP session", () => {
  beforeAll(() => {
    const b = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("..", import.meta.url).pathname });
    if (b.exitCode !== 0) throw new Error(`build failed: ${b.stderr.toString()}`);
  });

  async function session(requests: unknown[]): Promise<Map<number, RpcMsg>> {
    const proc = Bun.spawn(["node", new URL("../dist/cli.js", import.meta.url).pathname], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const byId = new Map<number, RpcMsg>();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // our own server's output; shape asserted by the expectations below
      const msg = JSON.parse(line) as RpcMsg;
      if (msg.id !== undefined) byId.set(msg.id, msg);
    }
    return byId;
  }

  test("initialize, knobs echoed, PNG served", async () => {
    const r = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "results", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: LOG, codebook: true, pack: true, font: "tiny" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tanuki_estimate", arguments: { text: LOG, pack: false } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tanuki_render", arguments: { text: "hello from the results suite" } } },
    ]);

    expect(r.get(1)?.result?.serverInfo?.name).toBe("tanuki-context");
    const tools = (r.get(2)?.result?.tools ?? []).map((t) => t.name);
    // fetch is in the default surface: stash parks text and fetch is the only
    // way back. Advertising one without the other made the documented stash
    // workflow impossible (EVALS §6). stats is here for the same reason: the
    // skill's end-of-session step names it, and an MCP client cannot call what
    // tools/list omits.
    expect(tools).toEqual([
      "tanuki_render",
      "tanuki_estimate",
      "tanuki_stats",
      "tanuki_stash",
      "tanuki_fetch",
      "tanuki_verify",
    ]);

    // estimate JSON from our own server; fields asserted below
    const stacked = JSON.parse(r.get(3)?.result?.content?.[0]?.text ?? "{}") as EstimateOut;
    const plain = JSON.parse(r.get(4)?.result?.content?.[0]?.text ?? "{}") as EstimateOut;
    expect(stacked.font).toBe("tiny");
    expect(stacked.pack).toBe(true);
    expect(typeof stacked.codebook).toBe("number");
    expect(stacked.codebook).toBeGreaterThan(0);
    expect(stacked.imageTokens).toBeLessThan(plain.imageTokens);
    expect(stacked.verdict).toBe("PIPELINE cheaper");

    const img = r.get(5)?.result?.content?.find((c) => c.type === "image");
    expect(img?.data).toBeDefined();
    const png = Buffer.from(img?.data ?? "", "base64");
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });
});

// ------------------------------------------------- verbatim: needle sidecar
// Fidelity fix for the needle read-back failure (README Table D): exact
// strings ship as text next to the pages instead of being trusted to pixels.
describe("verbatim: exact strings ride as text, never pixels", () => {
  const NOISY = [
    "2026-07-27T09:30:00Z relay ERROR request failed session=3451bd1b-13c4-4558-aa67-a62bc042905e",
    "2026-07-27T09:30:07Z relay INFO upgraded runtime to 1.15.8-rc.3",
    "2026-07-27T09:30:14Z relay ERROR upstream 502 request-id=b83839621bf0 peer=10.2.30.4:8443",
    "2026-07-27T09:30:21Z relay INFO image digest sha256:26e7f9e3971a538a verified at 0xdeadbeef01",
    "    at handler (lib/relay/frame.ts:927:35)",
    "2026-07-27T09:30:28Z relay INFO poll ok latency=14ms conn=3",
  ].join("\n");

  test("every needle kind is found byte-exact from the source", async () => {
    const s = scanNeedles(NOISY);
    const values = s.needles.map((n) => n.value);
    for (const v of [
      "3451bd1b-13c4-4558-aa67-a62bc042905e",
      "1.15.8-rc.3",
      "b83839621bf0",
      "10.2.30.4:8443",
      "sha256:26e7f9e3971a538a",
      "0xdeadbeef01",
      "lib/relay/frame.ts:927:35",
    ]) {
      expect(values).toContain(v);
    }
    // round-trip property: everything in the sidecar exists byte-exact in the source
    for (const n of s.needles) {
      expect(NOISY.includes(n.value)).toBe(true);
      expect(NOISY.split("\n")[n.line - 1]).toContain(n.value);
    }
    expect(s.tokens).toBeGreaterThan(0);
    expect(s.text.startsWith("·verbatim·")).toBe(true);
  });

  test("timestamps and plain prose are not needles", async () => {
    const s = scanNeedles("2026-07-27T09:30:00Z worker INFO poll ok latency=14ms conn=3\nplain words only here");
    expect(s.needles.length).toBe(0);
    expect(s.text).toBe("");
    expect(s.tokens).toBe(0);
  });

  test("dedupe keeps first occurrence; the budget carries real logs", async () => {
    const dup = "sha256:26e7f9e3971a538a\nsha256:26e7f9e3971a538a";
    expect(scanNeedles(dup).needles.length).toBe(1);
    // Ordinary content: prose around a couple of ids, nothing truncated.
    const mixed = Array.from({ length: 40 }, (_, i) => `2026-07-27T09:30:00Z relay INFO worker heartbeat seq ${i} ok latency=14ms`)
      .concat(["relay dest=86:2b:11:51:58:03 down", "merged 6c9224c into main"]);
    const ok = scanNeedles(mixed.join("\n"));
    expect(ok.more).toBe(0);
    expect(ok.dense).toBe(false);
    expect(ok.text).toContain("86:2b:11:51:58:03");
    expect(ok.text).toContain("6c9224c");
    // A block that is nothing but ids cannot be protected by a sidecar smaller
    // than itself: it must say so rather than image them away silently.
    const ids = Array.from({ length: 40 }, (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a`);
    const crammed = scanNeedles(ids.join("\n"));
    expect(crammed.dense).toBe(true);
    expect(crammed.more).toBeGreaterThan(0);
    expect(crammed.text).toContain("more (needle-dense");
  });

  test("budget scales with raw size", async () => {
    expect(sidecarBudget(0)).toBe(SIDECAR_MIN_CHARS);
    expect(sidecarBudget(40_000)).toBe(20_000);
  });

  // The bug 0.13.0 shipped: a capped sidecar stays cheap while dropping the
  // ids it exists to protect, so the cost math alone routed dense blocks to
  // "image" at "high" fidelity with hundreds of values unverifiable.
  test("a needle-dense block is never routed to image", async () => {
    let s = 7;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const hex = (n: number): string => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
    const dense = Array.from({ length: 120 }, (_, i) =>
      `2026-07-27T09:${String(i % 60).padStart(2, "0")}:00Z relay INFO request ${Array.from({ length: 6 }, () => `id=${hex(16)}`).join(" ")} ok`).join("\n");
    const e = toolEstimate({ text: dense, level: 0 }) as {
      verdict: string;
      verbatim: { dense: boolean; more: number };
      route: { pick: string; reason: string };
    };
    expect(e.verbatim.dense).toBe(true);
    expect(e.verbatim.more).toBeGreaterThan(0);
    expect(e.route.pick).not.toBe("image");
    expect(e.route.reason).toContain("needle-dense");
    expect(e.verdict).toBe("TEXT cheaper (needle-dense)");
  });

  // 0.13.1 gated the advisory path (estimate) and left the ACTION paths open:
  // render imaged a dense block anyway, and its summary claimed every found
  // string rode below when only the carried ones did.
  test("render refuses a needle-dense block instead of imaging it", async () => {
    let s = 7;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const hex = (n: number): string => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
    const dense = Array.from({ length: 120 }, (_, i) =>
      `2026-07-27T09:${String(i % 60).padStart(2, "0")}:00Z relay INFO request ${Array.from({ length: 6 }, () => `id=${hex(16)}`).join(" ")} ok`).join("\n");
    const out = toolRender({ text: dense, level: 0 }) as Array<{ type: string; text?: string }>;
    expect(out.some((c) => c.type === "image")).toBe(false);
    expect(out[0].text).toContain("refused to render");
    expect(out[0].text).toContain("unverifiable pixels");
    // opting out knowingly is still allowed - the refusal is about silence
    const off = toolRender({ text: dense, level: 0, verbatim: false }) as Array<{ type: string }>;
    expect(off.some((c) => c.type === "image")).toBe(true);
  });

  test("the sidecar and summary count what is carried, not what was found", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a`);
    const sc = scanNeedles(ids.join("\n"));
    expect(sc.dense).toBe(true);
    // header states carried-of-found, never bare found
    expect(sc.text.split("\n")[0]).toBe(`·verbatim· ${sc.needles.length} of ${sc.needles.length + sc.more} exact strings (read them here, not from pixels)`);
    // and every listed value really is present
    const listed = sc.text.split("\n").filter((l) => l.startsWith("L")).length;
    expect(listed).toBe(sc.needles.length);
  });

  // EVALS §7: the allowlist carried 30.9% of unrecoverable ids on 19.7 MB of
  // real logs. These are the families it missed - they must not regress.
  test("ids that match no named format still ride as text", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["86:2b:11:51:58:03", "relay dest=86:2b:11:51:58:03 unreachable"],
      ["6c9224c", "merged 6c9224c into main"],
      ["1022:14e5", "device 1022:14e5 bound to amdgpu"],
      ["api-worker-7d9f8b6c4-x2ktp", "pod api-worker-7d9f8b6c4-x2ktp evicted"],
      ["aGVsbG8gd29ybGQxMjM0NTY3", "body aGVsbG8gd29ybGQxMjM0NTY3 sent"],
      ["ryvkuvrdmg", "ref=ryvkuvrdmg failed"],
      ["YHFJNKGNSMTQBWC", "ref=YHFJNKGNSMTQBWC failed"],
      ["ORD-5171-JRUBJMGB", "order ORD-5171-JRUBJMGB shipped"],
    ];
    for (const [id, line] of cases) expect(scanNeedles(line).text).toContain(id);
  });

  // The other half of the contract: ordinary prose must stay out, or the
  // sidecar bloats and the compression win goes with it.
  test("words, durations and timestamps stay out of the sidecar", async () => {
    for (const line of [
      "systemd-udev-load-credentials.service started successfully",
      "upstream.protocol negotiated background filesystem throughput",
      "lastseen=34m51s lastRecv=35m44s latency=14ms conn=3",
      "installed ocean-sound-theme noto-fonts-emoji lib32-libunistring",
    ]) {
      expect(scanNeedles(line).needles).toEqual([]);
    }
  });

  test("estimate prices the sidecar and the verdict accounts for it", async () => {
    const e = toolEstimate({ text: NOISY, level: 0 }) as {
      verbatim: { needles: number; tokens: number } | false;
      imageTokens: number;
      rawTextTokens: number;
      verdict: string;
    };
    expect(e.verbatim).not.toBe(false);
    const v = e.verbatim as { needles: number; tokens: number };
    expect(v.needles).toBeGreaterThanOrEqual(7);
    expect(v.tokens).toBeGreaterThan(0);
    expect(e.verdict).toBe(e.imageTokens + v.tokens < e.rawTextTokens ? "PIPELINE cheaper" : "TEXT cheaper");
    const off = toolEstimate({ text: NOISY, level: 0, verbatim: false }) as { verbatim: unknown };
    expect(off.verbatim).toBe(false);
  });

  test("render ships the sidecar as a text block next to the pages", async () => {
    const content = toolRender({ text: NOISY, level: 0 }) as Array<{ type: string; text?: string }>;
    const side = content.find((c) => c.type === "text" && (c.text ?? "").startsWith("·verbatim·"));
    expect(side).toBeDefined();
    expect(side?.text).toContain("3451bd1b-13c4-4558-aa67-a62bc042905e");
    const off = toolRender({ text: NOISY, level: 0, verbatim: false }) as Array<{ type: string; text?: string }>;
    expect(off.some((c) => (c.text ?? "").startsWith("·verbatim·"))).toBe(false);
  });

  // Measured on a 1200-line service log: the sidecar was 5,611 of 13,213
  // rendered tokens (42%), and 1,199 of its 1,239 strings were irreducible
  // random hex - compressing it recovers 68 tokens. The only lever left is
  // not shipping it eagerly, so lazy ships the count and the way back.
  test("lazy withholds the strings behind one pointer line, dense gate first", async () => {
    const dir = mkdtempSync(`${tmpdir()}/tanuki-lazy-`);
    const prev = process.env.TANUKI_STASH;
    process.env.TANUKI_STASH = dir;
    try {
      const found = scanNeedles(NOISY);
      const content = toolRender({ text: NOISY, level: 0, verbatim: "lazy" }) as Array<{ type: string; text?: string }>;
      const line = content.find((c) => c.type === "text" && (c.text ?? "").startsWith("·verbatim·"))?.text ?? "";
      expect(line.split("\n").length).toBe(1);
      expect(line).toContain(`${found.needles.length + found.more} exact strings withheld (lazy)`);
      expect(found.needles.length).toBeGreaterThan(0);
      for (const n of found.needles) expect(line).not.toContain(n.value);
      // Actionable, not a dead end: the id names the stash of the original, so
      // every withheld value is one tanuki_fetch or tanuki_verify away.
      expect(line).toContain(`id=${createHash("sha256").update(NOISY, "utf8").digest("hex").slice(0, 12)}`);
      expect(content.some((c) => c.type === "image")).toBe(true);
      // The refusal outranks lazy: a dense block is not imaged either way.
      const ids = Array.from({ length: 40 }, (_, i) => `id=${String(i).padStart(4, "0")}deadbeef4f3a`).join("\n");
      const refused = toolRender({ text: ids, level: 0, verbatim: "lazy" }) as Array<{ type: string; text?: string }>;
      expect(refused.length).toBe(1);
      expect(refused[0].text).toContain("refused to render");
    } finally {
      if (prev === undefined) delete process.env.TANUKI_STASH;
      else process.env.TANUKI_STASH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------- credential refuse-to-render gate
describe("credential gate: secrets are never rendered to pixels", () => {
  const SECRET = "deploy log line one\nAWS_KEY=AKIAIOSFODNN7EXAMPLE ok\nmore ordinary log output here\n";
  const CLEAN = "2026-07-27 INFO copied /srv/data/batch/segment_3.parquet ok\n".repeat(40);

  test("scanCredentials finds known secret shapes, ignores clean logs", () => {
    expect(scanCredentials(SECRET)).toContain("aws-key");
    expect(scanCredentials("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n")).toContain("private-key");
    expect(scanCredentials("token ghp_" + "a".repeat(36))).toContain("github-token");
    expect(scanCredentials(CLEAN)).toEqual([]);
  });

  test("toolRender refuses a block with a credential, returns no image", () => {
    const out = toolRender({ text: SECRET, level: 0 }) as Array<{ type: string; text?: string }>;
    expect(out.some((c) => c.type === "image")).toBe(false);
    expect(out[0].text).toContain("refused to render");
    expect(out[0].text).toContain("aws-key");
  });

  test("toolEstimate flags credentials and refuses the verdict", () => {
    const e = toolEstimate({ text: SECRET, level: 0 }) as { verdict: string; credentials: unknown };
    expect(e.verdict).toBe("TEXT cheaper (credentials)");
    expect(e.credentials).toContain("aws-key");
  });
});

// ------------------------------------------- slim default tools/list surface
describe("visibleTools: slim default surface, all tools behind a flag", () => {
  test("default advertises the six workflow tools; all 8 stay callable", () => {
    delete process.env.TANUKI_ALL_TOOLS;
    expect(visibleTools().map((t) => t.name)).toEqual([...DEFAULT_TOOL_NAMES]);
    // stash without fetch is a one-way door: the model parks text it can never
    // read back, and burns its turns hunting a tool that was never advertised.
    expect(visibleTools().map((t) => t.name)).toContain("tanuki_fetch");
    expect(visibleTools().map((t) => t.name)).toContain("tanuki_stats");
    expect(visibleTools().length).toBe(6);
    expect(TOOLS.length).toBe(8);
  });

  test("TANUKI_ALL_TOOLS=1 restores the full surface", () => {
    process.env.TANUKI_ALL_TOOLS = "1";
    expect(visibleTools().length).toBe(8);
    delete process.env.TANUKI_ALL_TOOLS;
  });
});

// ------------------------------------------- prompt-cache safety / fail-open
// Two properties ctxdiff (github.com/salmanzafar949/ctxdiff) audits by design,
// asserted here: a rendered block must be byte-stable or every re-image
// silently re-bills the caller's cached prefix, and a proxy in the request
// path must never break the request it is optimizing.
describe("cache safety and fail-open", () => {
  test("rendering the same text twice is byte-identical", () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `2026-07-27T08:00:0${i % 10}Z worker INFO poll ok latency=${i % 40}ms conn=${i % 9}`,
    ).join("\n");
    const a = renderText(text, true, true, "normal");
    const b = renderText(text, true, true, "normal");
    expect(a.pages.length).toBe(b.pages.length);
    // Non-deterministic PNG bytes would re-bill the whole imaged prefix on
    // every turn - a cost regression invisible to every other test here.
    for (let i = 0; i < a.pages.length; i++) {
      expect(Buffer.from(a.pages[i].png).equals(Buffer.from(b.pages[i].png))).toBe(true);
    }
  });

  test("the proxy transform never throws, whatever the body", () => {
    const cfg = { ...PROXY_DEFAULTS };
    const big = "x".repeat(20000);
    for (const raw of [
      "not json",
      "",
      "null",
      "[]",
      '{"messages":"not-an-array"}',
      '{"messages":[{"role":"user"}]}',
      '{"messages":[{"role":"user","content":null}]}',
      '{"messages":[{"role":"user","content":[{"type":"text"}]}]}',
      `{"messages":[{"role":"user","content":${JSON.stringify(big)}}]}`,
      `{"messages":[{"role":"user","content":${JSON.stringify("\u0000\uFFFD\u200B".repeat(4000))}}]}`,
      `{"messages":[{"role":"user","content":${JSON.stringify("😀🧪".repeat(6000))}}]}`,
    ]) {
      expect(() => transformRequestBody(raw, cfg)).not.toThrow();
    }
  });
});

// TANUKI_VERBATIM is a DEFAULT, not an override. Both engines originally got
// this wrong in the same way - an explicit `verbatim: true` fell through to the
// env - and because they were wrong identically, the cross-engine check passed.
const { parseVerbatim } = await import("../src/needles.ts");

describe("TANUKI_VERBATIM default vs explicit argument", () => {
  const withEnv = (v: string | undefined, fn: () => void): void => {
    const prev = process.env.TANUKI_VERBATIM;
    if (v === undefined) delete process.env.TANUKI_VERBATIM;
    else process.env.TANUKI_VERBATIM = v;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.TANUKI_VERBATIM;
      else process.env.TANUKI_VERBATIM = prev;
    }
  };

  test("absent argument takes the env", () => {
    withEnv("lazy", () => expect(parseVerbatim(undefined)).toBe("lazy"));
    withEnv("off", () => expect(parseVerbatim(undefined)).toBe("off"));
    withEnv("LAZY", () => expect(parseVerbatim(undefined)).toBe("lazy"));
    withEnv("nonsense", () => expect(parseVerbatim(undefined)).toBe("full"));
    withEnv(undefined, () => expect(parseVerbatim(undefined)).toBe("full"));
  });

  test("an explicit argument always beats the env", () => {
    withEnv("lazy", () => {
      expect(parseVerbatim(true)).toBe("full");
      expect(parseVerbatim(false)).toBe("off");
      expect(parseVerbatim("lazy")).toBe("lazy");
    });
    withEnv("off", () => {
      expect(parseVerbatim(true)).toBe("full");
      expect(parseVerbatim("lazy")).toBe("lazy");
    });
  });
});
