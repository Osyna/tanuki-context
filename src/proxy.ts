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
//!   4. Blocks carrying cache_control are never touched (rewriting would
//!      defeat the cache they exist for).
//!   5. Imaging only happens when `estimate` says it wins by a clear margin;
//!      everything else passes through byte-for-byte.
//!   6. A block carrying a credential-shaped secret (API keys, private-key
//!      blocks, tokens) is never imaged: a secret must not be silently
//!      misread from pixels, so it stays text (needles.ts `scanCredentials`).
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
import { charCount, isObj, rnd, textTokens } from "./serde.ts";

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
  verbatim: "full",
};

interface ImagedBlock {
  blocks: unknown[];
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
    origChars,
    pages: r.pages.length,
    savedTokens: rawTok - cost,
    rawTok,
    costTok: cost,
  };
}

export interface TransformResult {
  /** rewritten body when `changed`, else the caller must forward the original bytes. */
  body: string;
  /** false = no block was imaged; result exists only for the diagnostics. */
  changed: boolean;
  imagedBlocks: number;
  origChars: number;
  imageCount: number;
  savedTokens: number;
  /** savedTokens with the session's cache state priced in (can be negative:
   *  the first text->pages flip of a cached block is a real cost). */
  savedTokensCacheAware: number;
  /** whether a cache_control breakpoint was placed on the imaged prefix. */
  cached: boolean;
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
}

export function newSession(): ProxySession {
  return { seenBlocks: new Set(), cachingSeen: false, prevBlocks: [] };
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

/// Anthropic accepts at most 4 `cache_control` breakpoints per request and
/// 400s on a 5th, so count the ones the client already placed (system, tools
/// and message blocks) before adding ours. Fail-open: a request that worked
/// without the proxy must still work through it.
const MAX_BREAKPOINTS = 4;
function countBreakpoints(body: Record<string, unknown>): number {
  let n = 0;
  const scan = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const b of arr) if (isObj(b) && b.cache_control !== undefined) n++;
  };
  scan(body.system);
  scan(body.tools);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (isObj(m)) scan(m.content);
  }
  return n;
}

