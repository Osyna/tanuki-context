#!/usr/bin/env node
//! tanuki-context — token-cutting context pipeline.
//!   pipeline: text -> table/distill (stage 0) -> codebook (stage 0.5)
//!             -> ladder level 0-4 (stage 1) -> pxpipe imaging (stage 2)
//!
//! Default: MCP stdio server (newline-delimited JSON-RPC 2.0).
//! CLI: tanuki-context [serve|proxy|distill|estimate|render|bench|stash|fetch|verify|run]
//!      (usage strings live on each case below)

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { apply as codebookApply } from "./codebook.ts";
import { costVerdict } from "./cost.ts";
import { fidelity } from "./fidelity.ts";
import { tableEncode } from "./table.ts";
import { distillLog } from "./distill.ts";
import { LEVELS, compressText } from "./ladder.ts";
import { scanNeedles, scanCredentials } from "./needles.ts";
import { PROXY_DEFAULTS, startProxy } from "./proxy.ts";
import { estimateText, parseFont, renderText, type Page, type Rendered } from "./render.ts";
import { Float, asBool, asStr, asU64, charCount, isObj, jget, jstring, rnd, textTokens } from "./serde.ts";
import { fetchSlice, stashText, verifyValue } from "./stash.ts";
import { pxStats } from "./stats.ts";
import { TOOLS, visibleTools } from "./tools.ts";

export const VERSION = "0.13.1";
const MAX_INLINE_PAGES = 6;
const RUN_INLINE_MAX = 8000; // chars (~2k tokens) the run wrapper prints inline

// ------------------------------------------------------------------ stages

interface PipelineOut {
  stage0: Record<string, unknown> | null;
  compressed: string;
  protectedLines: number;
  level: number;
  cbEntries: number;
  table: { rows: number; cols: number } | null;
}

/** Stages 0 + 0.5 + 1: optional distill, optional codebook, then ladder level. */
function stage01(
  text: string,
  level: number,
  useDistill: boolean,
  query: string | null,
  useCodebook: boolean,
  useTable: boolean,
): PipelineOut {
  let working = text;
  let table: { rows: number; cols: number } | null = null;
  if (useTable) {
    const t = tableEncode(working);
    if (t !== null) {
      working = t.text;
      table = { rows: t.rows, cols: t.cols };
    }
  }
  let stage0: Record<string, unknown> | null = null;
  if (useDistill || query !== null) {
    const d = distillLog(working, query, 2);
    working = d.distilled;
    stage0 = d.stats as Record<string, unknown>;
  }
  let cbEntries = 0;
  if (useCodebook) {
    const cb = codebookApply(working);
    working = cb.text;
    cbEntries = cb.entries;
  }
  const c = compressText(working, level);
  return {
    stage0,
    compressed: c.compressed,
    protectedLines: c.protectedLines,
    level: c.level,
    cbEntries,
    table,
  };
}

function pct(from: number, to: number): number {
  if (from === 0) {
    return 0;
  }
  return rnd((1.0 - to / from) * 100.0);
}

// ---------------------------------------------------------------- MCP tools

/** Shared arguments of the pipeline tools (render/estimate). */
interface PipeArgs {
  text: string;
  level: number;
  distill: boolean;
  query: string | null;
  reflow: boolean;
  pack: boolean;
  font: string;
  codebook: boolean;
  table: boolean;
  verbatim: boolean;
}

function pipeArgs(args: unknown): PipeArgs {
  return {
    text: asStr(jget(args, "text")) ?? "",
    level: (asU64(jget(args, "level")) ?? 0) % 256, // `as u8` wraps
    distill: asBool(jget(args, "distill")) ?? false,
    query: asStr(jget(args, "query")),
    reflow: asBool(jget(args, "reflow")) ?? true,
    pack: asBool(jget(args, "pack")) ?? true,
    font: asStr(jget(args, "font")) ?? "normal",
    codebook: asBool(jget(args, "codebook")) ?? false,
    table: asBool(jget(args, "table")) ?? false,
    verbatim: asBool(jget(args, "verbatim")) ?? true,
  };
}

