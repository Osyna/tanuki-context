---
name: tanuki-context
version: 0.8.0
description: |
  Cut input-token cost by rendering bulky text (logs, command output, long
  docs) as dense PNG pages the model reads at a fraction of the price, or by
  parking it outside context and fetching slices. Use when pasting or reading
  anything over ~2,000 tokens of logs, build output, or documents; when a
  session is close to its context limit; or before re-reading a large file.
  Requires the tanuki-context MCP server (tanuki_* tools) and a
  vision-capable model.
---

# tanuki-context: pay pixels, not tokens

Text costs ~1 token per 4 characters. A dense PNG page costs a fixed 1,456
tokens and carries up to 28,080 characters. The tanuki_* tools exploit that
gap deterministically: nothing is summarized by a model, errors stay
verbatim, and every drop is counted.

## Workflow

1. **Estimate first, always.** `tanuki_estimate { text }` is instant and
   never renders pixels. Read the answer's recommendation, top down:
   - `route` - **the pick**: the one recommended strategy (`image` / `text` /
     `raw`), chosen by weighing real cost AND the read-back fidelity band, not
     just tokens. `route.reason` says why; `route.fidelity` is the band (or
     `exact` for a lossless text pick). Act on this unless you know better.
   - `recommend` - the cheapest reversible knob set (pack/codebook, and
     `table` for whole-JSON input), priced.
   - `recommend.withDistill` - the log route (repeats collapsed with exact
     counts). Cheaper, and honest for logs; do not use it on source code.
   - `recommend.text` - the best cut that stays TEXT (no pixels): lossless
     whitespace, plus a distill sibling. The answer when the verdict is TEXT
     (cached, small, or credential content) - you still save without imaging.
2. **Act on the verdict.**
   - `"PIPELINE cheaper"` and you need the content in front of you ->
     `tanuki_render` with the recommended knobs. Use the returned pages
     instead of pasting the text.
   - You only need parts of it, now or later -> `tanuki_stash { text }`
     (returns a ~300-token map + id), then `tanuki_fetch { id, query }` or
     `{ id, lines: "a-b" }`. Big slices arrive as pages automatically, and
     credential-shaped values come back as `[redacted:<kind>]` with a count
     line - pass `redact: false` only when you actually need the secret.
   - **Verify before you quote.** Any id/hash/version/path you read off a
     page -> `tanuki_verify { id, value }` (disk-grounded, no model):
     `exact` (with line), `corrected` (you misread one char - use it),
     `ambiguous` (fetch to disambiguate), or `absent` (do not invent one).
   - `"TEXT cheaper"` -> just use the text. Small inputs are not worth an
     image even when the math technically favors one.
   - **Already cached?** If the text is already in the prompt cache (a file
     the harness re-sends every turn), pass `{ model: "<your model>",
     cached: true }`. `tanuki_estimate` adds a `cost` block in real dollars:
     a cache-read token costs ~0.1x a fresh one, so imaging cached content
     usually *loses* even with fewer tokens - `cost.cheaper` says "TEXT" and
     you leave it alone. Pass `model` alone to price a one-shot decision;
     image tokens are counted with that provider's own rule (OpenAI 512px
     tiles, Gemini 768px tiles - Gemini flagged approximate), so the verdict
     is not an Anthropic-only guess.
3. **For noisy logs**, add `distill: true` (and `query: "regex"` for a
   slice). Error/warn/fail lines survive verbatim; repeats become one
   exemplar plus an exact xN count.
4. **For whole-JSON input** (arrays of objects, NDJSON like
   `journalctl -o json`), pass `table: true` - keys are stated once in a
   `·cols·` header and rows become tab-separated JSON cells. Value-lossless,
   and uniform rows then collapse harder under distill. `recommend` probes
   this on its own, so trusting it is enough.
5. **Shell commands with chatty output**: run them as
   `tanuki-context run -- <cmd>` instead of reading the firehose. Exit code
   passes through; the full capture is stashed and fetchable.
6. **End of session**: `tanuki_stats` totals the savings log. Read
   `estInputSavedPctCacheAware` (replays priced at cache-read rates, first
   flips charged the write premium) over the optimistic `estInputSavedPct`;
   `outputSharePct` is the share of the bill that is the model's own output,
   which no input-side tool (including this one) can cut; and
   `toolFurnitureTokens` is tanuki's own schema overhead, counted honestly.

## Reading the pages

`↵` = original newline · `→` = tab · `⇥N` = N leading spaces · a trailing
`·legend·` line maps codebook sigils back to full tokens · `[U+XXXX]` = a
codepoint the atlas has no glyph for · `[×N similar]` = N near-identical
lines collapsed here.

## Do not

- Do not image secrets or code you are about to edit. Rendering is exact;
  model read-back of dense hex is not (README Table D: 5/10 at normal
  density). Grep-targets (uuids/hashes/ids/ips/versions) are covered
  automatically: the `verbatim` sidecar (default on) ships them as text
  next to the pages - quote them from there, never from pixels.
- Do not use `font: "tiny"` or ladder levels 2-4 on anything you may need
  to quote. Tiny is a 99.7%-read-back trade; levels 2-4 reword prose.
- Do not use `withDistill` numbers on source code or docs you want intact -
  distill collapses similar-looking lines.
- Do not state an id/hash/version transcribed from a page as fact. Quote it
  from the `verbatim` sidecar, or confirm with `tanuki_verify`; if a value is
  `absent`, say so - never emit a plausible-looking guess.
- Do not probe knob combinations by hand; `recommend` already priced them.
