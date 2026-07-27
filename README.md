<div align="center">

<img src="https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/logo.png" alt="the tanuki-context logo: a pixel-art tanuki in a straw hat" width="180" />

# tanuki-context

**Pay pixels, not tokens. Bulky text enters the model as dense PNG pages, at a fraction of the price.**

[![npm](https://img.shields.io/npm/v/tanuki-context?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/tanuki-context)
[![CI](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml/badge.svg)](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-zero-3DA639?style=for-the-badge)](https://www.npmjs.com/package/tanuki-context?activeTab=dependencies)
[![license](https://img.shields.io/badge/license-MIT-8ab4f8?style=for-the-badge)](LICENSE)

</div>

AI models charge for every token they read. tanuki-context turns the bulky
parts of a conversation — logs, command output, long documents — into compact
PNG pages the same model reads for a fraction of the price. Node >= 18 or a
static Rust binary, zero dependencies either way.

It is just how pricing works: text costs about 1 token per 4 characters; an
image costs a fixed amount set by its pixel size, no matter how much text is
drawn inside it. Pack 28,000 characters into one 1568x728 page and the model
reads it for 1,456 tokens instead of ~7,000.
[pxpipe](https://github.com/teamchong/pxpipe) found how far that gap stretches;
tanuki packages it so the model itself decides when to use it, plus a proxy
mode for clients you can't change.

![a rendered page: dense 5x8-pixel text, 312 columns of system log](https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/example-page.png)

## What you save

Measured on a 200 KB slice of a real system journal (identifiers rewritten;
repetition and every error line untouched). Reproduce with `npm run tiers`.

| how the log enters the conversation | tokens |    saved |
| ----------------------------------- | -----: | -------: |
| pasted as raw text                  | 51,200 |        0 |
| drawn as image pages                | 10,752 | **-79%** |
| noise removed first, then drawn     |  5,264 | **-90%** |
| plus codebook and tiny font         |  2,576 | **-95%** |

Every row is one command on your own file — `estimate` is instant, renders
nothing, and says so when plain text would be cheaper:

```
npx tanuki-context estimate your.log 0 --distill --codebook --font tiny
```

The last two rows are **lossy on purpose** — distill drops repeat lines
(errors kept verbatim), tiny font shrinks glyphs. Measured, the ladder/distill
tiers still let a model *do the task* (find the error) while cutting up to
~93%; tiny font is the one that trades word-level legibility — use it for bulk
you won't need exact words back from. `estimate` reports a `fidelity` band per
config (mapped to DeepSeek-OCR's measured read-back curve), so you see the
cliff before you hit it. The token-vs-task curve: [reference/EVALS.md](reference/EVALS.md).

## Try it in 30 seconds

```
claude mcp add tanuki-context -- npx -y tanuki-context
```

Any MCP client: `{ "command": "npx", "args": ["-y", "tanuki-context"] }`. Or
price a file with no client at all — `--cached` flips the verdict when the
text would ride the prompt cache:

```
npx tanuki-context estimate big.log 0 --model claude-opus-4 --cached
```

## When not to reach for it

- **Your model can't read images.** Hard requirement (any current Claude qualifies).
- **The exact bytes must survive.** Secrets and credentials are **auto-refused — never imaged**. Dense random strings misread silently — measured, even frontier models (Opus 4.8/5) read back just **0–1 of 14** needles byte-exact ([evals](reference/EVALS.md)) — so the `verbatim` sidecar ships uuids/hashes/ids as text; edit-targets should stay text. Read a value off a page anyway? `tanuki_verify` checks it against the stashed original — exact, a corrected one-character misread, or absent — no model.
- **The content is small, or your bill is output-dominated.** `tanuki_stats` reports the output share so you can tell.
- **You're not on Anthropic pricing.** Pass `model` to `tanuki_estimate` for provider-correct `cost` (OpenAI tiles, Gemini tiles), overridable via `TANUKI_RATES`.

## New in 0.11

- **`tanuki_verify`**: hand it a stash id and a value you read off a rendered page; it checks the original bytes on disk — `exact` (with line), `corrected` (the single character you misread), `ambiguous`, or `absent` — with no model. Turns the silent misread into an exact match or an explicit flag; now a default tool.

## New in 0.10

- **Read-back fidelity signal**: `estimate` maps each config's imaged density to DeepSeek-OCR's measured read-back curve ([2510.18234](https://arxiv.org/abs/2510.18234)) and returns a `fidelity` band — so you see the accuracy cliff (and the 4×6 tiny-font floor) before trusting a lossy tier. Exact strings still ride the `verbatim` sidecar.

## New in 0.9

- **Recency-tiered proxy** (`--recency N`, or `TANUKI_RECENCY`): recent turns stay text and are reasoned over precisely; only distant bulk is imaged (VIST slow-fast routing).
- **Credential gate**: any block carrying an API key, private-key block, or token is never rendered to pixels — a documentation warning turned into a guarantee.
- **Lean surface**: `tools/list` advertises 3 tools by default (`TANUKI_ALL_TOOLS=1` for all 7); brief tool descriptions by default (`TANUKI_TOOL_VERBOSE=1` for the full contracts).

## More

- **[Full manual](docs/manual.md)** — three run modes, the seven tools, stash/fetch, the table knob, benchmarks, internals.
- **[Design notes](DESIGN.md)** — why each pipeline stage exists.
- **[Evals](reference/EVALS.md)** — we publish the harness, not a number: `needles` (read-back fidelity, results published), `paired` (cost per successful task), `taskqual` (task success on pages vs text).
- **[Research roadmap](docs/research-roadmap-2026-07.md)** — how tanuki maps onto DeepSeek-OCR, Glyph, and VIST.

Rust: `cargo install --git https://github.com/Osyna/tanuki-context --branch rust`
— the same engine as one static binary, held byte/pixel-exact with the npm
package by a parity harness.

MIT. The bundled glyph atlas derives from the Spleen font, GNU Unifont, and
pxpipe — see [NOTICE](NOTICE).
