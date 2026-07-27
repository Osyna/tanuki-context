#!/usr/bin/env node
//! tanuki-context — token-cutting context pipeline.
//!   pipeline: text -> distill (stage 0, logs) -> ladder level 0-4 (stage 1)
//!             -> pxpipe imaging (stage 2, name kept from the original mechanic)
//!
//! Default: MCP stdio server (newline-delimited JSON-RPC 2.0).
//! CLI: tanuki-context distill <file> [query]
//!      tanuki-context estimate <file> [level] [--distill]
//!      tanuki-context render <file> [level] [outdir]
//!      tanuki-context proxy [--port N] [--upstream URL] [knobs]   (implicit mode)

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { apply as codebookApply } from "./codebook.ts";
import { costVerdict } from "./cost.ts";
import { tableEncode } from "./table.ts";
import { distillLog } from "./distill.ts";
import { LEVELS, compressText } from "./ladder.ts";
import { PROXY_DEFAULTS, startProxy } from "./proxy.ts";
import { estimateText, parseFont, renderText } from "./render.ts";
import { fetchSlice, stashText } from "./stash.ts";
import { Float, pxStats } from "./stats.ts";

export const VERSION = "0.6.2";
const MAX_INLINE_PAGES = 6;
const RUN_INLINE_MAX = 8000; // chars (~2k tokens) the run wrapper prints inline

// ------------------------------------------------------- serde_json parity

/** Rust `String` Ord = UTF-8 byte order = code-point order (not UTF-16 unit order). */
function keyCmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i >= n) {
    return a.length - b.length;
  }
  return a.codePointAt(i)! - b.codePointAt(i)!;
}

/** serde_json-compatible serializer (compact = `Display`, pretty = 2-space
 *  `to_string_pretty`). serde_json's default Map is a BTreeMap, so object keys
 *  serialize in byte-lexicographic order. Whole f64s (wrapped in `Float`)
 *  print as `50.0`. */
export function jstring(v: unknown, pretty: boolean, indent = ""): string {
  if (v === null || v === undefined) {
    return "null";
  }
  if (v instanceof Float) {
    const f = v.value;
    return Number.isFinite(f) && Number.isInteger(f) ? f.toFixed(1) : String(f);
  }
  const t = typeof v;
  if (t === "string") {
    return JSON.stringify(v);
  }
  if (t === "number" || t === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return "[]";
    }
    if (!pretty) {
      let out = "[";
      for (let i = 0; i < v.length; i++) {
        if (i > 0) out += ",";
        out += jstring(v[i], false);
      }
      return out + "]";
    }
    const inner = indent + "  ";
    let out = "[\n";
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ",\n";
      out += inner + jstring(v[i], true, inner);
    }
    return out + "\n" + indent + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort(keyCmp);
  if (keys.length === 0) {
    return "{}";
  }
  if (!pretty) {
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      out += JSON.stringify(keys[i]) + ":" + jstring(obj[keys[i]], false);
    }
    return out + "}";
  }
  const inner = indent + "  ";
  let out = "{\n";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",\n";
    out += inner + JSON.stringify(keys[i]) + ": " + jstring(obj[keys[i]], true, inner);
  }
  return out + "\n" + indent + "}";
}

/** serde_json `Value` string index: Null for non-objects / missing keys. */
function jget(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)[key]
    : undefined;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Rust `chars().count()`: Unicode scalar values, not UTF-16 units. */
function charCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return n;
}

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

function textTokens(chars: number): number {
  return Math.round(chars / 4.0);
}

function pct(from: number, to: number): number {
  if (from === 0) {
    return 0;
  }
  const x = (1.0 - to / from) * 100.0;
  return x < 0 ? -Math.round(-x) : Math.round(x); // f64::round: half away from zero
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
  const dis = walk(distillLog(disBase, null, 2).distilled);
  const tiny = estimateText(rev.text, true, true, parseFont("tiny"));
  return {
    codebook: rev.codebook,
    imageTokens: rev.tokens,
    pages: rev.pages,
    table,
    tinyImageTokens: tiny.tokens,
    withDistill: { codebook: dis.codebook, imageTokens: dis.tokens },
  };
}

