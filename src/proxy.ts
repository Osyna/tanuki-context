//! Implicit mode: a local Anthropic middlebox, the pxpipe deployment shape
//! without pxpipe's structural flaw. Rules that keep it injection-shaped-free:
//!
//!   1. The system prompt and tool definitions are NEVER touched.
//!   2. Nothing moves between roles or positions: an oversized text block is
//!      replaced IN PLACE by a short overt marker + PNG page blocks, in the
//!      same user-role message (Anthropic allows image blocks in user content
//!      and inside tool_result content).
//!   3. The latest `recencyWindow` message(s) are kept as text (default 1):
//!      recent turns are reasoned over precisely, distant bulk is imaged.
//!   4. Blocks carrying cache_control are never imaged (rewriting would
//!      defeat the cache they exist for).
//!   5. Imaging only happens when `estimate` says it wins by a clear margin;
//!      everything else passes through byte-for-byte.
//!   6. A block carrying a credential-shaped secret (API keys, private-key
//!      blocks, tokens) is never imaged: a secret must not be silently
//!      misread from pixels, so it stays text (needles.ts `scanCredentials`).
//!   7. Lossless first: a pretty-printed JSON tool result loses the
//!      whitespace between its tokens (strings byte-exact) in EVERY message,
//!      recent or not, breakpoint or not. The rewrite is deterministic and
//!      idempotent, so the block has the same bytes from its first request on
//!      and the API cache never sees it change. Rules 3 and 4 would break that:
//!      skipping a block while it holds the client's breakpoint and minifying
//!      it a turn later is exactly a cache break.
//!   8. Byte splicing, not re-serialising: the request is scanned once for the
//!      spans of the values that change (a minified string, an imaged block's
//!      replacement, an added `cache_control`) and only those spans are
//!      substituted. Key order, whitespace, number spellings, system and tools
//!      stay the client's own bytes, so no number is ever re-printed.
//!   9. Automatic cache breakpoint (opt-in: `--auto-cache` / TANUKI_AUTO_CACHE=on,
//!      never with `--no-cache`; not measured against the live API, so off by
//!      default): once a session has sent two requests in a row whose earlier
//!      messages matched the previous request, and the client placed no
//!      `cache_control` on any message, one ephemeral breakpoint goes on the
//!      last block before the recency window (never a 5th: Anthropic 400s on it).
//!
//! Responses stream through untouched; usage is scraped from the stream for
//! the ~/.pxpipe/events.jsonl savings log (same format tanuki_stats reads).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import https from "node:https";
import { canonJson, tableEncode } from "./table.ts";
import { URL } from "node:url";
import { distillLog } from "./distill.ts";
import { apply as codebookApply } from "./codebook.ts";
import { lazyPointer, scanNeedles, scanCredentials, type Verbatim } from "./needles.ts";
import { resolveRate } from "./cost.ts";
import { createHash } from "node:crypto";
import { compressText } from "./ladder.ts";
import { renderText, type Font } from "./render.ts";
import { eventsPath } from "./stats.ts";
import { JSON_MIN_CHARS, charCount, isObj, minifyJson, rnd, rustTrim, textTokens } from "./serde.ts";

// Volatile prompt shapes, same patterns as distill.ts's masks (F4). Declared
// WITHOUT the g flag: .test() on a g-regex is stateful (lastIndex carries
// over), which turns "volatile" into a coin flip on alternate calls.
const M_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const M_TS =
  /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?/;
const M_JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

/** F4: classify cache break kind. Exported for unit tests. Pure append -> null (cache intact). */
export function attributeBreak(
  prev: string[],
  cur: string[],
): { index: number; kind: string } | null {
  // Pure append OR identical: previous is a (possibly complete) prefix of
  // current, so the cached prefix is intact. `>=` matters: two identical
  // consecutive requests fell through both prefix checks and came back as a
  // bogus "modified" at index len (this engine lied, the Rust one panicked).
  if (cur.length >= prev.length && prev.every((p, i) => p === cur[i])) {
    return null;
  }
  // Find first divergence
  const minLen = Math.min(prev.length, cur.length);
  let i = 0;
  while (i < minLen && prev[i] === cur[i]) i++;
  
  // Current is proper prefix of previous -> evicted
  if (i === cur.length && cur.length < prev.length) {
    return { index: i, kind: "evicted" };
  }
  
  // Classify at divergence point
  const pBlock = prev[i];
  const cBlock = cur[i];
  const pInC = cur.slice(i).includes(pBlock);
  const cInP = prev.slice(i).includes(cBlock);
  
  if (pInC && cInP) return { index: i, kind: "reordered" };
  if (pInC) return { index: i, kind: "added" };
  if (cInP) return { index: i, kind: "evicted" };
  return { index: i, kind: "modified" };
}

export interface ProxyCfg {
  port: number;
  upstream: string; // e.g. https://api.anthropic.com
  level: number; // ladder level for imaged blocks (default 0: none)
  distill: boolean; // stage 0 on imaged blocks (off: lossy for logs, opt-in)
  table: boolean; // columnar-encode whole-JSON blocks before distill (keys stated once)
  codebook: boolean;
  font: Font;
  minChars: number; // below this a block is never considered
  ratio: number; // image tokens must be <= ratio * text tokens
  minSave: number; // and save at least this many tokens
  maxPages: number; // give up on absurdly large single blocks
  recencyWindow: number; // trailing messages always kept as text (default 1)
  cache: boolean; // place a cache breakpoint on the last imaged message (default on)
  autoCache: boolean; // add one breakpoint before the recency window once the prefix holds (default off)
  verbatim: Verbatim; // sidecar next to the pages: full · lazy pointer · off
}

export const PROXY_DEFAULTS: Omit<ProxyCfg, "port" | "upstream"> = {
  level: 0,
  distill: false,
  table: false,
  codebook: false,
  font: "normal",
  minChars: 4000,
  ratio: 0.75,
  minSave: 300,
  maxPages: 20,
  recencyWindow: 1,
  cache: true,
  autoCache: false,
  verbatim: "full",
};