/// Ladder walk, server-side: price the knob combos in one pass so the model
/// does not spend tool rounds probing. The headline fields walk only the
/// REVERSIBLE knobs (pack is byte-exact, codebook is legend-decodable, table
/// is value-lossless columnar for whole-JSON input); distill is
/// lossy-but-counted and built for logs, so its walk is reported separately
/// as `withDistill` - never labeled safe, because on source code collapsing
/// similar-looking lines is not safe. Strictly-less keeps the earliest
/// (fewest-knob) combo on ties. ponytail: ~7 extra estimates + 1 distill per
/// call; gate behind a flag if huge-input latency ever matters.
function recommendFor(text: string): Record<string, unknown> {
  const walk = (base: string): { codebook: boolean; tokens: number; pages: number; text: string } => {
    let best = { codebook: false, tokens: Infinity, pages: 0, text: base };
    for (const c of [false, true]) {
      const t = c ? codebookApply(base).text : base;
      const e = estimateText(t, true, true, parseFont("normal"));
      if (e.tokens < best.tokens) best = { codebook: c, tokens: e.tokens, pages: e.pages, text: t };
    }
    return best;
  };
  let rev = walk(text);
  let table = false;
  const tbl = tableEncode(text);
  if (tbl !== null) {
    const wt = walk(tbl.text);
    if (wt.tokens < rev.tokens) {
      rev = wt;
      table = true;
    }
  }
  const disBase = table && tbl !== null ? tbl.text : text;
  const disDistilled = distillLog(disBase, null, 2).distilled;
  const dis = walk(disDistilled);
  const tiny = estimateText(rev.text, true, true, parseFont("tiny"));
  // Stays-as-text route (no pxpipe): the wider router's answer for when imaging
  // loses - cached text, small inputs, or credential content that must not be
  // pixels. Lossless whitespace (ladder L1: trailing ws + blank-line runs, safe
  // for code) is the headline; distill is the lossy-but-error-preserving log
  // sibling, priced as text - the same distilled bytes withDistill counts as
  // pages. Tier 0/1 of the density note: delete waste before you reach to image.
  const rawTextTok = textTokens(charCount(text));
  const wsTok = textTokens(charCount(compressText(text, 1).compressed));
  const wsWins = wsTok < rawTextTok;
  const textTok = wsWins ? wsTok : rawTextTok;
  return {
    codebook: rev.codebook,
    imageTokens: rev.tokens,
    pages: rev.pages,
    table,
    tinyImageTokens: tiny.tokens,
    withDistill: { codebook: dis.codebook, imageTokens: dis.tokens },
    text: {
      transform: wsWins ? "whitespace" : "none",
      tokens: textTok,
      savedPct: pct(rawTextTok, textTok),
      withDistill: textTokens(charCount(disDistilled)),
    },
  };
}

/// The hybrid pick: ONE recommended route over the candidates `recommend`
/// already prices, gated by real cost AND read-back fidelity - not just fewest
/// tokens. Imaging is chosen only when it clears the DeepSeek-OCR clean band
/// (high/good) AND is the genuine save; past the cliff, on cached content, or on
/// credentials it routes to the lossless text side. Every alternative stays
/// priced in `recommend` for the caller to override - this is the historic
/// image/text call widened to hybrid: pxpipe when it wins without losing the
/// task, a text tier when it does not.
function routeFor(
  rawTok: number,
  rec: Record<string, unknown>,
  sideTok: number,
  creds: number,
  costCheaper: string | null,
  dense: boolean,
): Record<string, unknown> {
  const recImg = rec.imageTokens as number;
  const text = rec.text as { transform: string; tokens: number };
  const imageTok = recImg + sideTok; // imaging always ships the verbatim sidecar
  const level = fidelity(rawTok, recImg, false).level;
  const imageClean = level === "high" || level === "good";
  const textPick = text.transform === "none" ? "raw" : "text";
  let pick: string;
  let tokens: number;
  let fid: string;
  let reason: string;
  if (creds > 0) {
    pick = textPick; tokens = text.tokens; fid = "exact";
    reason = "credential content is never imaged - stay text";
  } else if (dense) {
    // The sidecar hit its budget, so some exact strings are NOT carried. The
    // cost math cannot catch this on its own - a capped sidecar stays cheap
    // while dropping the very ids it exists to protect.
    pick = textPick; tokens = text.tokens; fid = "exact";
    reason = "needle-dense: more exact strings than the sidecar can carry, so imaging would drop some of them unverifiably - stay text";
  } else if (costCheaper === "TEXT") {
    pick = textPick; tokens = text.tokens; fid = "exact";
    reason = "priced in dollars the text side wins (cached content loses as pixels)";
  } else if (imageClean && imageTok < text.tokens) {
    pick = "image"; tokens = imageTok; fid = level;
    reason = "imaging clears the read-back band and beats the text side on tokens";
  } else if (!imageClean) {
    pick = textPick; tokens = text.tokens; fid = "exact";
    reason = "imaging is past the read-back cliff; the lossless text route keeps fidelity (image only to comprehend the bulk)";
  } else {
    pick = textPick; tokens = text.tokens; fid = "exact";
    reason = "the text side is already the cheaper route; imaging adds no real save";
  }
  return { pick, tokens, savedPct: pct(rawTok, tokens), fidelity: fid, reason };
}

