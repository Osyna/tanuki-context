//! pxpipe measurement-log summary (~/.pxpipe/events.jsonl), same math as the
//! node MCP: actual = every way input bytes get billed (input + cache reads +
//! cache creates) — ignoring cache_read would fake the savings.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker for values Rust holds as f64: serde_json prints whole floats with a
 * trailing `.0` (`50.0`), which plain JS numbers lose. The custom serializer
 * in main.ts formats these like serde_json/ryu.
 */
export class Float {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export function eventsPath(): string {
  const p = process.env.TANUKI_EVENTS;
  if (p !== undefined) {
    return p;
  }
  const home = process.env.HOME ?? "";
  return join(home, ".pxpipe", "events.jsonl");
}

/** serde_json `as_u64()`: only non-negative integer JSON numbers count. */
function asU64(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** Rust f64::round(): half away from zero. */
function rnd(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
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
    const o =
      e !== null && typeof e === "object" && !Array.isArray(e)
        ? (e as Record<string, unknown>)
        : {};
    if (o["compressed"] === true) {
      compressed += 1;
      origChars += asU64(o["orig_chars"]);
      images += asU64(o["image_count"]);
    }
    baseline += asU64(o["baseline_tokens"]);
    actual +=
      asU64(o["input_tokens"]) +
      asU64(o["cache_read_tokens"]) +
      asU64(o["cache_create_tokens"]);
  }
  const saved =
    baseline > 0 && actual > 0
      ? new Float(rnd((1.0 - actual / baseline) * 1000.0) / 10.0)
      : null;
  return {
    available: true,
    requests,
    compressedRequests: compressed,
    imagedChars: origChars,
    imagesEmitted: images,
    baselineTokens: baseline,
    actualInputTokens: actual,
    estInputSavedPct: saved,
  };
}