interface ImagedBlock {
  blocks: unknown[];
  /** the same blocks as compact JSON, exactly the bytes spliced into the request. */
  json: string[];
  /** image tokens of the pages alone (0 for a pointer): the estimator's view of them. */
  pageTok: number;
  origChars: number;
  pages: number;
  savedTokens: number;
  /** inputs for the cache-aware ledger: what the block would have cost as
   *  text and what the replacement costs, both in tokens. */
  rawTok: number;
  costTok: number;
}

/// Stage 0/0.5/1 + imaging for one text block, or null when text stays cheaper.
function maybeImage(text: string, cfg: ProxyCfg): ImagedBlock | null {
  if (text.length < cfg.minChars) return null; // cheap floor first: chars <= UTF-16 units
  if (scanCredentials(text).length > 0) return null; // rule 6: never image secrets
  const origChars = charCount(text);
  if (origChars < cfg.minChars) return null;
  let working = text;
  if (cfg.table) {
    const t = tableEncode(working);
    if (t !== null) working = t.text;
  }
  if (cfg.distill) working = distillLog(working, null, 2).distilled;
  let cbEntries = 0;
  if (cfg.codebook) {
    const cb = codebookApply(working);
    working = cb.text;
    cbEntries = cb.entries;
  }
  if (cfg.level > 0) working = compressText(working, cfg.level).compressed;

  const rawTok = textTokens(text);
  const r = renderText(working, true, true, cfg.font);
  const side = scanNeedles(working, origChars);
  // What the sidecar costs is what it ships. There is no stash on this path,
  // so a lazy pointer names no id: the caller sees the count and the tools,
  // not a fabricated sha.
  const sideTok =
    cfg.verbatim === "off" ? 0 : cfg.verbatim === "lazy" ? textTokens(lazyPointer(side, null)) : side.tokens;
  const cost = r.tokens + sideTok;
  if (r.pages.length > cfg.maxPages) return null;
  // Needle-dense: the sidecar cannot carry every exact string, and this is the
  // automatic path - leaving it as text is the only honest option.
  if (side.dense && cfg.verbatim !== "off") return null;
  if (cost > rawTok * cfg.ratio || rawTok - cost < cfg.minSave) return null;

  const marker =
    `[tanuki-context: ${origChars} chars imaged in place as ${r.pages.length} PNG page(s), ` +
    `~${cost} vs ~${rawTok} text tokens. ↵=newline →=tab ⇥N=indent` +
    (cbEntries > 0 ? `; ·legend· line maps ${cbEntries} sigils` : "") +
    (cfg.verbatim === "full" && side.needles.length > 0 ? `; the ·verbatim· block next carries ${side.needles.length} exact strings as text - read ids from there, not from the pages` : "") +
    `]`;
  // Sidecar BEFORE the pages: exact strings first, bulk second.
  const blocks: unknown[] = [{ type: "text", text: marker }];
  if (cfg.verbatim !== "off" && side.text !== "") {
    blocks.push({ type: "text", text: cfg.verbatim === "lazy" ? lazyPointer(side, null) : side.text });
  }
  for (const p of r.pages) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from(p.png.buffer, p.png.byteOffset, p.png.byteLength).toString("base64"),
      },
    });
  }
  return {
    blocks,
    json: blocks.map((b) => JSON.stringify(b)),
    pageTok: r.tokens,
    origChars,
    pages: r.pages.length,
    savedTokens: rawTok - cost,
    rawTok,
    costTok: cost,
  };
}

export interface TransformResult {
  /** the original bytes with only the changed spans substituted when `changed`,
   *  else the caller must forward the original bytes. */
  body: string;
  /** false = no block was imaged; result exists only for the diagnostics. */
  changed: boolean;
  imagedBlocks: number;
  /** tool_result texts whose JSON whitespace was dropped (rule 7). */
  minifiedBlocks: number;
  origChars: number;
  imageCount: number;
  savedTokens: number;
  /** savedTokens with the session's cache state priced in (can be negative:
   *  the first text->pages flip of a cached block is a real cost). */
  savedTokensCacheAware: number;
  /** whether a cache_control breakpoint was placed on the imaged prefix. */
  cached: boolean;
  /** whether the automatic breakpoint before the recency window was added. */
  autoCache: boolean;
  /** the estimator's input tokens for the request as FORWARDED (T2b): text via
   *  textTokens, tool definitions and tool inputs canonical, our pages at their
   *  render cost. Client-sent images and other opaque blocks count 0. */
  estTokens: number;
  /** consecutive requests whose cache break sits in a message the proxy did not
   *  touch (0 = none); the caller logs it. */
  clientBreak: number;
  /** one-shot stderr warning text, set on the request that crosses the threshold. */
  warn: string | null;
  // F4 diagnostics
  blocks: string[];
  cacheBreak: { index: number; kind: string; rebilled: number } | null;
  toolTax: { unused: string[]; tokens: number } | null;
  volatileSystem: boolean;
}

export interface ProxySession {
  /// sha256 of block texts imaged in EARLIER requests this session.
  ///
  /// Ledger-only is a decision, not an oversight. Swapping a block seen in an
  /// earlier request for a short pointer — the way an in-request repeat is
  /// swapped — looks like it would avoid re-imaging and re-caching those pages.
  /// It does the opposite. The same block sits at the same position in every
  /// later request of the conversation, so a pointer CHANGES THE PREFIX and
  /// invalidates the cache entry for everything from that block onward: the
  /// exact prefix the cache_control breakpoint exists to hold stable.
  /// Cross-request substitution does not avoid cache writes, it causes them.
  /// In-request dedupe is safe only because the pointer replaces a SECOND
  /// occurrence while the first still carries the pages. Guarded by the proxy
  /// test "session never changes the emitted bytes".
  seenBlocks: Set<string>;
  /// a prior response showed cache traffic (cache_read/cache_creation > 0).
  cachingSeen: boolean;
  /// F4: previous request's block hashes for cacheBreak analysis.
  /// Single-conversation assumption documented: multi-conversation detection
  /// would require tracking conversation IDs (Anthropic doesn't expose them),
  /// expensive semantic comparison (breaks the lightweight proxy contract), or
  /// a length-change heuristic (false positives on edits). Stated limitation:
  /// sessions spanning multiple conversations misattribute the first request of
  /// conversation N>1 as a cache break of conversation 1, inflating rebilled
  /// tokens once per conversation switch. The proxy is process-scoped and most
  /// clients spawn one per conversation, so this is rare.
  prevBlocks: string[];
  /// consecutive requests whose earlier messages matched the previous request
  /// (cache intact): the auto breakpoint waits for two.
  stable: number;
  /// consecutive requests that broke the cache at a `modified` message the proxy
  /// did not touch, and whether the one-per-session warning was already printed.
  clientBreaks: number;
  warned: boolean;
  /// block text hash -> minify verdict, bounded like seenBlocks: a block is
  /// scanned and parsed once per session, not once per request (T1b).
  minifyMemo: Map<string, MinifyMemo>;
  memoChars: number;
  /// imaging is a pure function of (block text, config), and rendering pages is
  /// the expensive step: the verdict (null = "text stays cheaper" included) is
  /// memoised per session like the minify one. Holds only immutable data.
  imageMemo: Map<string, ImagedBlock | null>;
  imageChars: number;
}

