//! Implicit mode: a local Anthropic middlebox, the pxpipe deployment shape
//! without pxpipe's structural flaw. Rules that keep it injection-shaped-free:
//!
//!   1. The system prompt and tool definitions are NEVER touched.
//!   2. Nothing moves between roles or positions: an oversized text block is
//!      replaced IN PLACE by a short overt marker + PNG page blocks, in the
//!      same user-role message (Anthropic allows image blocks in user content
//!      and inside tool_result content).
//!   3. The latest message is never imaged (the model may need to quote it).
//!   4. Blocks carrying cache_control are never touched (rewriting would
//!      defeat the cache they exist for).
//!   5. Imaging only happens when `estimate` says it wins by a clear margin;
//!      everything else passes through byte-for-byte.
//!
//! Responses stream through untouched; usage is scraped from the stream for
//! the ~/.pxpipe/events.jsonl savings log (same format tanuki_stats reads).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { distillLog } from "./distill.ts";
import { apply as codebookApply } from "./codebook.ts";
import { compressText } from "./ladder.ts";
import { renderText, type Font } from "./render.ts";
import { eventsPath } from "./stats.ts";

export interface ProxyCfg {
  port: number;
  upstream: string; // e.g. https://api.anthropic.com
  level: number; // ladder level for imaged blocks (default 0: none)
  distill: boolean; // stage 0 on imaged blocks (off: lossy for logs, opt-in)
  codebook: boolean;
  font: Font;
  minChars: number; // below this a block is never considered
  ratio: number; // image tokens must be <= ratio * text tokens
  minSave: number; // and save at least this many tokens
  maxPages: number; // give up on absurdly large single blocks
}

export const PROXY_DEFAULTS: Omit<ProxyCfg, "port" | "upstream"> = {
  level: 0,
  distill: false,
  codebook: false,
  font: "normal",
  minChars: 4000,
  ratio: 0.75,
  minSave: 300,
  maxPages: 20,
};

interface ImagedBlock {
  blocks: unknown[];
  origChars: number;
  pages: number;
  savedTokens: number;
}

function charCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
}

/// Stage 0/0.5/1 + imaging for one text block, or null when text stays cheaper.
function maybeImage(text: string, cfg: ProxyCfg): ImagedBlock | null {
  const origChars = charCount(text);
  if (origChars < cfg.minChars) return null;
  let working = text;
  if (cfg.distill) working = distillLog(working, null, 2).distilled;
  let cbEntries = 0;
  if (cfg.codebook) {
    const cb = codebookApply(working);
    working = cb.text;
    cbEntries = cb.entries;
  }
  if (cfg.level > 0) working = compressText(working, cfg.level).compressed;

  const rawTok = Math.round(origChars / 4);
  const r = renderText(working, true, true, cfg.font);
  if (r.pages.length > cfg.maxPages) return null;
  if (r.tokens > rawTok * cfg.ratio || rawTok - r.tokens < cfg.minSave) return null;

  const marker =
    `[tanuki-context: ${origChars} chars imaged in place as ${r.pages.length} PNG page(s), ` +
    `~${r.tokens} vs ~${rawTok} text tokens. ↵=newline →=tab ⇥N=indent` +
    (cbEntries > 0 ? `; ·legend· line maps ${cbEntries} sigils` : "") +
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
  return { blocks, origChars, pages: r.pages.length, savedTokens: rawTok - r.tokens };
}

interface JsonObj {
  [k: string]: unknown;
}

function isObj(v: unknown): v is JsonObj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export interface TransformResult {
  body: string;
  imagedBlocks: number;
  origChars: number;
  imageCount: number;
  savedTokens: number;
}

/// Rewrite a /v1/messages body. Returns null when nothing changed (caller
/// forwards the original bytes untouched).
export function transformRequestBody(raw: string, cfg: ProxyCfg): TransformResult | null {
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

  const imageBlock = (text: string): ImagedBlock | null => {
    const done = maybeImage(text, cfg);
    if (done) {
      imagedBlocks++;
      origChars += done.origChars;
      imageCount += done.pages;
      savedTokens += done.savedTokens;
    }
    return done;
  };

  // rule 3: the latest message is never imaged.
  for (let i = 0; i < body.messages.length - 1; i++) {
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
  return { body: JSON.stringify(body), imagedBlocks, origChars, imageCount, savedTokens };
}

/// Best-effort usage scrape: works on both plain JSON responses and SSE
/// streams (message_start carries the same usage keys). First match wins for
/// input/cache figures; output tokens are irrelevant to the savings log.
function scrapeUsage(text: string): { input: number; cacheRead: number; cacheCreate: number } {
  const grab = (re: RegExp): number => {
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    input: grab(/"input_tokens"\s*:\s*(\d+)/),
    cacheRead: grab(/"cache_read_input_tokens"\s*:\s*(\d+)/),
    cacheCreate: grab(/"cache_creation_input_tokens"\s*:\s*(\d+)/),
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
        stats = transformRequestBody(bodyBuf.toString("utf8"), cfg);
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
              logEvent({
                ts: Date.now(),
                tool: "proxy",
                compressed: stats !== null,
                orig_chars: stats?.origChars ?? 0,
                image_count: stats?.imageCount ?? 0,
                // baseline names its denominator: what Anthropic billed plus
                // what the imaged blocks would have added as text (estimate).
                baseline_tokens: actual + (stats?.savedTokens ?? 0),
                input_tokens: usage.input,
                cache_read_tokens: usage.cacheRead,
                cache_create_tokens: usage.cacheCreate,
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
      `minChars=${cfg.minChars} ratio=${cfg.ratio} minSave=${cfg.minSave}`;
    process.stderr.write(
      `tanuki-context proxy on http://127.0.0.1:${port} -> ${cfg.upstream}\n` +
        `  ${knobs}\n` +
        `  rules: system prompt & tools untouched · in-place blocks only · latest message never imaged · cache_control skipped\n` +
        `  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n`,
    );
  });
  return server;
}
