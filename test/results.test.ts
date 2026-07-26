// Results suite: proves the three density knobs (pack / codebook / tiny font)
// deliver their claimed savings on real corpora, that every claimed-lossless
// transform round-trips byte-exact, and that the shipped dist/cli.js serves
// it all over MCP. `bun test` prints the measured table — the "result".

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  // floors deliberately below the measured cuts under the 28-px patch model
  // (log -65, source -43, prose -40; the patch model cut the BASELINE ~4%,
  // so relative knob savings sit below the old px/750 claims).
  const FLOORS = { prose: 30, source: 38, log: 55 };

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
    expect(tools).toEqual([
      "tanuki_render",
      "tanuki_estimate",
      "tanuki_distill",
      "tanuki_compress",
      "tanuki_stats",
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