export function toolEstimate(args: unknown): Record<string, unknown> {
  const a = pipeArgs(args);
  const p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
  const font = parseFont(a.font);
  const est = estimateText(p.compressed, a.reflow, a.pack, font);
  const side = a.verbatim ? scanNeedles(p.compressed, charCount(a.text)) : null;
  const sideTok = side === null ? 0 : side.tokens;
  const imgTok = est.tokens;
  const origChars = charCount(a.text);
  const stage1Chars = charCount(p.compressed);
  const rawTok = textTokens(origChars);
  const [name, loss] = LEVELS[p.level];
  const model = asStr(jget(args, "model"));
  const cached = asBool(jget(args, "cached")) ?? false;
  const creds = scanCredentials(a.text);
  const rec = recommendFor(a.text);
  const out: Record<string, unknown> = {
    engine: "pxpipe",
    level: `${p.level} ${name}`,
    loss,
    distill: p.stage0,
    origChars,
    stage1Chars,
    stage1SavedPct: pct(origChars, stage1Chars),
    pages: est.pages,
    imageTokens: imgTok,
    rawTextTokens: rawTok,
    totalSavedPct: pct(rawTok, imgTok + sideTok),
    fidelity: fidelity(rawTok, imgTok, font === "tiny"),
    protectedLines: p.protectedLines,
    pack: a.pack,
    font: font === "tiny" ? "tiny" : "normal",
    codebook: a.codebook ? p.cbEntries : false,
    table: p.table !== null ? p.table : false,
    verbatim: side === null ? false : { more: side.more, dense: side.dense, needles: side.needles.length + side.more, tokens: side.tokens },
    verdict: creds.length > 0 ? "TEXT cheaper (credentials)" : side !== null && side.dense ? "TEXT cheaper (needle-dense)" : imgTok + sideTok < rawTok ? "PIPELINE cheaper" : "TEXT cheaper",
    credentials: creds.length > 0 ? creds : false,
    recommend: rec,
  };
  // Situation-aware real cost: only when a model or cache state is supplied, so
  // the default token-count result (and the parity harness) stay byte-identical.
  let costCheaper: string | null = null;
  if (model !== null || cached) {
    const cost = costVerdict(rawTok, imgTok, { model, cached }, { dims: est.dims });
    out.cost = cost;
    costCheaper = cost.cheaper;
  }
  out.route = routeFor(rawTok, rec, sideTok, creds.length, costCheaper, side !== null && side.dense);
  return out;
}

/// MCP image content blocks for rendered pages.
function imageBlocks(pages: Page[]): unknown[] {
  return pages.map((p) => ({
    type: "image",
    data: Buffer.from(p.png.buffer, p.png.byteOffset, p.png.byteLength).toString("base64"),
    mimeType: "image/png",
  }));
}

