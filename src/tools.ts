//! The tool registry: one definition per tool, projected into each surface
//! (JSON schema for the MCP server, typebox for the pi extension, zod for the
//! Agent SDK). The three used to carry hand-synced copies and drifted — pi
//! lost the `table` knob on tanuki_distill, the SDK described `id` as a query
//! filter. Strings and knob lists now live here only.

export interface Knob {
  key: string;
  /** Wire types only. A union (`["boolean","string"]`) is not representable
   *  on purpose: strict providers reject it — see the VERBATIM note below. */
  type: "string" | "boolean" | "integer";
  required?: boolean;
  values?: readonly string[]; // enum, for string knobs
  min?: number;
  max?: number;
  hint?: string; // per-parameter description
}

export interface ToolMeta {
  name: string;
  /** pi display label ("Tanuki Render"). */
  label: string;
  /** pi prompt snippet: one line of when-to-use. */
  snippet: string;
  /** full contract, served by MCP tools/list and pi. */
  description: string;
  /** short form for the Agent SDK server (its instructions block carries the workflow). */
  brief: string;
  params: Knob[];
}

const TEXT: Knob = { key: "text", type: "string", required: true, hint: "the bulky text to process" };
const LEVEL: Knob = {
  key: "level",
  type: "integer",
  min: 0,
  max: 4,
  hint: "ladder level (default 0): 0 raw · 1 whitespace · 2 prose · 3 dense · 4 caveman",
};
const QUERY: Knob = { key: "query", type: "string", hint: "distill: keep matching lines + context" };

/// Tri-state, spelled as a closed string enum rather than `boolean | string`.
/// The union shape (`{"type":["boolean","string"],"enum":[true,false,"lazy"]}`)
/// is invalid JSON Schema for strict providers: Moonshot/Kimi rejects the whole
/// tools list, so the server did not merely lose the knob, it failed to
/// register at all (issue #1). Gemini is stricter still - its `type` is a
/// single scalar enum, so a union is inexpressible there in any mode, not just
/// a strict one. OpenAI does not validate `parameters` at all unless the
/// caller sets `strict: true`. Booleans are still ACCEPTED on the way in
/// (parseVerbatim) so callers passing true/false keep working — the wire
/// contract is clean without breaking anyone.
const VERBATIM: Knob = {
  key: "verbatim",
  type: "string",
  values: ["full", "lazy", "off"],
  hint: "exact strings (uuids/hashes/hex ids/ips/versions) ride as text next to the pages, never trusted to pixels: \"full\" (default) ships them, \"lazy\" withholds them behind a one-line pointer, \"off\" opts out",
};

/** Shared knobs of the two pipeline tools (render/estimate). */
const PIPE: Knob[] = [
  TEXT,
  LEVEL,
  { key: "distill", type: "boolean", hint: "stage 0 log distiller: collapse repeats, keep error/warn lines verbatim" },
  QUERY,
  { key: "reflow", type: "boolean", hint: "pack short lines into full rows (default true)" },
  { key: "pack", type: "boolean", hint: "indent RLE + width trim, lossless (default true)" },
  { key: "font", type: "string", values: ["normal", "tiny"], hint: "tiny = 4x6 cells, ~40% fewer tokens, transcription-gated" },
  { key: "codebook", type: "boolean", hint: "repeated tokens/paths -> sigils + legend" },
  { key: "table", type: "boolean", hint: "columnar-encode whole-JSON input (keys stated once, value-lossless)" },
  { key: "crush", type: "boolean", hint: "crush oversized JSON/NDJSON arrays: keep head/tail/error rows, stash the full set, append a fetch pointer" },
  VERBATIM,
];

const MODEL: Knob = {
  key: "model",
  type: "string",
  hint: "price the decision for this model (opus/sonnet/haiku/gpt/gemini)",
};
const CACHED: Knob = {
  key: "cached",
  type: "boolean",
  hint: "text already prompt-cached this turn? imaging it usually loses",
};

