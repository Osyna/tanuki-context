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
import { tableEncode } from "./table.ts";
import { URL } from "node:url";
import { distillLog } from "./distill.ts";
import { apply as codebookApply } from "./codebook.ts";
import { scanNeedles, scanCredentials } from "./needles.ts";
import { resolveRate } from "./cost.ts";
import { createHash } from "node:crypto";
import { compressText } from "./ladder.ts";
import { renderText, type Font } from "./render.ts";
import { eventsPath } from "./stats.ts";
import { charCount, isObj, rnd, textTokens } from "./serde.ts";

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

  const rawTok = textTokens(origChars);
  const r = renderText(working, true, true, cfg.font);
  const side = scanNeedles(working, origChars);
  const cost = r.tokens + side.tokens;
  if (r.pages.length > cfg.maxPages) return null;
  // Needle-dense: the sidecar cannot carry every exact string, and this is the
  // automatic path - leaving it as text is the only honest option.
  if (side.dense) return null;
  if (cost > rawTok * cfg.ratio || rawTok - cost < cfg.minSave) return null;

  const marker =
    `[tanuki-context: ${origChars} chars imaged in place as ${r.pages.length} PNG page(s), ` +
    `~${cost} vs ~${rawTok} text tokens. ↵=newline →=tab ⇥N=indent` +
    (cbEntries > 0 ? `; ·legend· line maps ${cbEntries} sigils` : "") +
    (side.needles.length > 0 ? `; ·verbatim· below carries ${side.needles.length} exact strings as text` : "") +
    `]`;
  const blocks: unknown[] = [{ type: "text", text: marker }];
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
  if (side.text !== "") {
    blocks.push({ type: "text", text: side.text });
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
  body: string;
  imagedBlocks: number;
  origChars: number;
  imageCount: number;
  savedTokens: number;
  /** savedTokens with the session's cache state priced in (can be negative:
   *  the first text->pages flip of a cached block is a real cost). */
  savedTokensCacheAware: number;
}

/// Cross-request memory, LEDGER-ONLY by construction: it never changes the
/// emitted bytes (a cross-request rewrite would bust the client's prompt
/// cache). It exists so the savings log can price a replayed block at the
/// cache-read rate instead of pretending every avoided token was full-price
/// input — the counterfactual-accounting hole the rakuen post names.
export interface ProxySession {
  /// sha256 of block texts imaged in EARLIER requests this session.
  seenBlocks: Set<string>;
  /// a prior response showed cache traffic (cache_read/cache_creation > 0).
  cachingSeen: boolean;
}

export function newSession(): ProxySession {
  return { seenBlocks: new Set(), cachingSeen: false };
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
  // provider ratios for the cache-aware ledger, from the request's own model
  const rate = resolveRate(typeof body.model === "string" ? body.model : null).rate;

  // ponytail rung 2, applied to the wire: a byte-identical repeat of a block
  // we already imaged in THIS request (agents re-read files constantly) gets
  // a one-line pointer instead of the same pages again. Exact repeats only;
  // near-dupes still image independently.
  const seen = new Map<string, number>(); // exact block text -> page count

  const imageBlock = (text: string): ImagedBlock | null => {
    const priorPages = seen.get(text);
    let done: ImagedBlock | null;
    if (priorPages !== undefined) {
      const chars = charCount(text);
      const marker =
        `[tanuki-context: ${chars} chars, byte-identical to a block imaged above ` +
        `(${priorPages} PNG page(s)); not repeated]`;
      const rawTok = textTokens(chars);
      const costTok = textTokens(charCount(marker));
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
      if (done) m.content = done.blocks;
      continue;
    }
    if (!Array.isArray(m.content)) continue;

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
  }

  if (imagedBlocks === 0) return null;
  return { body: JSON.stringify(body), imagedBlocks, origChars, imageCount, savedTokens, savedTokensCacheAware };
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
        stats = transformRequestBody(bodyBuf.toString("utf8"), cfg, session);
        if (stats) bodyBuf = Buffer.from(stats.body, "utf8");
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
                compressed: stats !== null,
                orig_chars: stats?.origChars ?? 0,
                image_count: stats?.imageCount ?? 0,
                // baseline names its denominator: what Anthropic billed plus
                // what the imaged blocks would have added as text (estimate).
                baseline_tokens: actual + (stats?.savedTokens ?? 0),
                // the same estimate with the session's observed cache state
                // priced in (replays at the cache-read rate, first flips
                // charged the cache-write premium). Can be negative.
                saved_tokens_cache_aware: stats?.savedTokensCacheAware ?? 0,
                caching_seen: session.cachingSeen,
                input_tokens: usage.input,
                cache_read_tokens: usage.cacheRead,
                cache_create_tokens: usage.cacheCreate,
                output_tokens: usage.output,
              });
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
        `  rules: system prompt & tools untouched · in-place blocks only · last ${Math.max(1, cfg.recencyWindow)} message(s) kept as text · secrets never imaged · cache_control skipped · identical blocks imaged once\n` +
        `  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n`,
    );
  });
  return server;
}