export function toolRender(args: unknown): unknown[] {
  const a = pipeArgs(args);
  const creds = scanCredentials(a.text);
  if (creds.length > 0) {
    return [{ type: "text", text: `[tanuki-context: refused to render — ${creds.length} credential-shaped secret(s) detected (${creds.join(", ")}); kept as text so a secret is never silently misread from pixels]` }];
  }
  const p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
  const font = parseFont(a.font);
  const r = renderText(p.compressed, a.reflow, a.pack, font);
  const side = a.verbatim ? scanNeedles(p.compressed, charCount(a.text)) : null;
  const imgTok = r.tokens;
  const origChars = charCount(a.text);
  const stage1Chars = charCount(p.compressed);
  const rawTok = textTokens(origChars);
  const [name, loss] = LEVELS[p.level];
  let summary = "";
  if (p.table !== null) {
    summary += `table: ${p.table.rows} rows x ${p.table.cols} cols, keys stated once\n`;
  }
  if (p.stage0 !== null) {
    const s0 = p.stage0;
    summary += `distill: ${s0["origLines"]} -> ${s0["outLines"]} lines (-${s0["savedPct"]}% chars, ${s0["collapsedRuns"]} runs, ${s0["suppressedLines"]} exact + ${s0["templateSuppressed"]} template suppressed, ${s0["importantKept"]} error/warn kept)\n`;
  }
  summary += `L${p.level} ${name} (${loss}): ${origChars} chars -> ${stage1Chars} chars (stage1 -${pct(
    origChars,
    stage1Chars,
  )}%) -> ${r.pages.length} page(s), ~${imgTok} image-tokens\nvs ~${rawTok} text-tokens raw = TOTAL -${pct(
    rawTok,
    imgTok,
  )}%`;
  if (p.protectedLines > 0) {
    summary += ` · ${p.protectedLines} lines kept verbatim`;
  }
  if (r.dropped > 0) {
    summary += ` · ${r.dropped} unmapped glyphs -> ▯`;
  }
  if (p.cbEntries > 0) {
    summary += ` · codebook: ${p.cbEntries} sigils (see ·legend·)`;
  }
  if (font === "tiny") {
    summary += " · font: tiny 4x6";
  }
  if (a.pack) {
    summary += " · packed (⇥N indent, → tab)";
  }
  if (a.reflow) {
    summary += " · ↵ = newline · engine: pxpipe";
  }
  if (side !== null && side.needles.length > 0) {
    summary += ` · verbatim: ${side.needles.length + side.more} exact strings ride below as text`;
  }
  const content: unknown[] = [{ type: "text", text: summary }];
  content.push(...imageBlocks(r.pages.slice(0, MAX_INLINE_PAGES)));
  if (r.pages.length > MAX_INLINE_PAGES) {
    content.push({ type: "text", text: `(+${r.pages.length - MAX_INLINE_PAGES} more page(s))` });
  }
  if (side !== null && side.text !== "") {
    content.push({ type: "text", text: side.text });
  }
  return content;
}

export function toolDistill(args: unknown): unknown[] {
  const text = asStr(jget(args, "text")) ?? "";
  let working = text;
  let table: { rows: number; cols: number } | null = null;
  if (asBool(jget(args, "table")) ?? false) {
    const t = tableEncode(working);
    if (t !== null) {
      working = t.text;
      table = { rows: t.rows, cols: t.cols };
    }
  }
  const d = distillLog(working, asStr(jget(args, "query")), 2);
  const stats =
    table !== null ? { ...(d.stats as Record<string, unknown>), table } : d.stats;
  return [
    { type: "text", text: jstring(stats, true) },
    { type: "text", text: d.distilled },
  ];
}

export function toolCompress(args: unknown): unknown[] {
  const text = asStr(jget(args, "text")) ?? "";
  const level = (asU64(jget(args, "level")) ?? 1) % 256; // `as u8` wraps
  const c = compressText(text, level);
  const [name, loss, desc] = LEVELS[c.level];
  const origChars = charCount(text);
  const outChars = charCount(c.compressed);
  const oTok = textTokens(origChars);
  const nTok = textTokens(outChars);
  const stats = {
    level: `${c.level} ${name}`,
    loss,
    note: desc,
    origChars,
    outChars,
    approxOrigTokens: oTok,
    approxOutTokens: nTok,
    savedPct: pct(oTok, nTok),
    protectedLines: c.protectedLines,
  };
  return [
    { type: "text", text: jstring(stats, true) },
    { type: "text", text: c.compressed },
  ];
}

