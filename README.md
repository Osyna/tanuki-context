# tanuki-context

Token-cutting context pipeline as a zero-dependency MCP server.
TypeScript, built with Bun, runs anywhere Node ≥18 runs:

```
npx tanuki-context
```

The original Rust implementation lives on the [`rust` branch](../../tree/rust)
(single ~2.6 MB static binary, same behavior). This branch is a 1:1 port of it —
byte-identical output, verified (see below). Architecture and reasoning live in
[DESIGN.md](DESIGN.md).

```
text/logs ──► stage 0: distill ──► stage 1: ladder ──► stage 2: pxpipe imaging ──► PNG pages
              (dedupe ×N, keep      (levels 0–4:         (312-col 5×8 pages, 1568×728,
               errors verbatim,      whitespace/prose/     pixel-priced — engine name kept
               query slice)          dense/caveman)        from the original pxpipe mechanic)
```

Remake of the [pxpipe](https://github.com/teamchong/pxpipe) MCP. Page geometry
and BMP glyphs are extracted from pxpipe's generated gray atlas (Spleen 5×8 for
ASCII/code, Unifont for CJK/Cyrillic/etc.), so pages are pixel-faithful to
pxpipe's production renderer. **Astral planes (emoji, plane-1+ symbols) render
too** — from GNU `unifont_upper`, box-filtered to the same AA cells — which goes
beyond pxpipe (it drops astral). 92,812 codepoints total; only unassigned
codepoints fall back to `▯` (counted + reported).

## Measured (same machine; node reference = pre-rewrite pxpipe MCP)

| metric | node reference | tanuki (this branch) | tanuki (rust branch) |
|---|---:|---:|---:|
| distill 113 MB log | ~4 s | **3.35 s** (bun) | 3.27 s |
| MCP spawn → first response | 152 ms | **86 ms** (bun) / 106 ms (node) | 3 ms |
| idle server RSS | 177 MB | **50 MB** (bun) / 80 MB (node) | ~3 MB |
| install | node + node_modules | **`npx tanuki-context`** (0.97 MB tarball, zero deps) | build from source |
| output parity | — | **byte/pixel-identical to rust** on all fixtures | pages + tokens exact vs pxpipe |

## Tools (MCP, stdio)

- `tanuki_render` — `{ text, level?, distill?, query?, reflow?, pack?, font?, codebook? }` → PNG page blocks + breakdown
- `tanuki_estimate` — same args; exact page geometry, numbers only (never decompresses glyphs)
- `tanuki_distill` — stage 0 alone (logs stay text; error/warn lines always verbatim)
- `tanuki_compress` — stage 1 alone (levels 0–4; code/IDs/hashes/paths verbatim from L2 up)
- `tanuki_stats` — honest savings summary from `~/.pxpipe/events.jsonl` (env `TANUKI_EVENTS`)

### Density knobs (measured, image-tokens vs the pxpipe-faithful baseline)

All lossless or legend-decodable, all off the parity path (`pack=false,
font=normal, codebook=false` = byte-identical to pxpipe).

| knob | what | code | prose | log |
|---|---|---:|---:|---:|
| `pack` (default on) | single-cell tabs, `⇥N` indent runs, width-trimmed pages — byte-exact | −14% | −0% | −0% |
| `codebook` | repeated tokens/path prefixes → 1-cell sigils + a `·legend·` line — reversible | −19% | −0% | −37% |
| `font:"tiny"` | atlas box-filtered into a 4×6 cell — experimental, 99.7% read-back accuracy | −40% | −38% | −40% |
| **all three** | stacked | **−51%** | **−38%** | **−62%** |

## CLI

```
npx tanuki-context                          # MCP stdio server (default)
npx tanuki-context distill <file> [query]   # stats JSON to stdout
npx tanuki-context estimate <file> [level] [--distill] [--no-pack] [--font tiny] [--codebook]
npx tanuki-context render <file> [level] [outdir] [--no-pack] [--font tiny] [--codebook]
```

## Register (MCP)

```json
{ "mcpServers": { "tanuki-context": { "command": "npx", "args": ["-y", "tanuki-context"] } } }
```

## Layout

| path | role |
|---|---|
| `src/main.ts` | MCP stdio server (hand-rolled JSON-RPC, serde_json-compatible serializer) + CLI |
| `src/distill.ts` | stage 0: 3-pass log distiller (runs/blocks ×N, exact+template near-dupes, query) |
| `src/ladder.ts` | stage 1: levels 0–4 with the exact-recall guard |
| `src/codebook.ts` | stage 0.5: repeated tokens/path prefixes → sigils + `·legend·` (opt-in, reversible) |
| `src/render.ts` | stage 2: reflow (`↵`), pack (`⇥N`/single-cell tab/width-trim), wrap, page split, AA blit, tiny 4×6 font |
| `src/atlas.ts` | full-Unicode glyph atlas (92,812 cps): codepoints/wide eager, pixels lazily inflated |
| `src/png.ts` | minimal grayscale PNG encoder (zlib via `node:zlib`, filter-0 rows) |
| `src/stats.ts` | events.jsonl summary |
| `assets/glyphs.*` | generated glyph data (35,501 codepoints, 0.4 MB packed) |
| `tools/gen-glyphs.mjs` | regenerates `assets/` from pxpipe's atlas |
| `reference/parity-ts.mjs` | parity harness: this port vs the rust binary — CLI JSON deep-equal, MCP replies, PNG pixels |
| `reference/parity.mjs` | original harness: rust vs pxpipe |
| `reference/node-mcp/` | the pre-rewrite node implementation, kept for comparison |

## Build & test

Everything runs from source with Bun (`bun src/main.ts`) or as the bundled,
Node-compatible single file:

```
bun install --frozen-lockfile   # nothing to install — zero deps; safe to skip
bun run build                   # dist/cli.js (bun build --target=node --minify)
```

Parity against the Rust implementation (build it from the `rust` branch first —
`git worktree add /tmp/tanuki-rust rust && cargo build --release
--manifest-path /tmp/tanuki-rust/Cargo.toml`, or set `TANUKI_BIN`):

```
node reference/parity-ts.mjs            # 76 checks: distill/estimate/render/MCP, pixel-exact PNGs
TANUKI_TS="bun src/main.ts" node reference/parity-ts.mjs   # same, unbundled
```

Regenerating glyphs after a pxpipe atlas rebuild (requires a pxpipe checkout
with `dist/` built):

```
PXPIPE_DIST=~/Projects/pxpipe/dist node tools/gen-glyphs.mjs
```