export function toolEstimate(args: unknown): Record<string, unknown> {
  const a = pipeArgs(args);
  const p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
  const font = parseFont(a.font);
  const est = estimateText(p.compressed, a.reflow, a.pack, font);
  const imgTok = est.tokens;
  const origChars = charCount(a.text);
  const stage1Chars = charCount(p.compressed);
  const rawTok = textTokens(origChars);
  const [name, loss] = LEVELS[p.level];
  const model = asStr(jget(args, "model"));
  const cached = asBool(jget(args, "cached")) ?? false;
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
    totalSavedPct: pct(rawTok, imgTok),
    protectedLines: p.protectedLines,
    pack: a.pack,
    font: font === "tiny" ? "tiny" : "normal",
    codebook: a.codebook ? p.cbEntries : false,
    table: p.table !== null ? p.table : false,
    verdict: imgTok < rawTok ? "PIPELINE cheaper" : "TEXT cheaper",
    recommend: recommendFor(a.text),
  };
  // Situation-aware real cost: only when a model or cache state is supplied, so
  // the default token-count result (and the parity harness) stay byte-identical.
  if (model !== null || cached) {
    out.cost = costVerdict(rawTok, imgTok, { model, cached }, { dims: est.dims });
  }
  return out;
}

export function toolRender(args: unknown): unknown[] {
  const a = pipeArgs(args);
  const p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
  const font = parseFont(a.font);
  const r = renderText(p.compressed, a.reflow, a.pack, font);
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
  const content: unknown[] = [{ type: "text", text: summary }];
  const inline = Math.min(r.pages.length, MAX_INLINE_PAGES);
  for (let i = 0; i < inline; i++) {
    const png = r.pages[i].png;
    content.push({
      type: "image",
      data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"),
      mimeType: "image/png",
    });
  }
  if (r.pages.length > MAX_INLINE_PAGES) {
    content.push({ type: "text", text: `(+${r.pages.length - MAX_INLINE_PAGES} more page(s))` });
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

export function toolFetch(args: unknown): unknown[] {
  const id = asStr(jget(args, "id")) ?? "";
  const slice = fetchSlice(id, asStr(jget(args, "query")) ?? null, asStr(jget(args, "lines")) ?? null);
  const rawTok = textTokens(charCount(slice));
  const r = renderText(slice, true, true, parseFont("normal"));
  const wins = r.tokens <= rawTok * 0.75 && rawTok - r.tokens >= 300 && r.pages.length <= 6;
  if (!wins) {
    return [{ type: "text", text: slice }];
  }
  const marker =
    `[tanuki-context stash ${id}: slice of ${charCount(slice)} chars imaged as ${r.pages.length} PNG page(s), ` +
    `~${r.tokens} vs ~${rawTok} text tokens. ↵=newline →=tab ⇥N=indent]`;
  const content: unknown[] = [{ type: "text", text: marker }];
  for (const p of r.pages) {
    const png = p.png;
    content.push({
      type: "image",
      data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"),
      mimeType: "image/png",
    });
  }
  return content;
}

function toolsList(): Record<string, unknown> {
  const textProp = { type: "string" };
  const levelSchema = { type: "integer", minimum: 0, maximum: 4 };
  return {
    tools: [
      {
        name: "tanuki_render",
        description:
          "Token-cut pipeline: optional columnar table (whole-JSON input: keys stated once in a ·cols· header, rows as tab-separated JSON cells — value-lossless), optional log distillation (dedupe noise, keep errors verbatim, optional query filter), optional codebook (repeated long tokens/path prefixes -> 1-cell sigils + a ·legend· line), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. pack (default true) = lossless tight reflow (single-cell tabs, ⇥N indent runs, width-trimmed pages). font 'tiny' = 4x6 cell, ~40% fewer image-tokens (opt-in). Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
        inputSchema: {
          type: "object",
          properties: {
            text: textProp,
            level: levelSchema,
            distill: { type: "boolean" },
            query: { type: "string" },
            reflow: { type: "boolean" },
            pack: { type: "boolean" },
            font: { type: "string", enum: ["normal", "tiny"] },
            codebook: { type: "boolean" },
            table: { type: "boolean" },
          },
          required: ["text"],
        },
      },
      {
        name: "tanuki_estimate",
        description:
          "Estimate tokens for the pipeline (table -> distill -> codebook -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/pack/font/codebook to pick a loss/size tradeoff. The result's 'recommend' field prices the reversible knobs (pack/codebook, and table for whole-JSON input — keys stated once, value-lossless) and, separately under 'withDistill', the lossy-but-counted log route. Pass 'model' (e.g. claude-opus-4, gpt-5, gemini-2.5) and/or cached:true to add a 'cost' field that prices the decision in real dollars with provider-correct image counting (Anthropic 28px patches, OpenAI 512px tiles, Gemini 768px tiles) and cache-read rates (a cached text token costs ~0.1x a fresh one on Anthropic), so imaging already-cached content usually loses even when it has fewer tokens. One call replaces manual knob probing.",
        inputSchema: {
          type: "object",
          properties: {
            text: textProp,
            level: levelSchema,
            distill: { type: "boolean" },
            query: { type: "string" },
            reflow: { type: "boolean" },
            pack: { type: "boolean" },
            font: { type: "string", enum: ["normal", "tiny"] },
            codebook: { type: "boolean" },
            table: { type: "boolean" },
            model: { type: "string" },
            cached: { type: "boolean" },
          },
          required: ["text"],
        },
      },
      {
        name: "tanuki_distill",
        description:
          "Stage 0 alone: make noisy logs/output small and readable WITHOUT imaging. Strips ANSI, collapses runs of near-identical lines/blocks into '[×N similar]', suppresses global near-dupes (exact + same-template) with exact counts, always keeps error/warn/fail lines verbatim, optional query (regex) returns only the relevant slice. table:true first columnar-encodes whole-JSON input (keys stated once) so identical rows collapse harder. Deterministic, order-preserving.",
        inputSchema: {
          type: "object",
          properties: { text: textProp, query: { type: "string" }, table: { type: "boolean" } },
          required: ["text"],
        },
      },
      {
        name: "tanuki_compress",
        description:
          "Stage 1 alone: graded text compression for content that stays TEXT. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths are preserved verbatim.",
        inputSchema: {
          type: "object",
          properties: { text: textProp, level: levelSchema },
          required: ["text"],
        },
      },
      {
        name: "tanuki_stats",
        description:
          "Summarize the pxpipe measurement log (~/.pxpipe/events.jsonl): requests, compression counts, honest input-token savings (input + cache reads + cache creates), and the output-token share of the bill — the part no input-side tool can cut.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "tanuki_stash",
        description:
          "Park bulky text outside the context window (content-addressed file under TANUKI_STASH or ~/.tanuki/stash) and get back a compact map: distill stats, top repeats, first/last lines, and the stash id. Pay a few hundred tokens now, fetch slices later - the retrieval pattern, with tanuki pricing on the way back.",
        inputSchema: { type: "object", properties: { text: textProp }, required: ["text"] },
      },
      {
        name: "tanuki_fetch",
        description:
          "Pull a slice of stashed text by id: query (regex, distill-powered: matches + error/warn lines + context) or lines 'a-b'. Big slices come back as dense PNG pages automatically when they clearly win (>=25% and >=300 tokens cheaper, <=6 pages); small ones stay text.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, query: { type: "string" }, lines: { type: "string" } },
          required: ["id"],
        },
      },
    ],
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
    case "tanuki_stats":
      content = [{ type: "text", text: jstring(pxStats(), true) }];
      break;
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
  const hasId =
    msg !== null &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    Object.prototype.hasOwnProperty.call(msg, "id");
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
          "usage: tanuki-context estimate <file> [level] [--distill] [--table] [--no-pack] [--font tiny] [--codebook] [--model <id>] [--cached]",
        );
      const text = readFileOrDie(file);
      const pos = argv.slice(3).filter((a) => !a.startsWith("--"));
      const level = pos.length > 0 ? (parseUint(pos[0], U64_MAX) ?? 0) : 0;
      const fi = argv.indexOf("--font");
      const font = fi !== -1 && argv[fi + 1] !== undefined ? argv[fi + 1] : "normal";
      const mi = argv.indexOf("--model");
      const model = mi !== -1 && argv[mi + 1] !== undefined ? argv[mi + 1] : null;
      const v = toolEstimate({
        text,
        level,
        distill: argv.includes("--distill"),
        pack: !argv.includes("--no-pack"),
        font,
        codebook: argv.includes("--codebook"),
        table: argv.includes("--table"),
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
          "usage: tanuki-context render <file> [level] [outdir] [--distill] [--table] [--no-pack] [--font tiny] [--codebook]",
        );
      const text = readFileOrDie(file);
      const pos = argv.slice(3).filter((a) => !a.startsWith("--"));
      const level = pos.length > 0 ? (parseUint(pos[0], U8_MAX) ?? 0) : 0;
      const pack = !argv.includes("--no-pack");
      const useCb = argv.includes("--codebook");
      const fi = argv.indexOf("--font");
      const font = parseFont(fi !== -1 && argv[fi + 1] !== undefined ? argv[fi + 1] : "normal");
      const p = stage01(text, level, argv.includes("--distill"), null, useCb, argv.includes("--table"));
      const r = renderText(p.compressed, true, pack, font);
      const tok = r.tokens;
      process.stdout.write(
        jstring(
          {
            pages: r.pages.length,
            imageTokens: tok,
            dropped: r.dropped,
            rawTextTokens: textTokens(charCount(text)),
          },
          false,
        ) + "\n",
      );
      const dir = pos[1];
      if (dir !== undefined) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          fatal("mkdir");
        }
        for (let i = 0; i < r.pages.length; i++) {
          try {
            writeFileSync(`${dir}/page${i}.png`, r.pages[i].png);
          } catch {
            fatal("write png");
          }
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
        const i = argv.indexOf(flag);
        if (i === -1 || argv[i + 1] === undefined) return dflt;
        const v = Number(argv[i + 1]);
        return Number.isFinite(v) ? v : dflt;
      };
      const ui = argv.indexOf("--upstream");
      const fi = argv.indexOf("--font");
      startProxy({
        port: num("--port", 8484),
        upstream:
          ui !== -1 && argv[ui + 1] !== undefined
            ? argv[ui + 1]
            : (process.env.TANUKI_UPSTREAM ?? "https://api.anthropic.com"),
        level: num("--level", PROXY_DEFAULTS.level),
        distill: argv.includes("--distill"),
        table: argv.includes("--table"),
        codebook: argv.includes("--codebook"),
        font: parseFont(fi !== -1 && argv[fi + 1] !== undefined ? argv[fi + 1] : "normal"),
        minChars: num("--min-chars", PROXY_DEFAULTS.minChars),
        ratio: num("--ratio", PROXY_DEFAULTS.ratio),
        minSave: num("--min-save", PROXY_DEFAULTS.minSave),
        maxPages: num("--max-pages", PROXY_DEFAULTS.maxPages),
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
      const qi = argv.indexOf("--query");
      const li = argv.indexOf("--lines");
      let slice = "";
      try {
        slice = fetchSlice(id, qi !== -1 ? (argv[qi + 1] ?? null) : null, li !== -1 ? (argv[li + 1] ?? null) : null);
      } catch (e) {
        fatal(e instanceof Error ? e.message : String(e));
      }
      const rawTok = textTokens(charCount(slice));
      const r = renderText(slice, true, true, parseFont("normal"));
      const wins = r.tokens <= rawTok * 0.75 && rawTok - r.tokens >= 300 && r.pages.length <= 6;
      if (!wins) {
        process.stdout.write(jstring({ mode: "text" }, false) + "\n" + slice + "\n");
        break;
      }
      process.stdout.write(
        jstring({ imageTokens: r.tokens, mode: "pages", pages: r.pages.length, rawTextTokens: rawTok }, false) + "\n",
      );
      const flagVals = new Set([qi + 1, li + 1]);
      let dir: string | undefined;
      for (let i = 3; i < argv.length; i++) {
        if (!argv[i].startsWith("--") && !flagVals.has(i)) {
          dir = argv[i];
          break;
        }
      }
      if (dir !== undefined) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          fatal("mkdir");
        }
        for (let i = 0; i < r.pages.length; i++) {
          try {
            writeFileSync(`${dir}/page${i}.png`, r.pages[i].png);
          } catch {
            fatal("write png");
          }
        }
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
      const qi = argv.indexOf("--query");
      const query = qi !== -1 && qi < sep ? (argv[qi + 1] ?? null) : null;
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
        `unknown command: ${argv[1]}\nusage: tanuki-context [serve|proxy|distill|estimate|render|bench|stash|fetch|run] ...\n`,
      );
      process.exit(1);
  }
}
