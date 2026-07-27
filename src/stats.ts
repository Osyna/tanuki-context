//! pxpipe measurement-log summary (~/.pxpipe/events.jsonl), same math as the
//! node MCP: actual = every way input bytes get billed (input + cache reads +
//! cache creates) — ignoring cache_read would fake the savings.
//!
//! Two savings numbers, honestly labeled: `estInputSavedPct` prices every
//! avoided token at the full input rate (the optimistic counterfactual every
//! tool in this category reports), `estInputSavedPctCacheAware` prices
//! replayed blocks at the provider's cache-read rate and charges the first
//! text->pages flip at the cache-write premium. The honest number is between
//! them, and only a paired run (reference/paired-report.mjs) pins it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Float, asU64, isObj, rnd } from "./serde.ts";

export function eventsPath(): string {
  const p = process.env.TANUKI_EVENTS;
  if (p !== undefined) {
    return p;
  }
  const home = process.env.HOME ?? "";
  return join(home, ".pxpipe", "events.jsonl");
}

export function pxStats(): object {
  const path = eventsPath();
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { available: false, note: `no ${path} yet` };
  }
  let requests = 0;
  let compressed = 0;
  let origChars = 0;
  let images = 0;
  let baseline = 0;
  let actual = 0;
  let output = 0;
  let savedCacheAware = 0;
  for (const l of content.split("\n")) {
    if (l.trim().length === 0) {
      continue;
    }
    let e: unknown;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    requests += 1;
    const o = isObj(e) ? e : {};
    if (o["compressed"] === true) {
      compressed += 1;
      origChars += asU64(o["orig_chars"]) ?? 0;
      images += asU64(o["image_count"]) ?? 0;
    }
    baseline += asU64(o["baseline_tokens"]) ?? 0;
    const ca = o["saved_tokens_cache_aware"];
    savedCacheAware += typeof ca === "number" && Number.isSafeInteger(ca) ? ca : 0;
    actual +=
      (asU64(o["input_tokens"]) ?? 0) +
      (asU64(o["cache_read_tokens"]) ?? 0) +
      (asU64(o["cache_create_tokens"]) ?? 0);
    output += asU64(o["output_tokens"]) ?? 0;
  }
  const saved =
    baseline > 0 && actual > 0
      ? new Float(rnd((1.0 - actual / baseline) * 1000.0) / 10.0)
      : null;
  const baselineCa = actual + savedCacheAware;
  const savedCa =
    baselineCa > 0 && actual > 0
      ? new Float(rnd((1.0 - actual / baselineCa) * 1000.0) / 10.0)
      : null;
  return {
    available: true,
    requests,
    compressedRequests: compressed,
    imagedChars: origChars,
    imagesEmitted: images,
    baselineTokens: baseline,
    actualInputTokens: actual,
    // optimistic counterfactual: avoided text at the full input rate
    estInputSavedPct: saved,
    // cache-aware counterfactual: replays at the cache-read rate, first
    // flips charged the cache-write premium. Negative = imaging cost money.
    baselineCacheAwareTokens: baselineCa,
    estInputSavedPctCacheAware: savedCa,
    outputTokens: output,
    // the honest boundary: no input-side tool can cut this share of the bill
    outputSharePct:
      output > 0 ? new Float(rnd((output / (actual + output)) * 1000.0) / 10.0) : null,
  };
}