/// `min` null = "leave it alone" (not JSON, too small, or under the 10 % saving).
interface MinifyMemo {
  min: string | null;
  enc: string; // JSON.stringify(min): the bytes spliced in
  saved: number; // textTokens(original) - textTokens(min)
  minTok: number; // textTokens(min): the estimator needs it every request
}

export function newSession(): ProxySession {
  return {
    seenBlocks: new Set(),
    cachingSeen: false,
    prevBlocks: [],
    stable: 0,
    clientBreaks: 0,
    warned: false,
    minifyMemo: new Map(),
    memoChars: 0,
    imageMemo: new Map(),
    imageChars: 0,
  };
}


/// Cache-aware tokens saved by one replaced block. Rules, mirrored in the
/// Rust engine byte-for-byte:
///   no cache traffic seen  -> the raw count (nothing to discount);
///   block replayed         -> both sides ride cache reads: saved × readMult;
///   first flip of a block  -> avoided text was a cache read, the new pages
///                             are a fresh cache WRITE: read-priced saving
///                             minus write-priced cost. Usually negative —
///                             that is the point.
function cacheAwareSaved(
  rawTok: number,
  costTok: number,
  replayed: boolean,
  session: ProxySession | undefined,
  readMult: number,
  writeMult: number,
): number {
  if (session === undefined || !session.cachingSeen) return rawTok - costTok;
  if (replayed) return rnd((rawTok - costTok) * readMult);
  return rnd(rawTok * readMult) - rnd(costTok * writeMult);
}

// ---------------------------------------------------------------- splicing
/// Where one JSON value sits in the ORIGINAL request text, plus the few
/// children the rewriter addresses. Offsets are UTF-16 indices here and byte
/// offsets in the Rust engine; the spliced output is the same text either way.
interface Span {
  s: number;
  e: number;
  items?: Span[]; // array elements
  content?: Span; // member "content" (the root's "messages")
  text?: Span; // member "text"
  last: number; // end of the last member/element value, -1 when empty
}

const wsEnd = (raw: string, i: number): number => {
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
    i++;
  }
  return i;
};

/// End of the string literal opening at `i`: the closing quote is the first
/// one preceded by an even run of backslashes.
function strEnd(raw: string, i: number): number {
  let j = i + 1;
  for (;;) {
    j = raw.indexOf('"', j);
    if (j < 0) throw new Error("splice: unterminated string");
    let k = j - 1;
    while (raw.charCodeAt(k) === 0x5c) k--;
    if ((j - 1 - k) % 2 === 0) return j + 1;
    j++;
  }
}

/// End of any value starting at `i` (no allocation: system and tools go by here).
function valEnd(raw: string, i: number): number {
  const c = raw.charCodeAt(i);
  if (c === 0x22) return strEnd(raw, i);
  if (c === 0x7b || c === 0x5b) {
    let d = 0;
    for (;;) {
      if (i >= raw.length) throw new Error("splice: unterminated value");
      const x = raw.charCodeAt(i);
      if (x === 0x22) {
        i = strEnd(raw, i);
        continue;
      }
      if (x === 0x7b || x === 0x5b) d++;
      else if ((x === 0x7d || x === 0x5d) && --d === 0) return i + 1;
      i++;
    }
  }
  while (i < raw.length) {
    const x = raw.charCodeAt(i);
    if (x === 0x2c || x === 0x7d || x === 0x5d || x === 0x20 || x === 0x0a || x === 0x0d || x === 0x09) break;
    i++;
  }
  return i;
}

const keyAt = (raw: string, s: number, e: number): string => {
  const k = raw.slice(s + 1, e - 1);
  return k.includes("\\") ? (JSON.parse(raw.slice(s, e)) as string) : k;
};

/// Duplicate keys: the last one wins, exactly like JSON.parse and serde_json.
function objSpan(raw: string, s: number, root: boolean): Span {
  const sp: Span = { s, e: 0, last: -1 };
  let i = wsEnd(raw, s + 1);
  if (raw.charCodeAt(i) === 0x7d) {
    sp.e = i + 1;
    return sp;
  }
  for (;;) {
    const ke = strEnd(raw, i);
    const key = keyAt(raw, i, ke);
    i = wsEnd(raw, wsEnd(raw, ke) + 1);
    let end: number;
    if (root ? key === "messages" : key === "content") {
      sp.content = valSpan(raw, i);
      end = sp.content.e;
    } else {
      end = valEnd(raw, i);
      if (!root && key === "text") sp.text = { s: i, e: end, last: -1 };
    }
    sp.last = end;
    i = wsEnd(raw, end);
    if (raw.charCodeAt(i) === 0x2c) {
      i = wsEnd(raw, i + 1);
      continue;
    }
    sp.e = i + 1;
    return sp;
  }
}

function arrSpan(raw: string, s: number): Span {
  const sp: Span = { s, e: 0, items: [], last: -1 };
  let i = wsEnd(raw, s + 1);
  if (raw.charCodeAt(i) === 0x5d) {
    sp.e = i + 1;
    return sp;
  }
  for (;;) {
    const v = valSpan(raw, i);
    sp.items!.push(v);
    sp.last = v.e;
    i = wsEnd(raw, v.e);
    if (raw.charCodeAt(i) === 0x2c) {
      i = wsEnd(raw, i + 1);
      continue;
    }
    sp.e = i + 1;
    return sp;
  }
}