export function toolStash(args: unknown): unknown[] {
  const text = asStr(jget(args, "text")) ?? "";
  const s = stashText(text);
  return [{ type: "text", text: s.overview }];
}

interface FetchResult {
  slice: string;
  rawTok: number;
  r: Rendered;
  wins: boolean;
}

/// Fetch a stash slice and decide the return shape (the tanuki_fetch
/// contract): pages when they clearly win — >=25% and >=300 tokens cheaper,
/// <=6 pages — text otherwise.
function fetchRendered(id: string, query: string | null, lines: string | null): FetchResult {
  const slice = fetchSlice(id, query, lines);
  const rawTok = textTokens(charCount(slice));
  const r = renderText(slice, true, true, "normal");
  const wins = r.tokens <= rawTok * 0.75 && rawTok - r.tokens >= 300 && r.pages.length <= 6 && scanCredentials(slice).length === 0;
  return { slice, rawTok, r, wins };
}

export function toolFetch(args: unknown): unknown[] {
  const id = asStr(jget(args, "id")) ?? "";
  const f = fetchRendered(id, asStr(jget(args, "query")), asStr(jget(args, "lines")));
  if (!f.wins) {
    return [{ type: "text", text: f.slice }];
  }
  const marker =
    `[tanuki-context stash ${id}: slice of ${charCount(f.slice)} chars imaged as ${f.r.pages.length} PNG page(s), ` +
    `~${f.r.tokens} vs ~${f.rawTok} text tokens. ↵=newline →=tab ⇥N=indent]`;
  return [{ type: "text", text: marker }, ...imageBlocks(f.r.pages)];
}

export function toolVerify(args: unknown): unknown[] {
  const id = asStr(jget(args, "id")) ?? "";
  const value = asStr(jget(args, "value")) ?? "";
  return [{ type: "text", text: jstring(verifyValue(id, value), true) }];
}

/// MCP tools/list, projected from the registry. The JSON schema layout is
/// parity-locked byte-for-byte with the Rust engine, so knob hints stay out
/// of it (the pi/SDK projections carry them).
function toolsList(): Record<string, unknown> {
  // Brief one-line descriptions by default (~4x smaller furniture the model
  // pays for on every request); TANUKI_TOOL_VERBOSE=1 restores the full
  // contracts. The slim default surface (visibleTools) is applied here too.
  const verbose = process.env.TANUKI_TOOL_VERBOSE === "1";
  return {
    tools: visibleTools().map((t) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of t.params) {
        const s: Record<string, unknown> = { type: p.type };
        if (p.values !== undefined) s.enum = p.values;
        if (p.min !== undefined) s.minimum = p.min;
        if (p.max !== undefined) s.maximum = p.max;
        properties[p.key] = s;
        if (p.required === true) required.push(p.key);
      }
      const inputSchema: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) inputSchema.required = required;
      return { name: t.name, description: verbose ? t.description : t.brief, inputSchema };
    }),
  };
}

