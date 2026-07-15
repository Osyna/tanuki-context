#!/usr/bin/env node
// pxpipe as a callable MCP server (stdio) — dedicated to the pxpipe project.
//
// pxpipe is NOT run as a transparent Anthropic proxy anymore (that relocated the
// system prompt into a user-turn "<system-reminder> … not written by the user"
// block that agents flagged as prompt injection). Its rendering/estimation is
// exposed here as explicit, model-callable tools instead.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compressText, LEVELS } from "./compress.mjs";
import { distillLog } from "./distill.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PXPIPE_DIST || path.join(os.homedir(), "Projects", "pxpipe", "dist", "core", "index.js");
const { renderTextToImages, transformAnthropicMessages, setAllowedModelBases } = await import(DIST);

const b64 = (u8) => Buffer.from(u8).toString("base64");
const MAX_INLINE_PAGES = 6;
const EVENTS = path.join(os.homedir(), ".pxpipe", "events.jsonl");

function pxStats() {
  if (!existsSync(EVENTS)) return { available: false, note: "no ~/.pxpipe/events.jsonl yet" };
  let requests = 0, compressed = 0, origChars = 0, images = 0, baseline = 0, actual = 0;
  for (const l of readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    requests++;
    if (e.compressed) { compressed++; origChars += e.orig_chars || 0; images += e.image_count || 0; }
    if (e.baseline_tokens) baseline += e.baseline_tokens;
    // actual = every way input bytes get billed; ignoring cache_read would fake the savings
    actual += (e.input_tokens || 0) + (e.cache_read_tokens || 0) + (e.cache_create_tokens || 0);
  }
  return { available: true, requests, compressedRequests: compressed, imagedChars: origChars, imagesEmitted: images,
    baselineTokens: baseline, actualInputTokens: actual,
    estInputSavedPct: baseline && actual ? Math.round((1 - actual / baseline) * 1000) / 10 : null };
}

const server = new McpServer({ name: "pxpipe", version: "0.9.0" });

// ↵ in source text makes reflow() bail (sparse render); production neutralizes it first.
const neutralize = (s) => s.replace(/\u21b5/g, "\u23ce");

// pipeline: text -> [stage 0: distill logs] -> [stage 1: level transform] -> pxpipe images
async function pipeline(text, { level = 0, model, reflow = true, distill = false, query = null } = {}) {
  let stage0 = null, working = text;
  if (distill || query) {
    const d = distillLog(text, { query });
    stage0 = d.stats; working = d.distilled;
  }
  const { compressed, protectedLines } = compressText(working, level);
  const opts = { reflow }; if (model) opts.model = model;
  const { pages } = await renderTextToImages(neutralize(compressed), opts);
  const px = pages.reduce((a, p) => a + (p.width || 0) * (p.height || 0), 0);
  const imageTokens = Math.round(px / 750);
  const baselineTextTokens = Math.round(text.length / 4); // the honest comparator: raw text as text
  return { compressed, protectedLines, pages, imageTokens, baselineTextTokens, stage0,
    stage1SavedPct: Math.round((1 - compressed.length / text.length) * 100),
    totalSavedPct: baselineTextTokens ? Math.round((1 - imageTokens / baselineTextTokens) * 100) : 0 };
}
server.registerTool("pxpipe_render",
  { title: "Render text to images (distill → level → pxpipe)", description: "Token-cut pipeline: optional log distillation (dedupe noise, keep errors verbatim, optional query filter), then a text transform level, then dense PNG page(s). level 0 raw→pxpipe · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.", inputSchema: { text: z.string(), level: z.number().int().min(0).max(4).optional(), distill: z.boolean().optional(), query: z.string().optional(), model: z.string().optional(), reflow: z.boolean().optional() } },
  async ({ text, level = 0, distill = false, query, model, reflow = true }) => {
    const r = await pipeline(text, { level, model, reflow, distill, query });
    const meta = LEVELS[Math.max(0, Math.min(4, level | 0))];
    const summary = (r.stage0 ? `distill: ${r.stage0.origLines} -> ${r.stage0.outLines} lines (-${r.stage0.savedPct}% chars, ${r.stage0.collapsedRuns} runs collapsed, ${r.stage0.importantKept} error/warn kept${r.stage0.query ? `, query "${r.stage0.query}"` : ""})\n` : "")
      + `L${meta.n} ${meta.name} (${meta.loss}): ${text.length} chars -> ${r.compressed.length} chars (stage1 -${r.stage1SavedPct}%)`
      + `\nvs ~${r.baselineTextTokens} text-tokens raw = TOTAL -${r.totalSavedPct}%${r.protectedLines ? ` · ${r.protectedLines} lines kept verbatim` : ""}${reflow ? " · ↵ = newline" : ""}`;
    const imgs = r.pages.slice(0, MAX_INLINE_PAGES).map((p) => ({ type: "image", data: b64(p.png), mimeType: "image/png" }));
    const more = r.pages.length > MAX_INLINE_PAGES ? [{ type: "text", text: `(+${r.pages.length - MAX_INLINE_PAGES} more page(s))` }] : [];
    return { content: [{ type: "text", text: summary }, ...imgs, ...more] };
  });