function valSpan(raw: string, i: number): Span {
  const c = raw.charCodeAt(i);
  if (c === 0x7b) return objSpan(raw, i, false);
  if (c === 0x5b) return arrSpan(raw, i);
  return { s: i, e: valEnd(raw, i), last: -1 };
}

/// One span per element of the top-level "messages" array.
function scanMessages(raw: string): Span[] {
  const at = wsEnd(raw, 0);
  if (raw.charCodeAt(at) !== 0x7b) throw new Error("splice: body is not an object");
  const items = objSpan(raw, at, true).content?.items;
  if (items === undefined) throw new Error("splice: no messages array");
  return items;
}

const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("splice: span missing for a parsed value");
  return v;
};
const kids = (sp: Span | undefined): Span[] => need(need(sp).items);

/// A replacement of raw[s, e): `parts` joined by commas, wrapped in [] when a
/// string value becomes a block array. A zero-length one is an insertion.
interface Rep {
  e: number;
  parts: string[];
  wrap: boolean;
}

const CC = '"cache_control":{"type":"ephemeral"}';
/** a generated `{...}` block gains the breakpoint as its last member. */
const withCC = (json: string): string => `${json.slice(0, -1)},${CC}}`;

function splice(raw: string, reps: Map<number, Rep>): string {
  let out = "";
  let pos = 0;
  for (const s of [...reps.keys()].sort((a, b) => a - b)) {
    if (s < pos) continue; // nested inside a replacement already made
    const r = reps.get(s)!;
    out += raw.slice(pos, s) + (r.wrap ? `[${r.parts.join(",")}]` : r.parts.join(","));
    pos = r.e;
  }
  return out + raw.slice(pos);
}

/// Anthropic accepts at most 4 `cache_control` breakpoints per request and
/// 400s on a 5th, so count the ones the client already placed (system, tools,
/// message blocks and the text blocks inside a tool_result) before adding
/// ours. Fail-open: a request that worked without the proxy must still work
/// through it.
const MAX_BREAKPOINTS = 4;

/// `cache_control` members in a block array, a tool_result's own content included.
function scanBreakpoints(arr: unknown): number {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const b of arr) {
    if (!isObj(b)) continue;
    if (b.cache_control !== undefined) n++;
    if (b.type === "tool_result") n += scanBreakpoints(b.content);
  }
  return n;
}

function countBreakpoints(body: Record<string, unknown>): number {
  let n = scanBreakpoints(body.system) + scanBreakpoints(body.tools);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (isObj(m)) n += scanBreakpoints(m.content);
  }
  return n;
}

/// Cheap upper bound before the JSON.parse in minifyJson: one pass counting the
/// whitespace outside strings (plus what trim would take off the ends) and
/// skipping a document that cannot reach the 10 % saving - already-compact JSON
/// is the common case and costs a full parse to learn nothing. Conservative on
/// purpose (never skips what minifyJson would rewrite); the real decision stays
/// minifyJson's. Mirrored in proxy.rs.
function couldMinify(text: string): boolean {
  let inStr = false;
  let esc = false;
  let ws = 0;
  let low = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) low++;
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) ws++;
  }
  const removed = ws + (text.length - rustTrim(text).length);
  return removed * 10 >= text.length - low;
}

/// The estimator's input tokens for a request body (T2b), see TransformResult.
function estimateTokens(body: Record<string, unknown>, preTok: Map<object, number>): number {
  let n = 0;
  const txt = (v: unknown): void => {
    if (typeof v === "string") n += textTokens(v);
  };
  if (typeof body.system === "string") txt(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) if (isObj(b)) txt(b.text);
  if (Array.isArray(body.tools)) for (const t of body.tools) n += textTokens(canonJson(t));
  for (const m of body.messages as unknown[]) {
    if (!isObj(m)) continue;
    if (typeof m.content === "string") {
      txt(m.content);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObj(b)) continue;
      if (b.type === "text") txt(b.text);
      else if (b.type === "thinking") txt(b.thinking);
      else if (b.type === "tool_use") {
        txt(b.name);
        if (b.input !== undefined) n += textTokens(canonJson(b.input));
      } else if (b.type === "tool_result") {
        if (typeof b.content === "string") n += preTok.get(b) ?? textTokens(b.content);
        else if (Array.isArray(b.content)) {
          for (const it of b.content) {
            if (!isObj(it) || it.type !== "text") continue;
            const known = preTok.get(it);
            if (known !== undefined) n += known;
            else txt(it.text);
          }
        }
      }
    }
  }
  return n;
}

/// Rewrite a /v1/messages body. Returns null when the body is not a messages
/// request - or when anything in the scan/splice fails (a body nested past the
/// stack, a span that does not match the parsed tree): the caller forwards the
/// original bytes untouched, and this never throws whatever the body.
export function transformRequestBody(
  raw: string,
  cfg: ProxyCfg,
  session?: ProxySession,
): TransformResult | null {
  try {
    return rewriteBody(raw, cfg, session);
  } catch {
    return null;
  }
}