function toolsCall(
  params: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const name = asStr(jget(params, "name")) ?? "";
  const args = jget(params, "arguments");
  let content: unknown;
  switch (name) {
    case "tanuki_render":
      content = toolRender(args);
      break;
    case "tanuki_estimate":
      content = [{ type: "text", text: jstring(toolEstimate(args), true) }];
      break;
    case "tanuki_distill":
      content = toolDistill(args);
      break;
    case "tanuki_compress":
      content = toolCompress(args);
      break;
    case "tanuki_stats": {
      // Self-cost, counted against ourselves: the tool schemas every request
      // carries (they ride the prompt cache after the first write, but they
      // are never free). No other tool in this category reports its own furniture.
      const s = pxStats() as Record<string, unknown>;
      s.toolFurnitureTokens = textTokens(charCount(jstring(toolsList(), false)));
      content = [{ type: "text", text: jstring(s, true) }];
      break;
    }
    case "tanuki_stash":
      content = toolStash(args);
      break;
    case "tanuki_fetch":
      try {
        content = toolFetch(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      break;
    case "tanuki_verify":
      try {
        content = toolVerify(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      break;
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
  return { ok: true, value: { content } };
}

// ---------------------------------------------------------------- MCP server

function handleLine(raw: string): void {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw; // BufRead::lines strips CRLF
  if (line.trim().length === 0) {
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const hasId = isObj(msg) && Object.prototype.hasOwnProperty.call(msg, "id");
  const id = hasId ? ((msg as Record<string, unknown>)["id"] ?? null) : null;
  const method = asStr(jget(msg, "method"));
  let out: unknown;
  switch (method) {
    case "initialize": {
      const proto = asStr(jget(jget(msg, "params"), "protocolVersion")) ?? "2025-06-18";
      out = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: proto,
          capabilities: { tools: {} },
          serverInfo: { name: "tanuki-context", version: VERSION },
        },
      };
      break;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      out = undefined;
      break;
    case "ping":
      out = { jsonrpc: "2.0", id, result: {} };
      break;
    case "tools/list":
      out = { jsonrpc: "2.0", id, result: toolsList() };
      break;
    case "tools/call": {
      const r = toolsCall(jget(msg, "params"));
      out = r.ok
        ? { jsonrpc: "2.0", id, result: r.value }
        : { jsonrpc: "2.0", id, error: { code: -32602, message: r.error } };
      break;
    }
    default:
      out = hasId
        ? { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }
        : undefined;
  }
  if (out !== undefined) {
    process.stdout.write(jstring(out, false) + "\n");
  }
}

function serve(): void {
  let leftover = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    let buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(0x0a, start)) !== -1) {
      handleLine(buf.toString("utf8", start, idx));
      start = idx + 1;
    }
    leftover = buf.subarray(start);
  });
  process.stdin.on("end", () => {
    if (leftover.length > 0) {
      handleLine(leftover.toString("utf8"));
      leftover = Buffer.alloc(0);
    }
  });
}

// ---------------------------------------------------------------- CLI

/** Mirrors a Rust panic (`.expect(...)`): message to stderr, exit code 101. */
function fatal(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(101);
}

function readFileOrDie(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    fatal("read file");
  }
}

/** `--flag value` lookup: the value token after `flag`, or null. */
function flagVal(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

/// Write pages as page<N>.png under dir (CLI render/fetch).
function writePages(dir: string, pages: Page[]): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    fatal("mkdir");
  }
  for (let i = 0; i < pages.length; i++) {
    try {
      writeFileSync(`${dir}/page${i}.png`, pages[i].png);
    } catch {
      fatal("write png");
    }
  }
}

/** Rust uint FromStr: optional '+', digits only, overflow -> Err. */
function parseUint(s: string, max: bigint): number | null {
  if (!/^\+?[0-9]+$/.test(s)) {
    return null;
  }
  const b = BigInt(s.startsWith("+") ? s.slice(1) : s);
  return b > max ? null : Number(b);
}

const U8_MAX = 255n;
const U64_MAX = 0xffffffffffffffffn;