export const TOOLS: readonly ToolMeta[] = [
  {
    name: "tanuki_render",
    label: "Tanuki Render",
    snippet: "Render bulky text/logs as dense PNG pages that cost a fraction of the tokens",
    description:
      "Token-cut pipeline: optional columnar table (whole-JSON input: keys stated once in a ·cols· header, rows as tab-separated JSON cells — value-lossless), optional log distillation (dedupe noise, keep errors verbatim, optional query filter), optional codebook (repeated long tokens/path prefixes -> 1-cell sigils + a ·legend· line), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. pack (default true) = lossless tight reflow (single-cell tabs, ⇥N indent runs, width-trimmed pages). font 'tiny' = 4x6 cell, ~40% fewer image-tokens (opt-in). Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
    brief:
      "Render text through the pipeline (optional distill/level/codebook) into dense PNG pages. Call after tanuki_estimate says PIPELINE cheaper.",
    params: PIPE,
  },
  {
    name: "tanuki_estimate",
    label: "Tanuki Estimate",
    snippet: "Instant token verdict: would imaging this text beat sending it as text?",
    description:
      "Estimate tokens for the pipeline (table -> distill -> codebook -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/pack/font/codebook to pick a loss/size tradeoff. The result's 'recommend' field prices the reversible knobs (pack/codebook, and table for whole-JSON input — keys stated once, value-lossless) and, separately under 'withDistill', the lossy-but-counted log route; its 'text' sub-field prices the best stays-as-text cut (lossless whitespace, plus a distill sibling) for when imaging loses — cached, small, or credential content. Pass 'model' (e.g. claude-opus-4, gpt-5, gemini-2.5) and/or cached:true to add a 'cost' field that prices the decision in real dollars with provider-correct image counting (Anthropic 28px patches, OpenAI 512px tiles, Gemini 768px tiles) and cache-read rates (a cached text token costs ~0.1x a fresh one on Anthropic), so imaging already-cached content usually loses even when it has fewer tokens. The 'fidelity' field maps the imaged density ratio to expected read-back accuracy (DeepSeek-OCR's cliff: ~98% under 8x text/vision tokens, ~60% by 20x; the 4x6 tiny font is capped lower), a signal to keep exact-recall in the verbatim sidecar and reserve lossy tiers for comprehension. The top-level 'route' field then makes the hybrid call for you — one recommended pick (image / text / raw) weighing real cost AND the read-back fidelity band, not just token count: image only when it clears the clean band and genuinely saves, else the lossless text side (cached, credential, or past-the-cliff content). One call replaces manual knob probing.",
    brief:
      "Exact page/token math for the same arguments as tanuki_render, without touching pixels. Pass model and/or cached:true for a real-dollar 'cost' verdict (cached content usually should not be imaged). Instant; call this first.",
    params: [...PIPE, MODEL, CACHED],
  },
  {
    name: "tanuki_distill",
    label: "Tanuki Distill",
    snippet: "Deterministically dedupe noisy logs, keeping every error line verbatim",
    description:
      "Stage 0 alone: make noisy logs/output small and readable WITHOUT imaging. Strips ANSI, collapses runs of near-identical lines/blocks into '[×N similar]', suppresses global near-dupes (exact + same-template) with exact counts, always keeps error/warn/fail lines verbatim, optional query (regex) returns only the relevant slice. table:true first columnar-encodes whole-JSON input (keys stated once) so identical rows collapse harder. Deterministic, order-preserving.",
    brief:
      "Stage 0 alone: collapse repeated log lines/blocks and template near-dupes; error/warn lines kept verbatim. Output stays greppable text.",
    params: [TEXT, QUERY, { key: "table", type: "boolean", hint: "columnar-encode whole-JSON input first (keys stated once, value-lossless)" }, { key: "crush", type: "boolean", hint: "crush oversized JSON/NDJSON arrays: keep head/tail/error rows, stash the full set, append a fetch pointer" }],
  },
  {
    name: "tanuki_compress",
    label: "Tanuki Compress",
    snippet: "Graded text compression (lossless whitespace up to gist-only)",
    description:
      "Stage 1 alone: graded text compression for content that stays TEXT. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths are preserved verbatim.",
    brief: "Stage 1 alone: graded text compression, levels 0-4, code/paths/hashes protected from level 2 up.",
    // tanuki_compress defaults level to 1, not 0 like render/estimate, so it
    // cannot share LEVEL's hint: the published text said "default 0" while
    // the code applied whitespace compression. The hint reaches the pi and
    // Agent-SDK surfaces (the MCP JSON Schema carries no descriptions).
    params: [TEXT, { ...LEVEL, hint: "ladder level (default 1): 0 raw · 1 whitespace · 2 prose · 3 dense · 4 caveman" }],
  },
  {
    name: "tanuki_stats",
    label: "Tanuki Stats",
    snippet: "Session savings summary from the tanuki/pxpipe event log",
    description:
      "Summarize the pxpipe measurement log (~/.pxpipe/events.jsonl): requests, compression counts, honest input-token savings (input + cache reads + cache creates), and the output-token share of the bill — the part no input-side tool can cut.",
    brief: "Session savings summary from the events log (honest denominator: input + cache reads + cache creates).",
    params: [],
  },
  {
    name: "tanuki_stash",
    label: "Tanuki Stash",
    snippet: "Park huge text on disk for a few hundred tokens of map; fetch slices later",
    description:
      "Park bulky text outside the context window (content-addressed file under TANUKI_STASH or ~/.tanuki/stash) and get back a compact map: distill stats, top repeats, first/last lines, and the stash id. Pay a few hundred tokens now, fetch slices later - the retrieval pattern, with tanuki pricing on the way back.",
    brief:
      "Park bulky text outside the context window; returns a compact map (distill stats, top repeats, id). Retrieval pattern, tanuki pricing on the way back.",
    params: [TEXT],
  },
  {
    name: "tanuki_fetch",
    label: "Tanuki Fetch",
    snippet: "Pull a stashed slice; big answers arrive as cheap dense pages",
    description:
      "Pull a slice of stashed text by id: query (regex, distill-powered: matches + error/warn lines + context) or lines 'a-b'. Big slices come back as dense PNG pages automatically when they clearly win (>=25% and >=300 tokens cheaper, <=6 pages); small ones stay text. Credential-shaped values (API keys, tokens, private-key headers) in the returned slice are replaced by a '[redacted:<kind>]' placeholder and counted in a '[N credential(s) redacted]' line - the stash keeps the original bytes, so redact:false returns them verbatim when you actually need the secret.",
    brief: "Pull a slice of stashed text by id + query regex or lines 'a-b'. Big slices return as dense PNG pages automatically. Credential-shaped values are redacted in the returned slice; redact:false returns them verbatim.",
    params: [
      { key: "id", type: "string", required: true, hint: "stash id from tanuki_stash" },
      { key: "query", type: "string", hint: "regex: matching lines + error/warn lines + context" },
      { key: "lines", type: "string", hint: "line range 'a-b' (1-based, inclusive)" },
      { key: "find", type: "string", hint: "free-word relevance search over the stash: space-separated words, top windows by hit score" },
      { key: "top", type: "integer", min: 1, max: 32, hint: "find mode: how many top windows (1-32, default 8)" },
      { key: "redact", type: "boolean", hint: "mask credential-shaped values in the returned slice (default true); false returns the original bytes" },
      VERBATIM,
    ],
  },
  {
    name: "tanuki_verify",
    label: "Tanuki Verify",
    snippet: "Check a value read off a page against the stashed original on disk",
    description:
      "Disk-grounded exact check for a value you read off a rendered page (an id/hash/version/path). No model: it compares your candidate against the stashed original bytes and returns status 'exact' (found verbatim, with line), 'corrected' (a unique near-miss exists - one substituted or transposed character; use `found`), 'ambiguous' (several near-matches in `candidates` - disambiguate with tanuki_fetch), or 'absent' (no match - do not invent one). Turns the silent misread (README Table D) into an exact match or an explicit flag. Call before acting on any value transcribed from pixels.",
    brief:
      "Disk-grounded check of a value read off a page vs the stashed original: exact/corrected/ambiguous/absent + line. No model. Use before trusting a transcribed id/hash/version.",
    params: [
      { key: "id", type: "string", required: true, hint: "stash id from tanuki_stash" },
      { key: "value", type: "string", required: true, hint: "the string you read off a page, to check byte-exact" },
    ],
  },
];

/// The MCP tools/list advertises a slim default surface - the tools that cover
/// the documented workflow. The rest stay callable by name but out of
/// tools/list unless TANUKI_ALL_TOOLS=1, because every advertised schema is
/// context the model pays for on every request.
///
/// `tanuki_fetch` is not optional here: `tanuki_stash` parks text outside the
/// context and hands back a map, and fetch is the ONLY way to read it again.
/// Advertising stash without fetch let the model park data it could never
/// retrieve - it burned every turn on ToolSearch looking for a tool that was
/// not there, which is the whole of the "agent loop thrash" in EVALS §6.
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "tanuki_render",
  "tanuki_estimate",
  "tanuki_stash",
  "tanuki_fetch",
  "tanuki_verify",
];

export function visibleTools(): readonly ToolMeta[] {
  if (process.env.TANUKI_ALL_TOOLS === "1") return TOOLS;
  return TOOLS.filter((t) => DEFAULT_TOOL_NAMES.includes(t.name));
}