function rewriteBody(raw: string, cfg: ProxyCfg, session: ProxySession | undefined): TransformResult | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(body) || !Array.isArray(body.messages)) return null;
  const msgs: unknown[] = body.messages;
  // Spans of the values the rewrite may replace, in the ORIGINAL bytes. The
  // parsed tree below is still edited in step (diagnostics hash what the API
  // will see), but it is never printed: the output is `raw` with `reps` applied.
  const spans = scanMessages(raw);
  if (spans.length !== msgs.length) throw new Error("splice: span/message count mismatch");
  const reps = new Map<number, Rep>();
  const put = (sp: Span, parts: string[], wrap = false): void => {
    reps.set(sp.s, { e: sp.e, parts: [...parts], wrap }); // a copy: the breakpoint edits it
  };
  const touched = new Set<number>(); // messages the proxy rewrote (T8b)
  const preTok = new Map<object, number>(); // minified tool_result texts: tokens already known
  const clientCC = msgs.some((m) => isObj(m) && scanBreakpoints(m.content) > 0); // the client caches on its own

  let imagedBlocks = 0;
  let origChars = 0;
  let imageCount = 0;
  let pageTok = 0;
  let savedTokens = 0;
  let savedTokensCacheAware = 0;
  // index of the last message we imaged into; where the cache breakpoint goes
  let lastImagedMsg = -1;
  // provider ratios for the cache-aware ledger, from the request's own model
  const rate = resolveRate(typeof body.model === "string" ? body.model : null).rate;

  // ponytail rung 2, applied to the wire: a byte-identical repeat of a block
  // we already imaged in THIS request (agents re-read files constantly) gets
  // a one-line pointer instead of the same pages again. Exact repeats only;
  // near-dupes still image independently. Deliberately in-request only — see
  // the ProxySession comment for why the cross-request version is a cache
  // pessimisation, not an optimisation.
  const seen = new Map<string, number>(); // exact block text -> page count

  const cfgKey = [cfg.level, cfg.distill, cfg.table, cfg.codebook, cfg.font, cfg.minChars, cfg.ratio, cfg.minSave, cfg.maxPages, cfg.verbatim].join("|");
  const memoImage = (text: string): ImagedBlock | null => {
    if (session === undefined || text.length < cfg.minChars) return maybeImage(text, cfg);
    const key = createHash("sha256").update(`${cfgKey}\x00${text}`, "utf8").digest("hex");
    const hit = session.imageMemo.get(key);
    if (hit !== undefined) return hit;
    const done = maybeImage(text, cfg);
    // ponytail: bounded like the minify memo; a full one restarts empty
    if (session.imageMemo.size >= 512 || session.imageChars > 64_000_000) {
      session.imageMemo.clear();
      session.imageChars = 0;
    }
    session.imageMemo.set(key, done);
    session.imageChars += done === null ? 0 : done.json.reduce((n, j) => n + j.length, 0);
    return done;
  };
  const imageBlock = (text: string): ImagedBlock | null => {
    const priorPages = seen.get(text);
    let done: ImagedBlock | null;
    if (priorPages !== undefined) {
      const chars = charCount(text);
      const marker =
        `[tanuki-context: ${chars} chars, byte-identical to a block imaged above ` +
        `(${priorPages} PNG page(s)); not repeated]`;
      const rawTok = textTokens(text);
      const costTok = textTokens(marker);
      const blocks = [{ type: "text", text: marker }];
      done = {
        blocks,
        json: blocks.map((b) => JSON.stringify(b)),
        pageTok: 0,
        origChars: chars,
        pages: 0,
        savedTokens: rawTok - costTok,
        rawTok,
        costTok,
      };
    } else {
      done = memoImage(text);
      if (done) seen.set(text, done.pages);
    }
    if (done) {
      imagedBlocks++;
      origChars += done.origChars;
      imageCount += done.pages;
      pageTok += done.pageTok;
      savedTokens += done.savedTokens;
      // ledger only, never bytes: was this exact block imaged in an earlier
      // request of this session?
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      const replayed = session !== undefined && session.seenBlocks.has(hash);
      savedTokensCacheAware += cacheAwareSaved(
        done.rawTok,
        done.costTok,
        replayed,
        session,
        rate.cacheReadMult,
        rate.cacheWriteMult,
      );
      if (session !== undefined && !replayed) {
        // ponytail: bounded memory — at 1024 entries start a fresh window;
        // old blocks then re-count as first flips, which only UNDERSTATES
        // savings. Mirrored exactly in the Rust engine.
        if (session.seenBlocks.size >= 1024) session.seenBlocks.clear();
        session.seenBlocks.add(hash);
      }
    }
    return done;
  };

  // rule 7: lossless JSON minify of tool results, everywhere, before imaging.
  // Ledger: the block was never sent pretty, so there is no flip - with cache
  // traffic seen, the saving rides a cache write the first time and reads after.
  // T1b: the verdict (and its saving and its wire bytes) is memoised per session
  // by block hash, so a history that grows by two messages a turn pays for the
  // two new blocks, not for all of them again.
  let minifiedBlocks = 0;
  const minifyOff = process.env.TANUKI_MINIFY === "off";
  const minify = (text: string): { min: string; enc: string; tok: number } | null => {
    // O(1) rejects first: below the size floor, or not an object/array once trimmed.
    if (minifyOff || text.length < JSON_MIN_CHARS) return null;
    const head = rustTrim(text)[0];
    if (head !== "{" && head !== "[") return null;
    const hash = createHash("sha256").update(`json\x00${text}`, "utf8").digest("hex");
    let memo = session?.minifyMemo.get(hash);
    if (memo === undefined) {
      const m = couldMinify(text) ? minifyJson(text) : null;
      const minTok = m === null ? 0 : textTokens(m);
      memo = m === null ? { min: null, enc: "", saved: 0, minTok } : { min: m, enc: JSON.stringify(m), saved: textTokens(text) - minTok, minTok };
      if (session !== undefined) {
        // ponytail: bounded like seenBlocks; a full memo restarts empty (pure
        // cache, never changes the bytes), 32M chars caps the memory.
        if (session.minifyMemo.size >= 1024 || session.memoChars > 32_000_000) {
          session.minifyMemo.clear();
          session.memoChars = 0;
        }
        session.minifyMemo.set(hash, memo);
        session.memoChars += text.length;
      }
    }
    if (memo.min === null) return null;
    minifiedBlocks++;
    savedTokens += memo.saved;
    const replayed = session !== undefined && session.seenBlocks.has(hash);
    savedTokensCacheAware +=
      session === undefined || !session.cachingSeen ? memo.saved : rnd(memo.saved * (replayed ? rate.cacheReadMult : rate.cacheWriteMult));
    if (session !== undefined && !replayed) {
      if (session.seenBlocks.size >= 1024) session.seenBlocks.clear();
      session.seenBlocks.add(hash);
    }
    return { min: memo.min, enc: memo.enc, tok: memo.minTok };
  };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    const bspans = kids(spans[i].content);
    for (let j = 0; j < m.content.length; j++) {
      const block = m.content[j];
      if (!isObj(block) || block.type !== "tool_result") continue;
      const bs = bspans[j];
      if (typeof block.content === "string") {
        const r = minify(block.content);
        if (r !== null) {
          block.content = r.min;
          preTok.set(block, r.tok);
          put(need(bs.content), [r.enc]);
          touched.add(i);
        }
      } else if (Array.isArray(block.content)) {
        const ispans = kids(bs.content);
        for (let k = 0; k < block.content.length; k++) {
          const item = block.content[k];
          if (isObj(item) && item.type === "text" && typeof item.text === "string") {
            const r = minify(item.text);
            if (r !== null) {
              item.text = r.min;
              preTok.set(item, r.tok);
              put(need(ispans[k].text), [r.enc]);
              touched.add(i);
            }
          }
        }
      }
    }
  }

  // rule 3: keep the latest recencyWindow message(s) as text (VIST slow-fast:
  // recent turns reasoned over precisely, distant bulk imaged). Default 1.
  const keep = Math.max(1, cfg.recencyWindow);
  for (let i = 0; i < msgs.length - keep; i++) {
    const m = msgs[i];
    // Anthropic accepts image blocks only in user-role content.
    if (!isObj(m) || m.role !== "user") continue;

    if (typeof m.content === "string") {
      const done = imageBlock(m.content);
      if (done) {
        m.content = done.blocks;
        put(need(spans[i].content), done.json, true);
        touched.add(i);
        lastImagedMsg = i;
      }
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const before = imagedBlocks;
    const bspans = kids(spans[i].content);

    const out: unknown[] = [];
    for (let j = 0; j < m.content.length; j++) {
      const block = m.content[j];
      if (!isObj(block) || block.cache_control !== undefined) {
        out.push(block); // rule 4
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const done = imageBlock(block.text);
        if (done) {
          out.push(...done.blocks);
          put(bspans[j], done.json);
        } else out.push(block);
        continue;
      }
      if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          const done = imageBlock(block.content);
          if (done) {
            block.content = done.blocks;
            put(need(bspans[j].content), done.json, true);
          }
        } else if (Array.isArray(block.content)) {
          const ispans = kids(bspans[j].content);
          const inner: unknown[] = [];
          for (let k = 0; k < block.content.length; k++) {
            const item = block.content[k];
            if (
              isObj(item) &&
              item.type === "text" &&
              typeof item.text === "string" &&
              item.cache_control === undefined
            ) {
              const done = imageBlock(item.text);
              if (done) {
                inner.push(...done.blocks);
                put(ispans[k], done.json);
                continue;
              }
            }
            inner.push(item);
          }
          block.content = inner;
        }
      }
      out.push(block);
    }
    m.content = out;
    if (imagedBlocks > before) {
      lastImagedMsg = i;
      touched.add(i);
    }
  }

  // F4 diagnostics run on EVERY parseable request, transform or not: a cache
  // break is most often caused by a request the proxy left alone. Hashes are
  // taken AFTER imaging (these are the bytes the API cache sees) but BEFORE
  // our own cache_control placement below - the breakpoint moves forward as
  // later content gets imaged, and hashing it would forge a false "modified"
  // attribution at the old holder on every advance.

  // F4 diagnostics: collect block hashes for all content blocks
  const blocks: string[] = [];
  const flatMsg: number[] = []; // message index of every hashed block (T8b)
  const flatType: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!isObj(m)) continue;
    const role = typeof m.role === "string" ? m.role : "";
    const content = m.content;

    // Handle string content
    if (typeof content === "string") {
      const hash = createHash("sha256")
        .update(`${role}\x00`)
        .update(canonJson(content), "utf8")
        .digest("hex")
        .slice(0, 12);
      blocks.push(hash);
      flatMsg.push(i);
      flatType.push("text");
      continue;
    }

    // Handle array content
    if (Array.isArray(content)) {
      for (const block of content) {
        const hash = createHash("sha256")
          .update(`${role}\x00`)
          .update(canonJson(block), "utf8")
          .digest("hex")
          .slice(0, 12);
        blocks.push(hash);
        flatMsg.push(i);
        flatType.push(isObj(block) && typeof block.type === "string" ? block.type : "block");
      }
    }
  }

  // F4: cacheBreak analysis vs previous request
  let cacheBreak: { index: number; kind: string; rebilled: number } | null = null;
  let clientBreak = 0;
  let warn: string | null = null;
  if (session !== undefined && session.prevBlocks.length > 0) {
    const brk = attributeBreak(session.prevBlocks, blocks);
    if (brk !== null) {
      // Calculate rebilled tokens from text blocks starting at break index
      let rebilled = 0;
      let blockIdx = 0;
      for (const m of msgs) {
        if (!isObj(m)) continue;
        const content = m.content;

        if (typeof content === "string") {
          if (blockIdx >= brk.index) {
            rebilled += textTokens(content);
          }
          blockIdx++;
          continue;
        }

        if (Array.isArray(content)) {
          for (const block of content) {
            if (blockIdx >= brk.index && isObj(block) && block.type === "text" && typeof block.text === "string") {
              rebilled += textTokens(block.text);
            }
            blockIdx++;
          }
        }
      }
      cacheBreak = { index: brk.index, kind: brk.kind, rebilled };
    }
    // T8a/T8b streaks. `stable` counts requests whose earlier messages matched
    // the previous request; a `modified` break inside a message we did not
    // rewrite is the client's own doing (a proxy-made one, e.g. the recency
    // window advancing over a block, sits in a touched message).
    if (brk === null) {
      session.stable++;
      session.clientBreaks = 0;
    } else {
      session.stable = 0;
      session.clientBreaks =
        brk.kind === "modified" && !touched.has(flatMsg[brk.index]) ? session.clientBreaks + 1 : 0;
      if (session.clientBreaks >= 3 && !session.warned) {
        session.warned = true;
        warn =
          `warning: your client rewrites message ${flatMsg[brk.index]} (block ${brk.index}, ${flatType[brk.index]}) ` +
          `every turn - the cache never holds`;
      }
    }
    clientBreak = session.clientBreaks;
  }

  // F4: toolTax - only when tools advertised AND at least one tool_use exists
  let toolTax: { unused: string[]; tokens: number } | null = null;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Check if any tool_use blocks exist
    let hasToolUse = false;
    for (const m of msgs) {
      if (!isObj(m) || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (isObj(block) && block.type === "tool_use") {
          hasToolUse = true;
          break;
        }
      }
      if (hasToolUse) break;
    }

    if (hasToolUse) {
      // Collect advertised tool names
      const advertised = new Set<string>();
      for (const t of body.tools) {
        if (isObj(t) && typeof t.name === "string") {
          advertised.add(t.name);
        }
      }

      // Collect used tool names
      const used = new Set<string>();
      for (const m of msgs) {
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if (isObj(block) && block.type === "tool_use" && typeof block.name === "string") {
            used.add(block.name);
          }
        }
      }

      // Calculate unused
      const unused: string[] = [];
      for (const name of advertised) {
        if (!used.has(name)) unused.push(name);
      }

      if (unused.length > 0) {
        unused.sort();
        const first8 = unused.slice(0, 8);
        let tokens = 0;
        for (const t of body.tools) {
          if (isObj(t) && typeof t.name === "string" && unused.includes(t.name)) {
            tokens += textTokens(canonJson(t));
          }
        }
        toolTax = { unused: first8, tokens };
      }
    }
  }

  // F4: volatileSystem - scan system prompt for uuid/timestamp/jwt
  let volatileSystem = false;
  const systemText = Array.isArray(body.system)
    ? body.system.map(b => isObj(b) && typeof b.text === "string" ? b.text : "").join("")
    : typeof body.system === "string" ? body.system : "";
  if (systemText.length > 0 && (M_UUID.test(systemText) || M_TS.test(systemText) || M_JWT.test(systemText))) {
    volatileSystem = true;
  }

  // Update session prevBlocks for next request
  if (session !== undefined) {
    session.prevBlocks = blocks;
  }

  const estTokens = estimateTokens(body, preTok) + pageTok;

  // Breakpoint on message `idx`: the last block of its content. The bytes go in
  // as a splice: onto a generated block's JSON, or as one more member of the
  // client's own block. The tree is not touched (generated blocks are shared
  // with the image memo); `placed` counts what we added.
  const placed = new Set<number>(); // messages we put a breakpoint on: the tree is never edited
  const place = (idx: number, auto: boolean): boolean => {
    const m = msgs[idx];
    if (!isObj(m)) return false;
    const cs = need(spans[idx].content);
    if (typeof m.content === "string") {
      // only the automatic breakpoint reaches a plain string: the same literal
      // becomes the one text block that can carry it
      if (!auto || m.content === "") return false;
      put(cs, [`{"type":"text","text":${raw.slice(cs.s, cs.e)},${CC}}`], true);
      placed.add(idx);
      return true;
    }
    if (!Array.isArray(m.content) || m.content.length === 0) return false;
    const tail = m.content[m.content.length - 1];
    if (!isObj(tail) || tail.cache_control !== undefined || placed.has(idx)) return false;
    // thinking blocks and empty text cannot carry one; Anthropic 400s on it
    if (auto && (tail.type === "thinking" || tail.type === "redacted_thinking" || (tail.type === "text" && tail.text === ""))) return false;
    if (cs.items === undefined) {
      // a string imaged into an array: the breakpoint rides its last block
      const r = need(reps.get(cs.s));
      r.parts[r.parts.length - 1] = withCC(r.parts[r.parts.length - 1]);
    } else {
      const orig = cs.items[cs.items.length - 1];
      const r = reps.get(orig.s);
      if (r !== undefined && r.e === orig.e) r.parts[r.parts.length - 1] = withCC(r.parts[r.parts.length - 1]);
      else if (orig.last < 0) reps.set(orig.s + 1, { e: orig.s + 1, parts: [CC], wrap: false });
      else reps.set(orig.last, { e: orig.last, parts: [`,${CC}`], wrap: false });
    }
    placed.add(idx);
    return true;
  };

  // Imaged pages are the ideal cache payload: large, byte-stable (asserted in
  // the render tests) and re-sent verbatim on every later turn. The proxy has
  // always PRICED caching (cacheAwareSaved) but never CREATED it. Measured at
  // Sonnet rates on a 7530-token page set, re-sending it costs $0.226 over 10
  // turns uncached vs $0.0486 cached - 4.7x, 3.0x over 5 turns, 2.1x over 3.
  // The breakpoint goes on the last block of the last message we imaged: it is
  // before the recency window, so everything it covers is settled history.
  // ponytail: no minimum-prefix check - Anthropic silently declines to cache a
  // prefix under the model's floor rather than erroring, so a size test would
  // only duplicate a rule the API already enforces.
  let cached = false;
  if (cfg.cache && lastImagedMsg >= 0 && countBreakpoints(body) + placed.size < MAX_BREAKPOINTS) {
    cached = place(lastImagedMsg, false);
  }
  // T8a: a client that never caches pays full price for its whole history every
  // turn. After two requests in a row whose earlier messages matched the last
  // one (so the prefix demonstrably holds) one breakpoint on the last block
  // before the recency window makes that history a cache read. Never when the
  // client caches itself, never a 5th breakpoint.
  let autoCache = false;
  if (
    // opt-in (--auto-cache, or TANUKI_AUTO_CACHE=on) and never with --no-cache (cfg.cache off)
    cfg.cache &&
    (cfg.autoCache || process.env.TANUKI_AUTO_CACHE === "on") &&
    session !== undefined &&
    session.stable >= 2 &&
    !clientCC &&
    msgs.length - keep >= 1 &&
    countBreakpoints(body) + placed.size < MAX_BREAKPOINTS
  ) {
    autoCache = place(msgs.length - keep - 1, true);
  }

  const changed = reps.size > 0;
  return {
    body: changed ? splice(raw, reps) : raw,
    changed,
    imagedBlocks,
    minifiedBlocks,
    origChars,
    imageCount,
    savedTokens,
    savedTokensCacheAware,
    cached,
    autoCache,
    estTokens,
    clientBreak,
    warn,
    blocks,
    cacheBreak,
    toolTax,
    volatileSystem,
  };
}