server.registerTool("pxpipe_estimate",
  { title: "Estimate the distill → level → pxpipe pipeline", description: "Estimate tokens for the pipeline (optional log distillation, text transform level, pxpipe imaging) vs sending the raw text as text. No image data returned. Compare levels/flags to pick a loss/size tradeoff.", inputSchema: { text: z.string(), level: z.number().int().min(0).max(4).optional(), distill: z.boolean().optional(), query: z.string().optional(), model: z.string().optional(), reflow: z.boolean().optional() } },
  async ({ text, level = 0, distill = false, query, model, reflow = true }) => {
    const r = await pipeline(text, { level, model, reflow, distill, query });
    const meta = LEVELS[Math.max(0, Math.min(4, level | 0))];
    return { content: [{ type: "text", text: JSON.stringify({
      level: `${meta.n} ${meta.name}`, loss: meta.loss, distill: r.stage0,
      origChars: text.length, stage1Chars: r.compressed.length, stage1SavedPct: r.stage1SavedPct,
      pages: r.pages.length, imageTokens: r.imageTokens, rawTextTokens: r.baselineTextTokens,
      totalSavedPct: r.totalSavedPct, protectedLines: r.protectedLines,
      verdict: r.imageTokens < r.baselineTextTokens ? "PIPELINE cheaper" : "TEXT cheaper" }, null, 2) }] };
  });

server.registerTool("pxpipe_distill",
  { title: "Distill logs/output (stage 0 alone)", description: "Make noisy logs/command output small and readable WITHOUT imaging: strip ANSI, collapse runs of near-identical lines (timestamps/ids/numbers masked) into '[×N similar]', always keep error/warn/fail lines verbatim, and optionally filter to a query (regex) ± context with '… N lines omitted' markers. Deterministic, order-preserving. Returns the distilled text.", inputSchema: { text: z.string(), query: z.string().optional() } },
  async ({ text, query }) => {
    const { distilled, stats } = distillLog(text, { query });
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }, { type: "text", text: distilled }] };
  });
server.registerTool("pxpipe_transform",
  { title: "Transform an Anthropic /v1/messages body", description: "Run pxpipe's request transform on an Anthropic messages JSON body, imaging eligible bulk. Writes the transformed body to a temp file (bodies are large) and returns the info summary.", inputSchema: { body: z.string(), model: z.string().optional() } },
  async ({ body, model }) => {
    const parsed = JSON.parse(body);
    const m = model || parsed.model || "claude-fable-5";
    setAllowedModelBases([m.replace(/\[.*/, "")]);
    const r = await transformAnthropicMessages({ body: new TextEncoder().encode(JSON.stringify(parsed)), model: m });
    const out = path.join(os.tmpdir(), `pxpipe-transform-${Date.now()}.json`);
    writeFileSync(out, Buffer.from(r.body));
    const i = r.info || {};
    return { content: [{ type: "text", text: JSON.stringify({ applied: r.applied, compressed: i.compressed, imageCount: i.imageCount, origChars: i.origChars, reason: i.reason, transformedBodyFile: out }, null, 2) }] };
  });

server.registerTool("pxpipe_stats",
  { title: "pxpipe usage stats", description: "Summarize pxpipe's measurement log (~/.pxpipe/events.jsonl).", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(pxStats(), null, 2) }] }));

// text-level compression (content that stays TEXT, not imaged) — graded 0-4 in ./compress.mjs
server.registerTool("pxpipe_compress",
  { title: "Compress text (graded)", description: "Token-cut text that stays TEXT (not imaged), at a caller-chosen loss level. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose (light) · 3 dense (medium) · 4 caveman (heavy, gist only). From level 2 up, code/IDs/hashes/paths/URLs are preserved verbatim. For byte-exact recall of bulk, image it with pxpipe_render instead. Returns the compressed text.", inputSchema: { text: z.string(), level: z.number().int().min(0).max(4).optional() } },
  async ({ text, level = 1 }) => {
    const { compressed, protectedLines, level: lv } = compressText(text, level);
    const meta = LEVELS[lv];
    const oTok = Math.round(text.length / 4), nTok = Math.round(compressed.length / 4);
    const stats = { level: `${lv} ${meta.name}`, loss: meta.loss, note: meta.desc,
      origChars: text.length, outChars: compressed.length, approxOrigTokens: oTok, approxOutTokens: nTok,
      savedPct: oTok ? Math.round((1 - nTok / oTok) * 100) : 0, protectedLines };
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }, { type: "text", text: compressed }] };
  });

await server.connect(new StdioServerTransport());