/// Rewrite a /v1/messages body. Returns null when nothing changed (caller
/// forwards the original bytes untouched).
export function transformRequestBody(
  raw: string,
  cfg: ProxyCfg,
  session?: ProxySession,
): TransformResult | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(body) || !Array.isArray(body.messages)) return null;

  let imagedBlocks = 0;
  let origChars = 0;
  let imageCount = 0;
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
      done = {
        blocks: [{ type: "text", text: marker }],
        origChars: chars,
        pages: 0,
        savedTokens: rawTok - costTok,
        rawTok,
        costTok,
      };
    } else {
      done = maybeImage(text, cfg);
      if (done) seen.set(text, done.pages);
    }
    if (done) {
      imagedBlocks++;
      origChars += done.origChars;
      imageCount += done.pages;
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

  // rule 3: keep the latest recencyWindow message(s) as text (VIST slow-fast:
  // recent turns reasoned over precisely, distant bulk imaged). Default 1.
  const keep = Math.max(1, cfg.recencyWindow);
  for (let i = 0; i < body.messages.length - keep; i++) {
    const m = body.messages[i];
    // Anthropic accepts image blocks only in user-role content.
    if (!isObj(m) || m.role !== "user") continue;

    if (typeof m.content === "string") {
      const done = imageBlock(m.content);
      if (done) {
        m.content = done.blocks;
        lastImagedMsg = i;
      }
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const before = imagedBlocks;

    const out: unknown[] = [];
    for (const block of m.content) {
      if (!isObj(block) || block.cache_control !== undefined) {
        out.push(block); // rule 4
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const done = imageBlock(block.text);
        if (done) out.push(...done.blocks);
        else out.push(block);
        continue;
      }
      if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          const done = imageBlock(block.content);
          if (done) block.content = done.blocks;
        } else if (Array.isArray(block.content)) {
          const inner: unknown[] = [];
          for (const item of block.content) {
            if (
              isObj(item) &&
              item.type === "text" &&
              typeof item.text === "string" &&
              item.cache_control === undefined
            ) {
              const done = imageBlock(item.text);
              if (done) {
                inner.push(...done.blocks);
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
    if (imagedBlocks > before) lastImagedMsg = i;
  }

  // F4 diagnostics run on EVERY parseable request, transform or not: a cache
  // break is most often caused by a request the proxy left alone. Hashes are
  // taken AFTER imaging (these are the bytes the API cache sees) but BEFORE
  // our own cache_control placement below - the breakpoint moves forward as
  // later content gets imaged, and hashing it would forge a false "modified"
  // attribution at the old holder on every advance.

  // F4 diagnostics: collect block hashes for all content blocks
  const blocks: string[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isObj(m)) continue;
      const role = typeof m.role === "string" ? m.role : "";
      const content = m.content;
      
      // Handle string content
      if (typeof content === "string") {
        const hash = createHash("sha256")
          .update(`${role}\x00${canonJson(content)}`, "utf8")
          .digest("hex")
          .slice(0, 12);
        blocks.push(hash);
        continue;
      }
      
      // Handle array content
      if (Array.isArray(content)) {
        for (const block of content) {
          const hash = createHash("sha256")
            .update(`${role}\x00${canonJson(block)}`, "utf8")
            .digest("hex")
            .slice(0, 12);
          blocks.push(hash);
        }
      }
    }
  }
  
  // F4: cacheBreak analysis vs previous request
  let cacheBreak: { index: number; kind: string; rebilled: number } | null = null;
  if (session !== undefined && session.prevBlocks.length > 0) {
    const brk = attributeBreak(session.prevBlocks, blocks);
    if (brk !== null) {
      // Calculate rebilled tokens from text blocks starting at break index
      let rebilled = 0;
      let blockIdx = 0;
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
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
      }
      cacheBreak = { index: brk.index, kind: brk.kind, rebilled };
    }
  }
  
  // F4: toolTax - only when tools advertised AND at least one tool_use exists
  let toolTax: { unused: string[]; tokens: number } | null = null;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Check if any tool_use blocks exist
    let hasToolUse = false;
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if (isObj(block) && block.type === "tool_use") {
            hasToolUse = true;
            break;
          }
        }
        if (hasToolUse) break;
      }
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
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (!isObj(m) || !Array.isArray(m.content)) continue;
          for (const block of m.content) {
            if (isObj(block) && block.type === "tool_use" && typeof block.name === "string") {
              used.add(block.name);
            }
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

  if (imagedBlocks === 0) {
    // Nothing imaged: the caller forwards the ORIGINAL bytes; this result
    // exists only to carry the diagnostics into the event log.
    return { body: raw, changed: false, imagedBlocks, origChars, imageCount, savedTokens, savedTokensCacheAware, cached: false, blocks, cacheBreak, toolTax, volatileSystem };
  }

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
  if (cfg.cache && lastImagedMsg >= 0 && countBreakpoints(body) < MAX_BREAKPOINTS) {
    const m = body.messages[lastImagedMsg];
    if (isObj(m) && Array.isArray(m.content) && m.content.length > 0) {
      const tail = m.content[m.content.length - 1];
      if (isObj(tail) && tail.cache_control === undefined) {
        tail.cache_control = { type: "ephemeral" };
        cached = true;
      }
    }
  }

  return { body: JSON.stringify(body), changed: true, imagedBlocks, origChars, imageCount, savedTokens, savedTokensCacheAware, cached, blocks, cacheBreak, toolTax, volatileSystem };
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
                input_tokens: usage.input,
                cache_read_tokens: usage.cacheRead,
                cache_create_tokens: usage.cacheCreate,
                output_tokens: usage.output,
                // F4 diagnostics
                blocks: stats?.blocks ?? [],
                ...(stats?.cacheBreak && { cacheBreak: stats.cacheBreak }),
                ...(stats?.toolTax && { toolTax: stats.toolTax }),
                ...(stats?.volatileSystem && { volatileSystem: stats.volatileSystem }),
              });
              // F4: per-request diagnostic stdout
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
        `  rules: system prompt & tools untouched · in-place blocks only · last ${Math.max(1, cfg.recencyWindow)} message(s) kept as text · secrets never imaged · cache_control skipped · identical blocks imaged once${cfg.cache ? " · imaged prefix marked cacheable" : ""}\n` +
        `  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n`,
    );
  });
  return server;
}
