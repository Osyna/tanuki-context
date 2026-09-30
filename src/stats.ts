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
import { stashNet } from "./ledger.ts";
import { Float, asStr, asU64, isObj, rnd } from "./serde.ts";

export function eventsPath(): string {
  // Empty means unset, the same rule TANUKI_STASH uses. Without it,
  // `TANUKI_EVENTS=` resolved the events path to "" instead of the default.
  const p = process.env.TANUKI_EVENTS;
  if (p !== undefined && p !== "") {
    return p;
  }
  const home = process.env.HOME ?? "";
  return join(home, ".pxpipe", "events.jsonl");
}

/// The events-log summary plus, when the stash has a ledger, the NET savings of
/// what was stashed: tokens saved minus the tokens the model paid to fetch back.
export function pxStats(): object {
  const r = eventStats() as Record<string, unknown>;
  const net = stashNet();
  if (net !== null) r.stashNet = net;
  return r;
}

function eventStats(): object {
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
  // T2b: the estimator's prediction next to what was billed, over the rows
  // that carry both (an error response bills nothing and scrapes no usage)
  let estimated = 0;
  let estBilled = 0;
  // F4 diagnostic accumulators
  let cacheBreakCount = 0;
  let cacheBreakRebilled = 0;
  let lastBreak: { index: number; kind: string } | null = null;
  let toolTaxRequests = 0;
  let toolTaxTokens = 0;
  let lastToolTaxUnused: string[] = [];
  let volatileSystemCount = 0;
  let prunedRequests = 0;
  let prunedTokens = 0;
  let lastPrunedTools = 0;
  
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
    const billed =
      (asU64(o["input_tokens"]) ?? 0) +
      (asU64(o["cache_read_tokens"]) ?? 0) +
      (asU64(o["cache_create_tokens"]) ?? 0);
    actual += billed;
    const est = asU64(o["est_input_tokens"]) ?? 0;
    if (est > 0 && billed > 0) {
      estimated += est;
      estBilled += billed;
    }
    output += asU64(o["output_tokens"]) ?? 0;
    
    // F4: collect cache break stats
    if (isObj(o["cacheBreak"])) {
      cacheBreakCount++;
      const brk = o["cacheBreak"];
      const rebilled = asU64(brk["rebilled"]) ?? 0;
      cacheBreakRebilled += rebilled;
      const index = asU64(brk["index"]);
      const kind = asStr(brk["kind"]);
      if (index !== null && kind !== null) {
        lastBreak = { index, kind };
      }
    }
    
    // F4: collect tool tax stats
    if (isObj(o["toolTax"])) {
      toolTaxRequests++;
      const tax = o["toolTax"];
      toolTaxTokens += asU64(tax["tokens"]) ?? 0;
      if (Array.isArray(tax["unused"])) {
        lastToolTaxUnused = tax["unused"].filter(n => typeof n === "string") as string[];
      }
    }
    
    // --prune-tools: tools left out of the forwarded request
    const prunedNow = asU64(o["pruned_tools"]) ?? 0;
    if (prunedNow > 0) {
      prunedRequests++;
      prunedTokens += asU64(o["pruned_tool_tokens"]) ?? 0;
      lastPrunedTools = prunedNow;
    }

    // F4: count volatile system prompts
    if (o["volatileSystem"] === true) {
      volatileSystemCount++;
    }
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
  const result: Record<string, unknown> = {
    available: true,
    requests,
    compressedRequests: compressed,
    imagedChars: origChars,
    imagesEmitted: images,
    actualInputTokens: actual,
    // headline: the honest bound - replays priced at the provider's cache-read
    // rate, first text->pages flips charged the cache-write premium. Negative
    // means imaging cost money. This is the number to trust.
    estInputSavedPctCacheAware: savedCa,
    baselineCacheAwareTokens: baselineCa,
    // optimistic counterfactual, kept for comparison: every avoided token at
    // the full input rate (what every tool in this category reports).
    estInputSavedPct: saved,
    baselineTokens: baseline,
    outputTokens: output,
    // the boundary no input-side tool can cross: the output share of the bill.
    outputSharePct:
      output > 0 ? new Float(rnd((output / (actual + output)) * 1000.0) / 10.0) : null,
  };
  
  // T2b: how far the estimator that gates every imaging decision sits from the
  // bill (100 = exact). Only when the log has rows that carry both figures.
  if (estBilled > 0) {
    result.estimatedInputTokens = estimated;
    result.billedInputTokens = estBilled;
    result.estimatorRatioPct = new Float(rnd((estimated / estBilled) * 1000.0) / 10.0);
  }

  // F4: cache break stats line (only when applicable)
  if (cacheBreakCount > 0 && lastBreak !== null) {
    result.cacheBreaks = `cache breaks: ${cacheBreakCount}/${requests} requests · ${cacheBreakRebilled} tok rebilled · last: block ${lastBreak.index} ${lastBreak.kind}`;
  }
  
  // F4: tool tax stats line (only when applicable)
  if (toolTaxRequests > 0) {
    // rnd, not Math.round: rnd is the shared half-away-from-zero convention
    // both engines pin (Math.round differs on negative halves).
    const tokPerRequest = rnd(toolTaxTokens / toolTaxRequests);
    const first3 = lastToolTaxUnused.slice(0, 3);
    const extra = lastToolTaxUnused.length - 3;
    const names = extra > 0 ? `${first3.join(",")} +${extra} more` : first3.join(",");
    result.toolTax = `tool tax: ${tokPerRequest} tok/request never invoked (${names})`;
  }
  
  if (prunedRequests > 0) {
    result.toolPrune = `tool prune: ${rnd(prunedTokens / prunedRequests)} tok/request left out (${lastPrunedTools} tools, ${prunedRequests} requests)`;
  }

  // F4: volatile system prompt warning (only when applicable)
  if (volatileSystemCount > 0) {
    result.volatileSystem = `volatile system prompt: uuid/timestamp/jwt content busts the prefix cache`;
  }
  
  return result;
}
