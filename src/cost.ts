//! Situation-aware cost model — the "codeburn calculation." tanuki's verdict
//! compares token COUNTS, which equals real cost only when both sides bill at
//! the same per-token rate. They do not: on Anthropic a cache-read costs ~0.1×
//! a fresh input token, while image (visual) tokens bill AT the input rate. So
//! the cheapest technique depends on the SITUATION — is the text already cached
//! this turn, and which provider prices it. Only the RATIOS drive the verdict;
//! absolute $/Mtok (list prices, overridable via TANUKI_RATES) drive the
//! optional dollar figure. Image-token COUNTS here are Anthropic's 28px patch
//! grid, so the dollars are calibrated for Anthropic; other providers count
//! image tokens on a different (tile) model — flagged in `note`, never hidden.

/** Rust f64::round(): half away from zero (matches stats.ts / main.ts). */
function rnd(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

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
  /** image(visual)-token price ÷ input-token price (1.0 on Anthropic). */
  imageMult: number;
  /** image-token COUNT uses Anthropic's 28px patch grid? false ⇒ dollars are approximate. */
  anthropicGrid: boolean;
}

/** List prices as of this month; the MULTIPLIERS are the stable facts, the $ are approximate. */
export const RATES_AS_OF = "2026-07";

// Substring-keyed families. Multipliers (cache-read, image) are well-known and
// load-bearing; absolute $/Mtok are approximate list prices, overridable.
const TABLE: Record<string, Rate> = {
  // Anthropic — cache-read 0.1×, image tokens billed at the input rate (1×).
  opus: { input: 15, output: 75, cacheReadMult: 0.1, imageMult: 1, anthropicGrid: true },
  sonnet: { input: 3, output: 15, cacheReadMult: 0.1, imageMult: 1, anthropicGrid: true },
  haiku: { input: 1, output: 5, cacheReadMult: 0.1, imageMult: 1, anthropicGrid: true },
  // Non-Anthropic — image token COUNTING differs (tiles), so tanuki's patch-grid
  // count is only an approximation; OpenAI's cache discount is 0.5×, not 0.1×.
  gpt: { input: 1.25, output: 10, cacheReadMult: 0.5, imageMult: 1, anthropicGrid: false },
  gemini: { input: 1.25, output: 10, cacheReadMult: 0.25, imageMult: 1, anthropicGrid: false },
  default: { input: 3, output: 15, cacheReadMult: 0.1, imageMult: 1, anthropicGrid: true },
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
 * Price text-vs-image for a given situation. Verdict rests only on stable
 * ratios (cache-read, image); dollars use labeled, overridable list prices.
 */
export function costVerdict(
  textTokens: number,
  imageTokens: number,
  s: CostSituation,
): CostResult {
  const { key, rate } = resolveRate(s.model);
  const cached = s.cached === true;
  const inUsd = rate.input / 1e6; // $ per input token
  const textRate = inUsd * (cached ? rate.cacheReadMult : 1);
  const imgRate = inUsd * rate.imageMult;
  const textUsd = textTokens * textRate;
  const imageUsd = imageTokens * imgRate;
  const breakeven = imgRate > 0 ? Math.floor((textTokens * textRate) / imgRate) : Infinity;
  const cheaper = imageUsd < textUsd ? "PIPELINE" : "TEXT";
  const savedPct = textUsd > 0 ? rnd((1 - imageUsd / textUsd) * 100) : 0;
  let note: string | undefined;
  if (!rate.anthropicGrid) {
    note = `image-token counts use Anthropic's 28px patch grid; ${key} prices images on a different (tile) model — treat dollars as approximate`;
  } else if (cached) {
    note = `text priced at cache-read rate (${rate.cacheReadMult}× input); imaging already-cached content usually loses`;
  }
  return {
    model: key,
    cached,
    ratesAsOf: RATES_AS_OF,
    textUsd: usd(textUsd),
    imageUsd: usd(imageUsd),
    cheaper,
    savedPct,
    breakevenImageTokens: breakeven,
    note,
  };
}

/** ponytail self-check: run `node --experimental-strip-types src/cost.ts` or import demo(). */
export function demo(): void {
  // Anthropic uncached: fewer image tokens win (imageMult=1 ⇒ verdict == token count).
  const a = costVerdict(1000, 400, { model: "claude-opus-4", cached: false });
  console.assert(a.cheaper === "PIPELINE", "uncached: 400 img < 1000 text should image");
  console.assert(a.breakevenImageTokens === 1000, `uncached breakeven ${a.breakevenImageTokens}`);
  // Same content already cached: text is 10× cheaper, so imaging now LOSES.
  const b = costVerdict(1000, 400, { model: "claude-opus-4", cached: true });
  console.assert(b.cheaper === "TEXT", "cached: text at 0.1× beats 400 image tokens");
  console.assert(b.breakevenImageTokens === 100, `cached breakeven ${b.breakevenImageTokens}`);
  // Deep cut still wins even when cached: 50 img < 100 breakeven.
  const c = costVerdict(1000, 50, { model: "opus", cached: true });
  console.assert(c.cheaper === "PIPELINE", "cached but 20× cut still images");
  // Non-Anthropic carries the approximate-dollars note.
  const g = costVerdict(1000, 400, { model: "gpt-5", cached: false });
  console.assert(g.note !== undefined && g.note.includes("approximate"), "gpt note present");
  // Env override applies and never throws on garbage.
  process.env.TANUKI_RATES = '{"opus":{"cacheReadMult":0.5}}';
  const o = costVerdict(1000, 400, { model: "opus", cached: true });
  console.assert(o.breakevenImageTokens === 500, `override breakeven ${o.breakevenImageTokens}`);
  delete process.env.TANUKI_RATES;
  console.log("cost.ts demo ok");
}

if (import.meta.main) demo();