/// Best-effort usage scrape: works on both plain JSON responses and SSE
/// streams (message_start carries the same usage keys). First match wins for
/// input/cache figures; output_tokens takes the MAX across matches because
/// SSE emits a placeholder in message_start and the final count in
/// message_delta. Output is not a savings input — it is logged so stats can
/// report the share of the bill no input-side tool can touch.
function scrapeUsage(text: string): {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
} {
  const grab = (re: RegExp): number => {
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
  };
  let output = 0;
  for (const m of text.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) {
    output = Math.max(output, Number(m[1]));
  }
  return {
    input: grab(/"input_tokens"\s*:\s*(\d+)/),
    cacheRead: grab(/"cache_read_input_tokens"\s*:\s*(\d+)/),
    cacheCreate: grab(/"cache_creation_input_tokens"\s*:\s*(\d+)/),
    output,
  };
}

function logEvent(row: object): void {
  try {
    const p = eventsPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(row) + "\n");
  } catch {
    // stats are best-effort; never fail a request over them
  }
}

export function startProxy(cfg: ProxyCfg): http.Server {
  const upstream = new URL(cfg.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  // one ledger session per proxy process: replay detection + cache evidence
  const session = newSession();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let bodyBuf: Buffer = Buffer.concat(chunks);
      const isMessages =
        req.method === "POST" &&
        (req.url ?? "").startsWith("/v1/messages") &&
        !(req.url ?? "").includes("count_tokens") &&
        req.headers["content-encoding"] === undefined;

      let stats: TransformResult | null = null;
      if (isMessages) {
        // Fail open. A compression proxy sits in the request path, so it must
        // never break the request it is optimizing: any error here forwards
        // the original bytes untouched. This callback is async, so an escaping
        // throw would not just drop one request - it would be an uncaught
        // exception and take the whole proxy down with every in-flight call.
        try {
          stats = transformRequestBody(bodyBuf.toString("utf8"), cfg, session);
          if (stats !== null && stats.changed) bodyBuf = Buffer.from(stats.body, "utf8");
        } catch {
          stats = null; // bodyBuf is untouched unless the transform succeeded
        }
      }

      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      headers["content-length"] = String(bodyBuf.length);
      if (isMessages) delete headers["accept-encoding"]; // keep usage scrapable

      const up = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          path: req.url,
          method: req.method,
          headers,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          if (isMessages) {
            // tee the stream: bytes go to the client untouched, a copy feeds
            // the usage scrape for the savings log.
            const tee: Buffer[] = [];
            ur.on("data", (c: Buffer) => {
              tee.push(c);
              res.write(c);
            });
            ur.on("end", () => {
              res.end();
              const usage = scrapeUsage(Buffer.concat(tee).toString("utf8"));
              const actual = usage.input + usage.cacheRead + usage.cacheCreate;
              if (usage.cacheRead > 0 || usage.cacheCreate > 0) session.cachingSeen = true;
              logEvent({
                ts: Date.now(),
                tool: "proxy",
                orig_chars: stats?.origChars ?? 0,
                image_count: stats?.imageCount ?? 0,
                compressed: stats !== null && stats.changed,
                minified_blocks: stats?.minifiedBlocks ?? 0,
                // what the imaged blocks would have added as text (estimate).
                baseline_tokens: actual + (stats?.savedTokens ?? 0),
                // the same estimate with the session's observed cache state
                // priced in (replays at the cache-read rate, first flips
                // charged the cache-write premium). Can be negative.
                saved_tokens_cache_aware: stats?.savedTokensCacheAware ?? 0,
                caching_seen: session.cachingSeen,
                // whether WE placed the breakpoint (as opposed to the client
                // already caching): separates our win from theirs in the ledger
                cache_breakpoint: stats?.cached ?? false,
                // the automatic breakpoint before the recency window (T8a)
                auto_cache: stats?.autoCache ?? false,
                // T2b: what the estimator predicted for the forwarded request
                // next to what Anthropic billed (input + cache reads + creates)
                est_input_tokens: stats?.estTokens ?? 0,
                billed_input_tokens: actual,
                input_tokens: usage.input,
                cache_read_tokens: usage.cacheRead,
                cache_create_tokens: usage.cacheCreate,
                output_tokens: usage.output,
                // F4 diagnostics
                blocks: stats?.blocks ?? [],
                ...(stats?.cacheBreak && { cacheBreak: stats.cacheBreak }),
                ...(stats && stats.clientBreak > 0 && { client_break: stats.clientBreak }),
                ...(stats?.toolTax && { toolTax: stats.toolTax }),
                ...(stats?.volatileSystem && { volatileSystem: stats.volatileSystem }),
              });
              // F4: per-request diagnostic stdout
              if (stats?.warn) process.stderr.write(`[tanuki proxy] ${stats.warn}\n`);
              if (stats !== null) {
                let diagLine = "";
                if (stats.cacheBreak) {
                  diagLine += ` · break@${stats.cacheBreak.index} ${stats.cacheBreak.kind}`;
                }
                if (stats.toolTax) {
                  diagLine += ` · toolTax ${stats.toolTax.tokens}tok`;
                }
                if (diagLine.length > 0) {
                  process.stderr.write(`[tanuki proxy]${diagLine}\n`);
                }
              }
            });
          } else {
            ur.pipe(res);
          }
        },
      );
      up.on("error", (e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `tanuki proxy: upstream unreachable (${e.message})` } }));
      });
      up.end(bodyBuf);
    });
  });

  server.listen(cfg.port, "127.0.0.1", () => {
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : cfg.port;
    const knobs =
      `level=${cfg.level} distill=${cfg.distill} codebook=${cfg.codebook} font=${cfg.font} ` +
      `recency=${cfg.recencyWindow} minChars=${cfg.minChars} ratio=${cfg.ratio} minSave=${cfg.minSave}`;
    process.stderr.write(
      `tanuki-context proxy on http://127.0.0.1:${port} -> ${cfg.upstream}\n` +
        `  ${knobs}\n` +
        `  rules: system prompt & tools untouched · edits spliced into your own request bytes (nothing else moves) · in-place blocks only · last ${Math.max(1, cfg.recencyWindow)} message(s) kept as text · secrets never imaged · cache_control blocks never imaged · identical blocks imaged once${cfg.cache ? " · imaged prefix marked cacheable" : ""}${cfg.cache && (cfg.autoCache || process.env.TANUKI_AUTO_CACHE === "on") ? " · auto cache breakpoint once the prefix holds" : ""} · pretty JSON tool results minified (lossless)\n` +
        `  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n`,
    );
  });
  return server;
}
