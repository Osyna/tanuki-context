# tanuki-context

Token-cutting context pipeline as a single-binary MCP server. All Rust.

```
text/logs ──► stage 0: distill ──► stage 1: ladder ──► stage 2: pxpipe imaging ──► PNG pages
              (dedupe ×N, keep      (levels 0–4:         (312-col 5×8 pages, 1568×728,
               errors verbatim,      whitespace/prose/     pixel-priced — engine name kept
               query slice)          dense/caveman)        from the original pxpipe mechanic)
```

Rust rewrite of the [pxpipe](https://github.com/teamchong/pxpipe) MCP. Page
geometry and BMP glyphs are extracted from pxpipe's generated gray atlas
(Spleen 5×8 for ASCII/code, Unifont for CJK/Cyrillic/etc.), so pages are
pixel-faithful to pxpipe's production renderer. **Astral planes (emoji,
plane-1+ symbols) render too** — from GNU `unifont_upper`, box-filtered to the
same AA cells — which goes beyond pxpipe (it drops astral). 92,812 codepoints
total; only unassigned codepoints fall back to `▯` (counted + reported).

## Measured (vs the node reference, same machine)

| metric | node | tanuki (rust) |
|---|---:|---:|
| distill 126 MB log | 4.20 s | **2.44 s** |
| MCP first response | 152 ms | **3 ms** |
| server RSS | 177 MB | **~3 MB** (+2.6 MB only while rendering) |
| deployable | node + node_modules | **one ~2.6 MB static binary** |
| render parity | — | pages + tokens **exact** on all fixtures |
| distill parity | — | **identical counts** on all fixtures incl. a 126 MB log |

## Tools (MCP, stdio)

- `tanuki_render` — `{ text, level?, distill?, query?, reflow? }` → PNG page blocks + breakdown
- `tanuki_estimate` — same args; exact page geometry, numbers only (never decompresses glyphs)
- `tanuki_distill` — stage 0 alone (logs stay text; error/warn lines always verbatim)
- `tanuki_compress` — stage 1 alone (levels 0–4; code/IDs/hashes/paths verbatim from L2 up)
- `tanuki_stats` — honest savings summary from `~/.pxpipe/events.jsonl` (env `TANUKI_EVENTS`)

## CLI

```
tanuki-context                          # MCP stdio server (default)
tanuki-context distill <file> [query]   # stats JSON to stdout
tanuki-context estimate <file> [level] [--distill]
tanuki-context render <file> [level] [outdir]
```

## Layout

| path | role |
|---|---|
| `src/main.rs` | MCP stdio server (hand-rolled JSON-RPC, no async runtime) + CLI |
| `src/distill.rs` | stage 0: 3-pass log distiller (runs/blocks ×N, exact+template near-dupes, query) |
| `src/ladder.rs` | stage 1: levels 0–4 with the exact-recall guard |
| `src/render.rs` | stage 2: reflow (`↵`), wrap, page split, AA glyph blit |
| `src/atlas.rs` | full-Unicode glyph atlas (92,812 cps): codepoints/wide eager, pixels lazily inflated |
| `src/png.rs` | minimal grayscale PNG encoder (zlib via miniz_oxide) |
| `src/stats.rs` | events.jsonl summary |
| `assets/glyphs.*` | generated glyph data (35,501 codepoints, 0.4 MB packed) |
| `tools/gen-glyphs.mjs` | regenerates `assets/` from pxpipe's atlas |
| `reference/node-mcp/` | the original node implementation, kept for comparison |
| `reference/parity.mjs` | parity harness: same input through both, asserts counts/geometry |

## Build & test

```
cargo build --release          # target/release/tanuki-context
node reference/parity.mjs      # rust vs node on synthetic log + a source file
node reference/parity.mjs <your-files...>
```

Regenerating glyphs after a pxpipe atlas rebuild (requires a pxpipe checkout
with `dist/` built):

```
PXPIPE_DIST=~/Projects/pxpipe/dist node tools/gen-glyphs.mjs && cargo build --release
```

(The generator auto-downloads `unifont_upper-16.0.04.hex.gz` into `tools/data/`
on first run for the astral tier; drop the file there manually if offline.)

The reference scripts (`reference/node-mcp/compare.mjs`,
`reference/node-mcp/biglog-report.mjs`) still generate the HTML comparison
reports; they resolve pxpipe via `PXPIPE_ROOT` (default `~/Projects/pxpipe`).

## Register (MCP)

```json
{ "mcpServers": { "tanuki-context": { "command": "/path/to/tanuki-context", "args": [] } } }
```
