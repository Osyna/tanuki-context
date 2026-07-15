# tanuki-context — design notes

What this project is, why each piece exists, and the logic behind it.
Companion to [README.md](README.md) (usage) — this is the *why*.

## 1. Origin

[pxpipe](https://github.com/teamchong/pxpipe) exploits one pricing fact: an
image's token cost is fixed by its **pixel dimensions**, not by how much text
is inside it. Dense text rendered as a PNG costs a fraction of the same text
sent as tokens (~3+ chars per image-token vs ~1 char per text-token on real
traffic). pxpipe ships that as a transparent Anthropic proxy.

We first ran it as that proxy. It worked (measured 76.5% input-token cut on
real traffic), but the proxy relocates the system prompt into a user-turn
block labelled `<system-reminder> … not written by the user` — which reads
exactly like a prompt injection. A security-conscious agent flagged it and
refused its own configuration. That failure mode is structural, not a bug:
a transparent rewriting proxy *is* indistinguishable from an attacker to the
model it serves.

So the design moved from **implicit** (proxy rewrites everything) to
**explicit** (the model calls a tool when it wants the cut). First as a node
MCP wrapping pxpipe's library, then — this repo — as a single-binary Rust
rewrite. The imaging stage keeps the `pxpipe` name: the mechanic is theirs.

## 2. The pipeline

```mermaid
graph LR
  A[text / logs] --> B["stage 0 · distill<br/>(logs: selection, not compression)"]
  B --> C["stage 1 · ladder<br/>(levels 0–4, graded loss)"]
  C --> D["stage 2 · pxpipe imaging<br/>(pixel-priced PNG pages)"]
  D --> E[image tokens]
```

Three stages, strictly ordered, each optional. The order is the point:
**image tokens are priced by pixels, and pixels are proportional to
characters** — so every character removed by an earlier stage multiplies
through the later ones. Distill −55% then imaging −78% compounds to −90%,
not −78%.

### Stage 0 — distill (for logs and command output)

Borrowed logic from [context-mode](https://github.com/mksglu/context-mode):
don't *compress* noise, **drop** it — but deterministically, with exact
accounting, and no model in the loop. Three passes:

1. **Consecutive block collapse.** Logs repeat in cycles (`opened / closed /
   COMMAND=…`), not just single lines. After masking volatile tokens
   (timestamps, uuids, hex runs, numbers+units → `<ts> <uuid> <hex> <n>`),
   repetitions of 1–8-line blocks collapse to the first block +
   `[×N similar]`. Chronology preserved.
2. **Global near-dupe suppression.** Interleaved noise defeats pass 1 (a
   3-line cycle where one line varies — real `sudo` logs do exactly this).
   Two tiers: an **exact** masked key, then a **coarse template** key
   (non-alpha tokens → `<v>`, so 1.6M distinct file paths in an rclone log
   unify into one `Copied (new)` template). First 2–3 occurrences of each
   key stay in place; the rest are dropped and reported in a trailing
   summary with exact counts (`×375,347 …Copied (new)…`).
3. **Query slice** (optional). A regex keeps matching lines ± context with
   `… N lines omitted` markers — search-instead-of-read.

**Hard invariant:** any line matching the important pattern
(err/error/exception incl. CamelCase `TypeError`, warn, fail, panic, fatal,
traceback, denied, refused, timeout, assert, segfault — plural/suffix forms
included) is *never* collapsed, suppressed, or reworded. On a real journal:
0 important lines lost, verified by set-difference against the input.

Why selection beats compression here: a 126 MB rclone log is ~99% the same
three events. Imaging it raw still pays for every repeat (−78%); distilling
first removes the repeats *before* they reach the renderer (−99.2%), while
the summary table keeps every distinct event type visible with its true
frequency. Information density goes up, not down.

### Stage 1 — ladder (graded, caller-chosen loss)

Text-level compression as an explicit loss dial, each level a superset of
the previous:

| level | name | loss | what it does |
|---|---|---|---|
| 0 | none | none | passthrough |
| 1 | whitespace | lossless | trailing whitespace, blank-run collapse — safe for code |
| 2 | prose | light | collapse spaces, cut filler phrases ("in order to"→"to") |
| 3 | dense | medium | drop articles and intensifiers |
| 4 | caveman | heavy | telegraphic: drop function words — gist only |

**Exact-recall guard (from level 2 up):** a line is passed **verbatim** if it
is indented (code), symbol-dense (>30% non-prose characters — JSON, log
lines), or contains any whitespace-free token ≥24 chars (hashes, paths,
URLs, ids). Loss only ever touches prose. This is why L1–L4 measure ~0% on
source code: that's correctness, not weakness — the guard refusing to
reword what must survive byte-exact.

The lossy levels are the safe subset of "Caveman"/token-optimizer-style
prompt compression. We evaluated and rejected model-based token pruning
(LLMLingua/RTK): it deletes tokens it judges unimportant, which is exactly
the silent-confabulation risk pxpipe's own findings warn about. A
deterministic, inspectable ladder with a protected-line guard gives the
same win on prose without gambling exact strings.

### Stage 2 — pxpipe imaging

A faithful port of pxpipe's production dense renderer:

- **reflow**: strip trailing whitespace, collapse blank runs, expand tabs to
  4-col stops (`→` marker), then join hard newlines with the `↵` sentinel so
  short lines *pack* into full-width rows instead of wasting a row each.
  Lossless at the transform level — `↵` marks every original newline, so the
  text is reconstructable. Pre-existing `↵` in the source is swapped to `⏎`
  first so the sentinel can't collide.
- **wrap** at 312 columns, by codepoint; wide (CJK) glyphs take 2 cells.
- **page**: ≤90 rows / 28,080 chars per page → 1568×728 px max (Anthropic's
  no-resample bound; ≈1,522 tokens/page at pixels/750).
- **blit**: 5×8 anti-aliased glyph cells (max-blend coverage), invert to
  black-on-white, grayscale PNG.

Glyphs are not re-rasterized: they are **extracted from pxpipe's own
generated atlas** (`tools/gen-glyphs.mjs`), so pages are pixel-faithful to
the reference — which is what makes token parity *exact* rather than
approximate. On top of pxpipe's BMP coverage (Spleen 5×8 + Unifont) we add
the **astral planes** from GNU `unifont_upper` (16×16/8×16 1-bit bitmaps
box-filtered to the same 10×8/5×8 AA cells), so emoji and plane-1+ symbols
render instead of dropping — the one place tanuki deliberately exceeds the
reference. Only unassigned codepoints fall back to `▯`, and they're counted
and reported, never silent.

## 3. Why Rust (measured, not vibes)

The MCP is stdio: clients spawn it per session, so **startup latency and
resident memory are the product**, not just throughput. Options were
benchmarked on this machine's real workload (126 MB log distill) before
rewriting: node 4.20 s, bun 3.48 s, rust 2.44 s (2.31 s final). Go was ruled
out on regex-engine throughput; Zig/C on ecosystem risk for zero additional
win over Rust.

| metric | node reference | tanuki (rust) |
|---|---:|---:|
| distill 126 MB log | 4.21 s | **2.31 s** |
| full pipeline per level | 85 ms – 3.05 s | 59 ms – 1.97 s (**1.4–1.7×**) |
| MCP first response | ~150 ms | **~3–16 ms** |
| server RSS | 177 MB | **3 MB** |
| deployable | node + node_modules | **one ~3.3 MB static binary** |

Two implementation choices keep it light:

- **No async runtime, no MCP SDK.** Stdio MCP is newline-delimited JSON-RPC
  with four methods (`initialize`, `tools/list`, `tools/call`, `ping`) — a
  blocking read loop and `serde_json` cover it in ~80 lines. tokio would buy
  nothing for a serial stdio protocol and cost megabytes.
- **Lazy atlas.** Codepoints + wide flags load eagerly (~180 KB, needed for
  wrap math); the 6.8 MB of AA coverage stays zlib-packed (0.88 MB) inside
  the binary and inflates only on the first actual blit. `tanuki_estimate`
  computes exact page geometry without ever touching pixel data.

Honest reading: the pipeline speedup is 1.4–1.7×, not 10× — PNG deflate
dominates and both zlib implementations are good. The decisive wins are
startup (~10×), memory (~60×), and deployment (one binary).

## 4. Parity as a discipline

The node implementation didn't get deleted — it moved to
`reference/node-mcp/` and became the test oracle. Two harnesses:

- `reference/parity.mjs` — same input through both engines; asserts distill
  counts (runs, exact-tier, template-tier, important-kept) and render
  geometry (pages, image tokens).
- `reference/benchmark.mjs` — the full timed matrix (every level × every
  sample, both engines in-process, median of 3 with discarded warmup) →
  `benchmark-report.html`. Parity is asserted per row: **25/25 pass**.

Getting to *identical* (not "close") surfaced three real porting lessons:

1. **Regex class semantics.** JS `\d`/`\w`/`\b` are ASCII; the Rust `regex`
   crate defaults to Unicode-aware classes (and is much slower for them).
   Porting to explicit ASCII classes + `(?-u:\b)` fixed both a correctness
   drift *and* a 2.6× slowdown at once.
2. **`split(/\s+/)` emits empty edge tokens.** An indented line splits to
   `["", "at", …]` in JS — that leading `""` becomes `<v>` in the coarse
   template key. Rust's `split_whitespace()` doesn't do that, so indented
   and unindented twins grouped differently: a 3-line count drift on 1.6M
   lines. Replicating JS's exact split semantics made the 126 MB template
   tier byte-identical (560,779 = 560,779).
3. **Geometry is data, not code.** Extracting the atlas instead of
   re-rasterizing the fonts is what made render parity trivially exact —
   same coverage bytes in, same pixels out, same pixels/750 out.

## 5. Fidelity model (what can be trusted when)

| path | guarantee |
|---|---|
| imaging (any level 0/1) | source byte-exact reconstructable (`↵` = newline, `→` = tab, `⏎` = literal ↵) |
| distill | error/warn/exception lines verbatim; drops are counted with exact ×N; full log stays on disk |
| ladder L2–L4 | code / indented / symbol-dense / long-token lines verbatim; loss confined to prose |
| ladder L4 | prose is gist-only — never use where verbatim prose matters |
| stats | savings counted against *all* billed input (input + cache reads + cache creates) — ignoring cache reads would fake the number |

That last row is a story of its own: the first stats implementation read
non-existent fields (all zeros), and the second showed 99.6% savings by
ignoring 6.5M cache-read tokens. The honest figure was 76.5%. Every number
this project reports now names its denominator.

## 6. What we'd change with more time

- Parallelize distill's masking pass (rayon) — it's embarrassingly parallel
  per line; single-threaded was chosen for binary weight.
- A native `transform` tool (full `/v1/messages` body rewrite) — currently
  only the reference node MCP has it; tanuki covers render/estimate/
  distill/compress/stats.
- Color/class-tick render variants (pxpipe has them behind flags; the
  production dense path we ported doesn't use them).
