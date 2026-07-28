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

- **Your model can't read dense pages.** Imaging for comprehension needs a capable reader: Opus and the newest Sonnet solve the task off pixels (5/5 in [evals](reference/EVALS.md)), but Sonnet-4-5 and Haiku drop to 0/5. Measure yours with `npm run taskqual`, or keep it text / raise the font.
- **The exact bytes must survive.** Secrets and credentials are **auto-refused — never imaged**. Dense random strings misread silently — measured, even frontier models (Opus 4.8/5) read back just **0–1 of 14** needles byte-exact ([evals](reference/EVALS.md)) — so the `verbatim` sidecar ships ids, hashes, MACs, pod names and base64 as text beside the pages: **97%** of unrecoverable identifiers across 19.7 MB of real logs, **92.9%** against id shapes it was never designed for (`npm run coverage`, `npm run adversarial`). Exactness itself never rides on pixels at all — the stash holds the original bytes under a sha256, **19,722,893 / 19,722,893 characters recovered byte-identical** on that corpus, and `tanuki_verify` settles any value you read off a page — exact, a corrected near-miss, or absent — no model.
- **The content is small, or your bill is output-dominated.** `tanuki_stats` reports the output share so you can tell.
- **You're not on Anthropic pricing.** Pass `model` to `tanuki_estimate` for provider-correct `cost` (OpenAI tiles, Gemini tiles), overridable via `TANUKI_RATES`.

## New in 0.13.2

- **The dense gate now covers the paths that actually image.** 0.13.1 gated `tanuki_estimate` — the *advisory* path — and left both *action* paths open: `tanuki_render` imaged a needle-dense block regardless, and the proxy auto-imaged it in place. `render` now refuses like the credential gate; the proxy leaves the block as text. Pass `verbatim:false` to opt out knowingly — the refusal is about silence, not choice.
- **The counts stop overstating protection.** The sidecar header said `·verbatim· 720 exact strings (read them here…)` when 468 were carried and 252 had been dropped; the render summary and proxy marker did the same. All three now report what is carried (`468 of 720`), so the number in front of you is the number you can actually read.

## New in 0.13.1

- **Fixes a bug 0.13.0 shipped.** The sidecar cap bounded its own cost, so a needle-dense block stayed *cheap* while dropping the very ids it exists to carry — and the router happily picked `image` at `fidelity: "high"` with hundreds of values unverifiable. The cost math structurally cannot see this. `dense` is now a hard refusal, like credentials: `route` stays text and `verdict` reads `TEXT cheaper (needle-dense)`.
- **The cap is a budget, not a count.** `NEEDLE_CAP` (32…512 by line count) was arbitrary. The sidecar now grows until its text would reach half the **raw** characters it protects — the point where imaging stops paying. Measured against raw, not the compressed text, so a `codebook`/`tiny` run isn't punished for compressing well. Real-log pages flagged dense: **21/1393 → 2/1393**, coverage **97.0% → 97.6%** (1 in 7,561 at-risk chars).
- **CI gate.** `npm run adversarial -- --min 88` now fails the build if generalisation regresses; `npm run coverage -- --min 95` does the same on your own logs.

## New in 0.13

- **The sidecar stopped being an allowlist.** It matched 7 named id formats and carried **30.9%** of unrecoverable identifiers on 19.7 MB of real logs — pod names, MACs, base64 and git short shas rode as pixels silently. "Is this a known format?" has an unbounded complement; "is this token *recoverable* if one character flips?" does not. Inverting that question takes coverage to **97%**, for ~10 extra text tokens per page (~0.5% of its image cost).
- **Two new harnesses, because a coverage number you wrote the criterion for proves nothing.** `npm run coverage` scores the real engine on your own logs; `npm run adversarial` injects ids in shapes the engine was never designed around — **62.8% → 92.9%** mean catch rate. That test found the worst bug: a blanket "words are recoverable" rule was waving through *every* random alphabetic id, 0/60.
- **The cap no longer truncates silently.** A flat 32 needles per block dropped 31% of what the scanner found on 240-line pages; it now scales with the block (32…512) and overflow sets `dense` — the signal to keep that content as text.
- **The lossless spine, measured:** stash → fetch → diff over the same corpus, **19,722,893 / 19,722,893 characters byte-identical**. Pixel accuracy is not 1-in-10-million and never will be; the stash is exact by construction, so treat pages as a navigation index and settle exact values with `tanuki_verify`.

## New in 0.12

- **`recommend.text`: token savings without imaging.** `estimate` now prices the best stays-as-text cut on every call — lossless whitespace, plus a distill sibling — so the router always has a token answer, even when the verdict is TEXT (cached, small, or credential content). Widens the tool past the pxpipe pipeline into basic context optimization (the density note's Tier 0/1: delete waste before you image).
- **`route`: the hybrid pick.** A top-level `route` field now makes the call — image / text / raw — weighing real cost *and* the read-back fidelity band, not just token count. It images only when imaging clears the clean band and genuinely saves; on cached, credential, or past-the-cliff content it routes to the lossless text side. Every alternative stays priced in `recommend` for override.

## New in 0.11

- **`tanuki_verify`**: hand it a stash id and a value you read off a rendered page; it checks the original bytes on disk — `exact` (with line), `corrected` (the character you misread — a substitution or an adjacent transposition), `ambiguous`, or `absent` — with no model. Turns the silent misread into an exact match or an explicit flag; now a default tool.

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