export function main(): void {
  const argv = process.argv.slice(1); // argv[0] = program, argv[1] = command (like env::args)
  switch (argv[1]) {
    case "distill": {
      const file = argv[2] ?? fatal("usage: tanuki-context distill <file> [query] [--table]");
      const text = readFileOrDie(file);
      let working = text;
      if (argv.includes("--table")) {
        const t = tableEncode(working);
        if (t !== null) working = t.text;
      }
      const pos = argv.slice(3).filter((a) => !a.startsWith("--"));
      const d = distillLog(working, pos[0] ?? null, 2);
      process.stdout.write(jstring(d.stats, false) + "\n");
      break;
    }
    case "estimate": {
      const file =
        argv[2] ??
        fatal(
          "usage: tanuki-context estimate <file> [level] [--distill] [--table] [--no-pack] [--no-verbatim] [--font tiny] [--codebook] [--model <id>] [--cached]",
        );
      const text = readFileOrDie(file);
      const pos = argv.slice(3).filter((a) => !a.startsWith("--"));
      const level = pos.length > 0 ? (parseUint(pos[0], U64_MAX) ?? 0) : 0;
      const font = flagVal(argv, "--font") ?? "normal";
      const model = flagVal(argv, "--model");
      const v = toolEstimate({
        text,
        level,
        distill: argv.includes("--distill"),
        pack: !argv.includes("--no-pack"),
        font,
        codebook: argv.includes("--codebook"),
        table: argv.includes("--table"),
        verbatim: !argv.includes("--no-verbatim"),
        model,
        cached: argv.includes("--cached"),
      });
      process.stdout.write(jstring(v, false) + "\n");
      break;
    }
    case "render": {
      const file =
        argv[2] ??
        fatal(
          "usage: tanuki-context render <file> [level] [outdir] [--distill] [--table] [--no-pack] [--no-verbatim] [--font tiny] [--codebook]",
        );
      const text = readFileOrDie(file);
      const pos = argv.slice(3).filter((a) => !a.startsWith("--"));
      const level = pos.length > 0 ? (parseUint(pos[0], U8_MAX) ?? 0) : 0;
      const pack = !argv.includes("--no-pack");
      const useCb = argv.includes("--codebook");
      const font = parseFont(flagVal(argv, "--font") ?? "normal");
      const creds = scanCredentials(text);
      if (creds.length > 0) {
        process.stdout.write(jstring({ refused: true, credentials: creds }, false) + "\n");
        break;
      }
      const p = stage01(text, level, argv.includes("--distill"), null, useCb, argv.includes("--table"));
      const r = renderText(p.compressed, true, pack, font);
      const side = argv.includes("--no-verbatim") ? null : scanNeedles(p.compressed, charCount(text));
      const tok = r.tokens;
      process.stdout.write(
        jstring(
          {
            pages: r.pages.length,
            imageTokens: tok,
            dropped: r.dropped,
            rawTextTokens: textTokens(charCount(text)),
            verbatimTokens: side === null ? 0 : side.tokens,
          },
          false,
        ) + "\n",
      );
      const dir = pos[1];
      if (dir !== undefined) {
        writePages(dir, r.pages);
        if (side !== null && side.text !== "") {
          writeFileSync(`${dir}/verbatim.txt`, side.text + "\n");
        }
      }
      break;
    }
    case "bench": {
      // tanuki-context bench <file> <op:distill|pipeline> [level] [runs] [--distill]
      // In-process timing (median of `runs`, first run is a discarded warmup).
      // Imaging stays pxpipe-faithful (pack off) so node-vs-rust timing is comparable.
      const file =
        argv[2] ?? fatal("usage: tanuki-context bench <file> <op> [level] [runs] [--distill]");
      const op = argv[3] ?? "pipeline";
      const level = argv[4] !== undefined ? (parseUint(argv[4], U8_MAX) ?? 0) : 0;
      const runs = argv[5] !== undefined ? (parseUint(argv[5], U64_MAX) ?? 3) : 3;
      const useDistill = argv.includes("--distill");
      const text = readFileOrDie(file);
      const times: number[] = [];
      let result: unknown = null;
      for (let i = 0; i <= runs; i++) {
        const t0 = performance.now();
        if (op === "distill") {
          const d = distillLog(text, null, 2);
          result = d.stats;
        } else {
          const p = stage01(text, level, useDistill, null, false, false);
          const r = renderText(p.compressed, true, false, "normal");
          result = {
            pages: r.pages.length,
            imageTokens: r.tokens,
            stage1Chars: charCount(p.compressed),
            dropped: r.dropped,
          };
        }
        if (i > 0) {
          times.push(performance.now() - t0);
        }
      }
      times.sort((a, b) => a - b);
      if (times.length === 0) {
        fatal("index out of bounds: the len is 0 but the index is 0"); // Rust panics on times[0]
      }
      process.stdout.write(
        jstring(
          { medianMs: new Float(times[Math.floor(times.length / 2)]), runs, result },
          false,
        ) + "\n",
      );
      break;
    }
    case "proxy": {
      const num = (flag: string, dflt: number): number => {
        const s = flagVal(argv, flag);
        if (s === null) return dflt;
        const v = Number(s);
        return Number.isFinite(v) ? v : dflt;
      };
      startProxy({
        port: num("--port", 8484),
        upstream:
          flagVal(argv, "--upstream") ??
          process.env.TANUKI_UPSTREAM ??
          "https://api.anthropic.com",
        level: num("--level", PROXY_DEFAULTS.level),
        distill: argv.includes("--distill"),
        table: argv.includes("--table"),
        codebook: argv.includes("--codebook"),
        font: parseFont(flagVal(argv, "--font") ?? "normal"),
        minChars: num("--min-chars", PROXY_DEFAULTS.minChars),
        ratio: num("--ratio", PROXY_DEFAULTS.ratio),
        minSave: num("--min-save", PROXY_DEFAULTS.minSave),
        maxPages: num("--max-pages", PROXY_DEFAULTS.maxPages),
        recencyWindow: num(
          "--recency",
          Number.isFinite(Number(process.env.TANUKI_RECENCY))
            ? Number(process.env.TANUKI_RECENCY)
            : PROXY_DEFAULTS.recencyWindow,
        ),
      });
      break;
    }
    case "stash": {
      const file = argv[2] ?? fatal("usage: tanuki-context stash <file>");
      const s = stashText(readFileOrDie(file));
      process.stdout.write(s.overview + "\n");
      break;
    }
    case "fetch": {
      const id = argv[2] ?? fatal("usage: tanuki-context fetch <id> [outdir] [--query re] [--lines a-b]");
      let f: FetchResult;
      try {
        f = fetchRendered(id, flagVal(argv, "--query"), flagVal(argv, "--lines"));
      } catch (e) {
        fatal(e instanceof Error ? e.message : String(e));
      }
      if (!f.wins) {
        process.stdout.write(jstring({ mode: "text" }, false) + "\n" + f.slice + "\n");
        break;
      }
      process.stdout.write(
        jstring({ imageTokens: f.r.tokens, mode: "pages", pages: f.r.pages.length, rawTextTokens: f.rawTok }, false) + "\n",
      );
      let dir: string | undefined;
      for (let i = 3; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
          if (argv[i] === "--query" || argv[i] === "--lines") i++;
          continue;
        }
        dir = argv[i];
        break;
      }
      if (dir !== undefined) {
        writePages(dir, f.r.pages);
      }
      break;
    }
    case "verify": {
      const id = argv[2] ?? fatal("usage: tanuki-context verify <id> <value>");
      const value = argv[3] ?? fatal("usage: tanuki-context verify <id> <value>");
      try {
        process.stdout.write(jstring(verifyValue(id, value), false) + "\n");
      } catch (e) {
        fatal(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case "run": {
      // rtk-style wrapper: run the command, hand the agent distilled output
      // instead of the firehose, keep the full capture fetchable. Exit code
      // passes through untouched.
      const sep = argv.indexOf("--");
      const cmd = sep !== -1 ? argv.slice(sep + 1) : [];
      if (cmd.length === 0) fatal("usage: tanuki-context run [--query re] -- <command> [args...]");
      const query = flagVal(argv.slice(0, sep), "--query");
      const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.error !== undefined) fatal(`spawn failed: ${r.error.message}`);
      const captured =
        (r.stdout ?? "") + ((r.stderr ?? "") !== "" ? `\n--- stderr ---\n${r.stderr}` : "");
      const code = r.status ?? 0;
      const d = distillLog(captured, query, 2);
      const s = d.stats as { origLines: number; outLines: number; savedPct: number };
      const lines = [`[tanuki run] exit ${code} · ${s.origLines} -> ${s.outLines} lines · ${s.savedPct}% of chars removed`];
      // ponytail: fixed 8000-char inline budget (~2k tokens); make it a knob
      // if real usage ever wants one.
      if (charCount(d.distilled) <= RUN_INLINE_MAX || charCount(captured) <= RUN_INLINE_MAX) {
        lines.push(d.distilled);
        if (charCount(captured) > RUN_INLINE_MAX) {
          const st = stashText(captured);
          lines.push(`full output stashed: tanuki-context fetch ${st.id} [--query re] [--lines a-b]`);
        }
      } else {
        const st = stashText(captured);
        lines.push(st.overview);
      }
      process.stdout.write(lines.join("\n") + "\n");
      process.exit(code);
    }
    case "serve":
    case undefined:
      serve();
      break;
    default:
      process.stderr.write(
        `unknown command: ${argv[1]}\nusage: tanuki-context [serve|proxy|distill|estimate|render|bench|stash|fetch|verify|run] ...\n`,
      );
      process.exit(1);
  }
}
