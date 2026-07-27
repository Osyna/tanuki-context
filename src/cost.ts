//! Situation-aware cost model — the "codeburn calculation." tanuki's verdict
//! compares token COUNTS, which equals real cost only when both sides bill at
//! the same per-token rate. They do not: on Anthropic a cache-read costs ~0.1×
//! a fresh input token, while image (visual) tokens bill AT the input rate. So
//! the cheapest technique depends on the SITUATION — is the text already cached
//! this turn, and which provider prices it. Only the RATIOS drive the verdict;
//! absolute $/Mtok (list prices, overridable via TANUKI_RATES) drive the
//! optional dollar figure. Image-token COUNTS are provider-correct when page
//! dims are supplied: Anthropic 28px patches, OpenAI 512px high-detail tiles
//! (85 + 170/tile), Gemini 768px tiles (258/tile, ~approximate — their crop
//! rule has undocumented edges; the API usage field is authoritative).

import { rnd } from "./serde.ts";

/** 6-decimal round for the reported dollar figures (tokens are cheap; keep signal). */
function usd(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export interface Rate {
  /** $/Mtok list price (calibration knob — cancels out of the verdict). */
  input: number;
  /** $/Mtok list price for output tokens (reported for context; tanuki cuts input only). */
  output: number;
  /** cache-read price ÷ input price — the load-bearing ratio when text is cached. */
  cacheReadMult: number;
  /** cache-WRITE price ÷ input price (Anthropic/OpenAI ~1.25×). The flip cost:
   *  replacing cached text with fresh pages writes those pages at this premium. */
  cacheWriteMult: number;
  /** image(visual)-token price ÷ input-token price (1.0 on Anthropic). */
  imageMult: number;
  /** how this family COUNTS image tokens: 28px patches, 512px tiles, or 768px tiles. */
  family: "anthropic" | "openai" | "gemini";
}

/** List prices as of this month; the MULTIPLIERS are the stable facts, the $ are approximate. */
export const RATES_AS_OF = "2026-07";

// Substring-keyed families. Multipliers (cache-read, image) are well-known and
// load-bearing; absolute $/Mtok are approximate list prices, overridable.
const TABLE: Record<string, Rate> = {
  // Anthropic — cache-read 0.1×, cache-write 1.25×, image tokens at the input rate (1×).
  opus: { input: 15, output: 75, cacheReadMult: 0.1, cacheWriteMult: 1.25, imageMult: 1, family: "anthropic" },
  sonnet: { input: 3, output: 15, cacheReadMult: 0.1, cacheWriteMult: 1.25, imageMult: 1, family: "anthropic" },
  haiku: { input: 1, output: 5, cacheReadMult: 0.1, cacheWriteMult: 1.25, imageMult: 1, family: "anthropic" },
  // Non-Anthropic — image tokens are COUNTED by that provider's tile rule when
  // page dims are supplied; cache discounts differ (OpenAI reads 0.1×, writes 1.25×;
  // Gemini implicit caching reads 0.25×, no per-token write premium — storage-fee model).
  gpt: { input: 1.25, output: 10, cacheReadMult: 0.1, cacheWriteMult: 1.25, imageMult: 1, family: "openai" },
  gemini: { input: 1.25, output: 10, cacheReadMult: 0.25, cacheWriteMult: 1, imageMult: 1, family: "gemini" },
  default: { input: 3, output: 15, cacheReadMult: 0.1, cacheWriteMult: 1.25, imageMult: 1, family: "anthropic" },
};

/** TABLE merged with a `TANUKI_RATES` JSON override (per-key partial merge). */
function table(): Record<string, Rate> {
  const env = process.env.TANUKI_RATES;
  if (env === undefined || env.length === 0) return TABLE;
  try {
    const o = JSON.parse(env) as Record<string, Partial<Rate>>;
    const merged: Record<string, Rate> = { ...TABLE };
    for (const [k, v] of Object.entries(o)) {
      merged[k] = { ...(merged[k] ?? TABLE.default), ...v };
    }
    return merged;
  } catch {
    return TABLE; // ponytail: a malformed override falls back to list prices, never throws
  }
}

/** Resolve a model string to a rate by substring; unknown ⇒ `default`. */
export function resolveRate(model?: string | null): { key: string; rate: Rate } {
  const t = table();
  const m = (model ?? "").toLowerCase();
  for (const key of ["opus", "sonnet", "haiku", "gpt", "gemini"]) {
    if (m.includes(key) && t[key] !== undefined) return { key, rate: t[key] };
  }
  return { key: "default", rate: t.default };
}

export interface CostSituation {
  /** model id (substring-matched: opus/sonnet/haiku/gpt/gemini); default rates otherwise. */
  model?: string | null;
  /** is the TEXT already served from the prompt cache this turn? (imaging it usually loses). */
  cached?: boolean;
}

export interface CostResult {
  model: string;
  cached: boolean;
  ratesAsOf: string;
  /** the image-token COUNT the dollars use (provider tile rule when page dims were supplied). */
  imageTokens: number;
  /** $ to send the content as text (cache-read priced when `cached`). */
  textUsd: number;
  /** $ to send it as image (visual) tokens. */
  imageUsd: number;
  cheaper: "PIPELINE" | "TEXT";
  /** (textUsd − imageUsd) / textUsd × 100, half away from zero; negative ⇒ imaging costs more. */
  savedPct: number;
  /** image tokens must be ≤ this to beat the text price in this situation. */
  breakevenImageTokens: number;
  note?: string;
}

/**
 * Per-provider image-token count from real page dims. Constants confirmed
 * against provider docs as of RATES_AS_OF; float ops in fixed order for
 * engine parity (Rust mirrors exactly).
 */
export function providerImageTokens(
  dims: Array<[number, number]>,
  family: "openai" | "gemini",
): number {
  let tok = 0;
  for (const [w0, h0] of dims) {
    if (family === "openai") {
      // high detail: fit 2048×2048 (downscale only), then shortest side to
      // ≤768 (downscale only), then 85 + 170 per 512px tile.
      let w = w0;
      let h = h0;
      const s1 = Math.min(1, 2048 / Math.max(w, h));
      w *= s1;
      h *= s1;
      const s2 = Math.min(1, 768 / Math.min(w, h));
      w = Math.ceil(w * s2);
      h = Math.ceil(h * s2);
      tok += 85 + 170 * (Math.ceil(w / 512) * Math.ceil(h / 512));
    } else {
      // gemini: ≤384px both dims flat 258, else 258 per 768px tile.
      tok += w0 <= 384 && h0 <= 384 ? 258 : 258 * (Math.ceil(w0 / 768) * Math.ceil(h0 / 768));
    }
  }
  return tok;
}

/**
 * Price text-vs-image for a given situation. Verdict rests only on stable
 * ratios (cache-read, image) and provider-correct counts; dollars use
 * labeled, overridable list prices.
 */
export function costVerdict(
  textTokens: number,
  imageTokens: number,
  s: CostSituation,
  geom?: { dims: Array<[number, number]> },
): CostResult {
  const { key, rate } = resolveRate(s.model);
  const cached = s.cached === true;
  const counted =
    rate.family !== "anthropic" && geom !== undefined
      ? providerImageTokens(geom.dims, rate.family)
      : imageTokens;
  const inUsd = rate.input / 1e6; // $ per input token
  const textRate = inUsd * (cached ? rate.cacheReadMult : 1);
  // The flip cost, priced: when the text is already cached, fresh pages are a
  // cache WRITE (~1.25×), not plain input — the suffix-invalidation premium
  // the blog math demands. Uncached, both sides are fresh input: no premium.
  const imgRate = inUsd * rate.imageMult * (cached ? rate.cacheWriteMult : 1);
  const textUsd = textTokens * textRate;
  const imageUsd = counted * imgRate;
  const breakeven = imgRate > 0 ? Math.floor((textTokens * textRate) / imgRate) : Infinity;
  const cheaper = imageUsd < textUsd ? "PIPELINE" : "TEXT";
  const savedPct = textUsd > 0 ? rnd((1 - imageUsd / textUsd) * 100) : 0;
  const notes: string[] = [];
  if (rate.family === "openai") {
    notes.push(
      geom !== undefined
        ? "image tokens counted with OpenAI's high-detail tile rule (85 + 170 per 512px tile)"
        : "no page dims supplied; image count falls back to Anthropic's 28px patch grid — approximate for openai",
    );
  } else if (rate.family === "gemini") {
    notes.push(
      geom !== undefined
        ? "~approximate: Gemini's documented 768px-tile rule (258/tile); the API usage field is authoritative"
        : "no page dims supplied; image count falls back to Anthropic's 28px patch grid — approximate for gemini",
    );
  }
  if (cached) {
    notes.push(
      `text priced at cache-read rate (${rate.cacheReadMult}× input), fresh pages at the cache-write rate (${rate.cacheWriteMult}× input); imaging already-cached content usually loses`,
    );
  }
  return {
    model: key,
    cached,
    ratesAsOf: RATES_AS_OF,
    imageTokens: counted,
    textUsd: usd(textUsd),
    imageUsd: usd(imageUsd),
    cheaper,
    savedPct,
    breakevenImageTokens: breakeven,
    note: notes.length > 0 ? notes.join("; ") : undefined,
  };
}

/** ponytail self-check: run `node --experimental-strip-types src/cost.ts` or import demo(). */
export function demo(): void {
  // Anthropic uncached: fewer image tokens win (imageMult=1 ⇒ verdict == token count).
  const a = costVerdict(1000, 400, { model: "claude-opus-4", cached: false });
  console.assert(a.cheaper === "PIPELINE", "uncached: 400 img < 1000 text should image");
  console.assert(a.breakevenImageTokens === 1000, `uncached breakeven ${a.breakevenImageTokens}`);
  // Same content already cached: text reads at 0.1×, pages would be a fresh
  // 1.25× cache write, so imaging now LOSES hard.
  const b = costVerdict(1000, 400, { model: "claude-opus-4", cached: true });
  console.assert(b.cheaper === "TEXT", "cached: text at 0.1× beats 400 image tokens");
  console.assert(b.breakevenImageTokens === 80, `cached breakeven ${b.breakevenImageTokens}`);
  // Deep cut still wins even when cached: 50 img < 80 breakeven.
  const c = costVerdict(1000, 50, { model: "opus", cached: true });
  console.assert(c.cheaper === "PIPELINE", "cached but 20× cut still images");
  // Non-Anthropic carries the approximate-dollars note.
  const g = costVerdict(1000, 400, { model: "gpt-5", cached: false });
  console.assert(g.note !== undefined && g.note.includes("approximate"), "gpt note present");
  // Env override applies and never throws on garbage.
  process.env.TANUKI_RATES = '{"opus":{"cacheReadMult":0.5}}';
  const o = costVerdict(1000, 400, { model: "opus", cached: true });
  console.assert(o.breakevenImageTokens === 400, `override breakeven ${o.breakevenImageTokens}`);
  delete process.env.TANUKI_RATES;
  console.log("cost.ts demo ok");
}

if (import.meta.main) demo();
