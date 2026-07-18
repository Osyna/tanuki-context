# tanuki-context

[![npm](https://img.shields.io/npm/v/tanuki-context)](https://www.npmjs.com/package/tanuki-context)
Zero dependencies. 0.97 MB tarball. Runs anywhere Node >= 18 runs. MIT.

Your model pays roughly 1 token per 4 characters to read text. A rendered PNG
page prices at pixels / 750, which works out to 3+ characters per token.
tanuki-context uses that gap: it takes bulky context (logs, docs, command
output), optionally distills and compresses it, then renders it as dense PNG
pages that a vision-capable model reads at a fraction of the cost.

The same 200 KB noisy log (5,081 lines), measured:

| how it enters context            |         tokens |     saved |
| -------------------------------- | -------------: | --------: |
| pasted as raw text               |         51,130 |         0 |
| rendered as pages                |         11,106 |  **-78%** |
| distilled first, then rendered   |          1,121 |  **-98%** |
| distilled + codebook + tiny font |            656 |  **-99%** |

```
npx tanuki-context
```

## Quick start

Register it as an MCP server in any client:

```json
{ "mcpServers": { "tanuki-context": { "command": "npx", "args": ["-y", "tanuki-context"] } } }
```

Or try the CLI on one of your own files first. `estimate` is instant and tells
you up front whether the pipeline wins:

```
npx tanuki-context estimate build.log 2 --distill --codebook
# → { "imageTokens": 1087, "rawTextTokens": 51130, "verdict": "PIPELINE cheaper", ... }
npx tanuki-context render build.log 2 ./pages --codebook
# → ./pages/page0.png ...
```

## How it works

```mermaid
flowchart LR
    A[text / logs] --> B{log-shaped?}
    B -- yes --> C["stage 0: distill<br/>collapse repeats xN<br/>errors stay verbatim<br/>optional query slice"]
    B -- no --> D
    C --> D["stage 1: ladder<br/>compression level 0-4"]
    D --> E["stage 2: imaging<br/>312-col pages, 5x8 cells<br/>width-trimmed"]
    E --> F["PNG pages<br/>tokens = pixels / 750"]
```

Three stages, each optional except the last:

**Stage 0, distill.** Built for logs. Repeated lines and multi-line block
cycles collapse to one exemplar plus a `xN` count; near-duplicates that differ
only in timestamps, ids, or numbers fold into a template. Error and warning
lines never get touched. A `query` regex returns only the slice you care
about, with context. Measured on the 200 KB log above: 5,081 lines to 757,
90% fewer characters, all 440 important lines kept verbatim.

**Stage 1, the ladder.** Five compression levels, from passthrough to
telegraphic. From level 2 up an exact-recall guard keeps code, identifiers,
hashes, and paths verbatim: only prose gets shorter. Measured on wordy prose
(821 tokens):

| level | name       | loss     | what it does                                    | tokens out |
| ----: | ---------- | -------- | ----------------------------------------------- | ---------: |
|     0 | none       | none     | passthrough baseline                            |        821 |
|     1 | whitespace | lossless | trailing whitespace, blank-line runs; safe for code | 821    |
|     2 | prose      | light    | L1 + collapse spaces, cut filler phrases        |  794 (-3%) |
|     3 | dense      | medium   | L2 + drop articles and intensifiers             | 708 (-14%) |
|     4 | caveman    | heavy    | L3 + drop function words; gist only, not verbatim | 534 (-35%) |

Rule of thumb: level 1 for code, level 2 for anything you may need to quote,
level 3 for reference material, level 4 when only the gist matters.

**Stage 2, imaging.** The renderer packs text into 312-column pages of 5x8
antialiased cells (1568 x 728 px max, short pages get width-trimmed) and
encodes grayscale PNGs. Full Unicode: 92,812 codepoints including CJK,
Cyrillic, and emoji / astral planes. Unassigned codepoints fall back to `▯`
and are counted in the response, so nothing disappears silently.

### Picking a route

```mermaid
flowchart TD
    A[bulky text] --> B{is it a log?}
    B -- yes --> C[distill: on<br/>add a query regex if you<br/>only need one slice]
    B -- no --> D{will you quote it exactly?}
    C --> E[level 2 + codebook]
    D -- yes --> F[level 1]
    D -- no --> G[level 2-3]
    E --> H[estimate, then render]
    F --> H
    G --> H
```

## Density knobs

All measured against the baseline renderer, all reversible or
legend-decodable:

| knob                | what it does                                                                | code | prose |  log |
| ------------------- | --------------------------------------------------------------------------- | ---: | ----: | ---: |
| `pack` (default on) | single-cell tabs, `⇥N` indent runs, width-trimmed pages; byte-exact         | -14% |   -0% |  -0% |
| `codebook`          | repeated tokens and path prefixes become 1-cell sigils plus a `·legend·` line | -19% | -0% | -37% |
| `font: "tiny"`      | glyphs box-filtered into 4x6 cells; 99.7% read-back, skip it for exact code  | -40% |  -38% | -40% |
| all three stacked   |                                                                              | **-51%** | **-38%** | **-62%** |

## Tools (MCP, stdio)

| tool             | arguments                                                       | returns                                        |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `tanuki_render`   | `text, level?, distill?, query?, pack?, font?, codebook?`       | PNG page blocks + savings breakdown            |
| `tanuki_estimate` | same as render                                                  | exact page geometry and token math, numbers only |
| `tanuki_distill`  | `text, query?`                                                  | stage 0 alone; output stays greppable text     |
| `tanuki_compress` | `text, level`                                                   | stage 1 alone                                  |
| `tanuki_stats`    | none                                                            | savings summary from the session event log     |

`estimate` never touches pixel data, so it is safe to call on everything and
only render when the verdict says the pipeline wins.

## CLI

```
npx tanuki-context                          # MCP stdio server (default)
npx tanuki-context distill <file> [query]   # stats JSON to stdout
npx tanuki-context estimate <file> [level] [--distill] [--no-pack] [--font tiny] [--codebook]
npx tanuki-context render <file> [level] [outdir] [--no-pack] [--font tiny] [--codebook]
```

## Footprint

Measured on the same machine as the tables above:

| metric                       | tanuki-context               | pxpipe node server |
| ---------------------------- | ---------------------------- | ------------------ |
| spawn to first MCP response  | 86 ms (bun) / 106 ms (node)  | 152 ms             |
| idle server RSS              | 50 MB (bun) / 80 MB (node)   | 177 MB             |
| distill a 113 MB log         | 3.35 s                       | ~4 s               |
| install                      | 0.97 MB tarball, zero deps   | node_modules tree  |
| emoji / astral planes        | rendered                     | dropped            |

The imaging engine is a remake of [pxpipe](https://github.com/teamchong/pxpipe):
page geometry and glyphs come from pxpipe's own generated atlas (Spleen 5x8
for ASCII and code, Unifont for the rest), so pages are pixel-faithful to its
production renderer, and the default path (`pack` off, normal font) stays
byte-identical to it. Astral-plane coverage comes from GNU `unifont_upper`,
box-filtered to the same cells.

## Repository layout

| path                  | role                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `src/main.ts`         | MCP stdio server (hand-rolled JSON-RPC) + CLI                             |
| `src/distill.ts`      | stage 0: 3-pass log distiller (runs, blocks, template near-dupes, query) |
| `src/ladder.ts`       | stage 1: levels 0-4 with the exact-recall guard                           |
| `src/codebook.ts`     | repeated tokens and path prefixes to sigils plus `·legend·` (opt-in)      |
| `src/render.ts`       | stage 2: reflow, pack, wrap, page split, AA blit, tiny 4x6 font           |
| `src/atlas.ts`        | glyph atlas (92,812 codepoints): metadata eager, pixels inflated lazily   |
| `src/png.ts`          | minimal grayscale PNG encoder (`node:zlib`, filter-0 rows)                |
| `src/stats.ts`        | event log summary                                                         |
| `assets/glyphs.*`     | generated glyph data (0.4 MB packed)                                      |
| `tools/gen-glyphs.mjs`| regenerates `assets/` from pxpipe's atlas                                 |
| `reference/`          | parity and benchmark harnesses used during development                    |

Architecture notes and the reasoning behind each stage live in
[DESIGN.md](DESIGN.md).

## Build

Runs from source with Bun (`bun src/main.ts`) or as the bundled,
Node-compatible single file:

```
bun run build        # dist/cli.js (bun build --target=node --minify)
```

Regenerating glyphs after a pxpipe atlas rebuild (needs a pxpipe checkout with
`dist/` built; the generator fetches `unifont_upper` on first run):

```
PXPIPE_DIST=~/Projects/pxpipe/dist node tools/gen-glyphs.mjs
```
