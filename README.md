# tanuki-context

> **⚠️ Frozen reference.** This `rust` branch is a byte/pixel-exact port held
> at parity through v0.8.x. The maintained engine is now the TypeScript npm
> package on [`main`](https://github.com/Osyna/tanuki-context/tree/main);
> features added after the freeze — recency-tiered proxy imaging, the
> credential refuse-to-render gate, brief-by-default tool descriptions, the
> slim default `tools/list` — are TS-only. Use this branch as a reference
> implementation, not for new work.

Token-cutting context pipeline as a single-binary MCP server. All Rust.
Usage below; the architecture and reasoning live in [DESIGN.md](DESIGN.md).

```
text/logs ──► stage 0: distill ──► stage 1: ladder ──► stage 2: pxpipe imaging ──► PNG pages
              (dedupe ×N, keep      (levels 0–4:         (312-col 5×8 pages, 1568×728,
               errors verbatim,      whitespace/prose/     28-px patch grid — engine name
               query slice)          dense/caveman)        kept from the pxpipe mechanic)
```

Pages are billed by Anthropic's 28×28-px patch grid — `⌈w/28⌉×⌈h/28⌉` visual
tokens per page, at most 56×26 = 1,456 for a full 1568×728 page. A full page
holds up to 28,080 chars, so dense pages reach ~19 chars per token vs ~4 for
raw text.

Rust rewrite of the [pxpipe](https://github.com/teamchong/pxpipe) MCP. Page
geometry and BMP glyphs are extracted from pxpipe's generated gray atlas
(Spleen 5×8 for ASCII/code, Unifont for CJK/Cyrillic/etc.), so pages are
pixel-faithful to pxpipe's production renderer. **Astral planes (emoji,
plane-1+ symbols) render too** — from GNU `unifont_upper`, box-filtered to the
same AA cells — which goes beyond pxpipe (it drops astral). 92,812 codepoints
total; unassigned codepoints render as readable `[U+HEX]` escapes (pxpipe
v0.11 semantics; invisible formatting codepoints blit as blank cells), so
nothing disappears silently. The atlas also carries pxpipe's v0.11 glyph
surgery: Spleen `K` repainted diagonal-legged (was Hamming-1 from `H`, the
atlas's worst confusable; K→H read-back confusions fell 42→1 upstream).

## Measured

2026-07-26, Ryzen 7 9700X, Linux. Spawn time is the median of 5 cold starts
to the first MCP response. The node reference is the original node MCP that
wraps pxpipe's library; the TS engine is the npm package on `main`.

| metric | rust | TS engine (node / bun) | node reference |
|---|---:|---:|---:|
| spawn to first response | **0.4 ms** | 35 / 27 ms | 158 ms |
| idle server RSS | **3.8 MB** | 87 / 50 MB | 177 MB |
| distill a 12 MB log | **0.28 s** | 0.42 / 0.31 s | - |
| ships as | one 5.7 MB static binary (~2.4 MB of that is rustls, for the proxy) | 0.98 MB tarball + node | node_modules tree |

Parity, asserted on every change: estimate and render JSON byte-identical to
the TS engine across all 12 knob combos, PNG pages pixel-identical, distill
counts identical, full MCP session including error paths
(`reference/parity-ts.mjs` on `main`). Pages and patch tokens also match
real pxpipe output on the default path (`reference/parity.mjs`).

## Tools (MCP, stdio)

- `tanuki_render` — `{ text, level?, distill?, query?, reflow?, pack?, font?, codebook? }` → PNG page blocks + breakdown
- `tanuki_estimate` — same args; exact page geometry, numbers only (never decompresses glyphs)
- `tanuki_distill` — stage 0 alone (logs stay text; error/warn lines always verbatim)
- `tanuki_compress` — stage 1 alone (levels 0–4; code/IDs/hashes/paths verbatim from L2 up)
- `tanuki_stats` — honest savings summary from `~/.pxpipe/events.jsonl` (env `TANUKI_EVENTS`)
- `tanuki_stash` — park text in `$TANUKI_STASH`/`~/.tanuki/stash` (content-addressed, sha256/12); returns a ~300-token map: distill stats, top repeats, first/last lines, the id
- `tanuki_fetch` — pull a slice by `query` regex or `lines "a-b"`; auto-imaged when pages win by ≥25%/300 tokens (≤6 pages), text otherwise

### Density knobs (measured, image-tokens vs the pxpipe-faithful baseline)

All lossless or legend-decodable, all off the parity path (`pack=false,
font=normal, codebook=false` = byte-identical pages to pxpipe). Tokens are
28-px patch-grid priced; reproduce with `node reference/methods-report.mjs`
→ `methods-report.html`.

| knob | what | code | prose | log |
|---|---|---:|---:|---:|
| `pack` (default on) | single-cell tabs, `⇥N` indent runs, width-trimmed pages — byte-exact | −15% | −0% | −0% |
| `+ codebook` | repeated tokens/path prefixes → 1-cell sigils + a `·legend·` line — reversible | −20% | −0% | −38% |
| `font:"tiny"` | atlas box-filtered into a 4×6 cell — experimental, 99.7% read-back accuracy | −40% | −39% | −40% |
| **all three** | stacked | **−50%** | **−39%** | **−62%** |

## CLI

```
tanuki-context                          # MCP stdio server (default)
tanuki-context proxy [--port 8484] [--upstream URL] [knobs]   # implicit middlebox
tanuki-context distill <file> [query]   # stats JSON to stdout
tanuki-context estimate <file> [level] [--distill] [--no-pack] [--font tiny] [--codebook]
tanuki-context render <file> [level] [outdir] [--no-pack] [--font tiny] [--codebook]
tanuki-context bench <file> <distill|pipeline> [level] [runs]   # in-process timing
tanuki-context stash <file>             # park text, print the map + id
tanuki-context fetch <id> [outdir] [--query re] [--lines a-b]
tanuki-context run [--query re] -- <command> [args...]   # rtk-style wrapper: distilled output inline, full capture stashed
```

## Implicit mode (proxy)

If you can't touch the client, the same binary runs as a local Anthropic
middlebox — the pxpipe deployment shape, with rules that keep the rewrite
recognizable (see [DESIGN.md](DESIGN.md)):

```
tanuki-context proxy                        # listens on 127.0.0.1:8484
export ANTHROPIC_BASE_URL=http://127.0.0.1:8484
```

On `POST /v1/messages`, oversized text blocks in user messages and tool
results are replaced **in place** by a short visible `[tanuki-context: …]`
marker plus PNG page blocks, only when `estimate` says imaging wins by a
clear margin (default: at least 25% and 300 tokens cheaper). What it never
does:

- touch the system prompt or tool definitions
- move content between roles or positions
- image the latest message (you may need to quote it)
- rewrite blocks carrying `cache_control` (that would break their cache)
- rewrite anything when text is cheaper; those requests pass byte-for-byte

Responses stream through untouched (SSE included). Savings are logged to
`~/.pxpipe/events.jsonl` (same format `tanuki_stats` reads), with the
baseline named: what Anthropic billed plus the estimated text cost of the
imaged blocks.

Knobs: `--port N` `--upstream URL` `--level 0-4` `--distill` `--codebook`
`--font tiny` `--min-chars N` `--ratio X` `--min-save N` `--max-pages N`;
env `TANUKI_UPSTREAM` overrides the default upstream. Defaults are
conservative: level 0, no distill, no codebook, normal font.

## npm package & Agent SDK (TS `main` branch)

The [`main` branch](../../tree/main) carries the same pipeline as a
zero-dependency TypeScript npm package (`npx tanuki-context`), kept at exact
numeric parity with this branch — same patch-grid token model, same
`[U+HEX]` escapes, same atlas, same proxy rules. The npm packaging and the
Claude Agent SDK glue (`tanuki-context/agent`) ship from `main` only; this
branch is for the single static binary.

## Layout

| path | role |
|---|---|
| `src/main.rs` | MCP stdio server (hand-rolled JSON-RPC, no async runtime) + CLI |
| `src/proxy.rs` | implicit mode: local Anthropic middlebox, in-place block imaging (tiny_http server, ureq/rustls client) |
| `src/distill.rs` | stage 0: 3-pass log distiller (runs/blocks ×N, exact+template near-dupes, query) |
| `src/ladder.rs` | stage 1: levels 0–4 with the exact-recall guard |
| `src/codebook.rs` | stage 0.5: repeated tokens/path prefixes → sigils + `·legend·` (opt-in, reversible) |
| `src/render.rs` | stage 2: reflow (`↵`), pack (`⇥N`/single-cell tab/width-trim), wrap, page split, AA blit, tiny 4×6 font |
| `src/atlas.rs` | full-Unicode glyph atlas (92,812 cps): codepoints/wide eager, pixels lazily inflated |
| `src/png.rs` | minimal grayscale PNG encoder (zlib via miniz_oxide) |
| `src/stats.rs` | events.jsonl summary |
| `assets/glyphs.*` | generated glyph data (35,501 codepoints, 0.4 MB packed) |
| `tools/gen-glyphs.mjs` | regenerates `assets/` from pxpipe's atlas |
| `reference/node-mcp/` | the original node implementation, kept for comparison |
| `reference/parity.mjs` | parity harness: same input through both, asserts counts/geometry |
| `reference/benchmark.mjs` | full node-vs-rust benchmark (every level, real content) → HTML report |
| `reference/methods-report.mjs` | density-knob comparison (rust-only, no pxpipe) → `methods-report.html` |

## Build & test

```
cargo build --release            # target/release/tanuki-context
node reference/parity.mjs        # rust vs node on synthetic log + a source file
node reference/parity.mjs <your-files...>
node reference/benchmark.mjs    # timed matrix + parity -> reference/benchmark-report.html
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

## Register (clients)

Install a stable binary once:

```
cargo install --git https://github.com/Osyna/tanuki-context --branch rust
# -> ~/.cargo/bin/tanuki-context
```

Any MCP client takes the same stdio entry:

```json
{ "mcpServers": { "tanuki-context": { "command": "tanuki-context", "args": [] } } }
```

- **OMP (oh-my-pi)**: put that entry in `~/.omp/agent/mcp.json` (or project `.omp/mcp.json`).
- **jcode**: `~/.jcode/mcp.json` (or project `.jcode/mcp.json`); add `"shared": true` to reuse one server across sessions.
- **Claude Code**: `claude mcp add tanuki-context -- tanuki-context`.
- **pi**: pi has no MCP layer — install the npm package as a pi extension and point it at this binary: `pi install npm:tanuki-context`, then launch pi with `TANUKI_BIN=~/.cargo/bin/tanuki-context`. The extension is a thin stdio client, so the Rust engine serves the tools; numbers are parity-locked either way.

The npm/TS engine (`npx -y tanuki-context`) drops into the same JSON entries.

## Credits

- [pxpipe](https://github.com/teamchong/pxpipe) is the origin of the idea
  and the engine: an image is billed by its pixels, not by how much text is
  inside it. This binary began as a Rust rewrite of their MCP; the page
  geometry and glyphs come from pxpipe's own generated atlas, and the
  default render path is byte-identical to their production renderer.
  Their [benchmarks](https://github.com/teamchong/pxpipe#benchmark-results-and-receipts)
  carry the read-back evidence.
- The bitmap fonts inside the atlas are
  [Spleen](https://github.com/fcambus/spleen) 5x8 by Frederic Cambus and
  [GNU Unifont](https://unifoundry.com/unifont/) (BMP plus `unifont_upper`
  for the astral planes).
