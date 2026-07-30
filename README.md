<div align="center">

<img src="https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/logo.png" alt="the tanuki-context logo: a pixel-art tanuki in a straw hat" width="180" />

# tanuki-context

**The bulky parts of a conversation logs, dumps, command output are what you actually pay for. tanuki-context cuts those input tokens by 79–91%, keeps every byte exactly recoverable, and tells you when plain text is the cheaper call.**

[![npm](https://img.shields.io/npm/v/tanuki-context?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/tanuki-context)
[![CI](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml/badge.svg)](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-zero-3DA639?style=for-the-badge)](https://www.npmjs.com/package/tanuki-context?activeTab=dependencies)
[![license](https://img.shields.io/badge/license-MIT-8ab4f8?style=for-the-badge)](LICENSE)

**[Install](#install) · [Which model?](#which-model-should-you-use) · [What's new](CHANGELOG.md) · [Evals](reference/EVALS.md) · [Manual](docs/manual.md) · [Design notes](DESIGN.md)**

One 200 KB log pasted into a conversation costs about **51,200 input tokens**,
and you pay for it again on every turn that follows. Drawn as image pages
instead it costs **10,752** — the same log, **79% off** — and with the repeated
noise dropped first, **5,264**.

tanuki-context does that automatically and safely. Bulky text is parked in a
content-addressed stash outside the conversation; the model gets a small map and
fetches only the slices it needs; anything it reads back is checkable against the
original bytes with **no model in the loop**. Secrets are never drawn to pixels,
exact identifiers always travel as text, and the router **refuses to image when
plain text is cheaper** — which it says out loud, rather than billing you for a
conversion that never paid.

Runs as an **MCP server** the model drives itself, or as a **drop-in proxy** for
clients you cannot change. Node ≥ 18 or a static Rust binary, zero dependencies
either way.

## Install

Three ways in. All of them work with no config file and nothing to build.

### 1. As an MCP server — the model decides when to use it

```sh
claude mcp add tanuki-context -- npx -y tanuki-context
```

Any other MCP client takes the same command:

```json
{ "command": "npx", "args": ["-y", "tanuki-context"] }
```

Five tools by default — `render`, `estimate`, `stash`, `fetch`, `verify`. Set
`TANUKI_ALL_TOOLS=1` for all eight.

### 2. As a proxy — for clients you can't change

Sits on the wire and rewrites oversized blocks in place. Nothing to integrate.

```sh
npx tanuki-context proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:8484
```

It touches nothing it shouldn't: **system prompt and tools untouched**, only
oversized in-place blocks rewritten, the **most recent message always stays
text**, **secrets never imaged**, and blocks already carrying `cache_control`
left alone. It prints those rules on startup, marks the imaged prefix cacheable,
and **forwards your original bytes unchanged if anything goes wrong**.

Useful knobs: `--distill` (drop repeated log noise), `--codebook`,
`--font tiny`, `--min-chars 4000`, `--recency 1`, `--no-cache`, `--port`,
`--upstream`.

### 3. Just price a file — no client, no server

```sh
npx tanuki-context estimate your.log
```

Renders nothing, costs nothing, and tells you when plain text would be cheaper —
which, honestly, is most of the time. Add `--model claude-opus-4 --cached` to
price it against your own model with the prompt cache warm.

## Is it worth it? Read this first

**On a real 200 KB system journal, imaging cuts input tokens 79%** — and that is
the honest headline only with three caveats attached, all measured:

| | |
| --- | --- |
| Pages need a **capable reader** | 2 of 5 tested models score **0%** on a task they solve **100%** as text |
| Exact strings **never** survive pixels | **0/14** needles byte-exact on every model tested — so they ride a text sidecar instead |
| The cost case is **capped by caching** | a cached payload bills at **$0.30/Mtok**, so plain inlining wins the median by **3.5×** |

So the honest cost claim is **predictable, not cheaper**: $0.124–$0.225 across
nine runs, against inlining's $2.94 worst run. And every figure in this README is
**input-side** — with output measured at **53% of spend**, halving your input
tokens is at best a ~23% cut to the bill ([EVALS §6](reference/EVALS.md)).

Two capabilities carry no such caveats, and they are the ones worth reaching for
first:

- **Park, fetch, verify — exact by construction.** stash → fetch → diff over
  19.7 MB of real logs recovers **19,722,893 / 19,722,893 characters
  byte-identical**. `tanuki_verify` turns a one-character misread into
  `corrected` with no model call ([EVALS §7](reference/EVALS.md)).
- **Text reduction — no fidelity risk, no model dependence.** `distill` cuts a
  real pacman log **45%** and a JSON dump **94%**, output still text
  ([EVALS §4](reference/EVALS.md)).

The strongest evidence the router is well built is that **it refuses to sell
itself**: pointed at four real corpora it declined to image two — one for
credentials, one for being past the read-back cliff.

![a rendered page: dense 5x8-pixel text, 312 columns of system log](https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/example-page.png)

## Which model should you use?

Two separate questions, and conflating them is the usual mistake:
**can the model read a dense page**, and **what does that page cost on its
provider**. The second is implemented for three tile rules. The first is only
knowable by measuring, and we have measured five models.

### Read-back capability — measured, n=8 seeds

Same task, same corpus, text arm vs imaged-pages arm
([EVALS §3](reference/EVALS.md)):

| model | as text | as pages | verdict |
| --- | ---: | ---: | --- |
| `claude-opus-5` | 100% | **100%** | use pages freely |
| `claude-opus-4-8` | 88% | **88%** | use pages freely |
| `claude-sonnet-5` | 100% | **88%** | use pages freely |
| `claude-sonnet-4-5` | 100% | **0%** | **keep it text** |
| `claude-haiku-4-5` | 100% | **0%** | **keep it text** |

**Page-reading does not track how good the model is.** `claude-sonnet-4-5`
solves this task 100% of the time as text and **0%** of the time as pages, while
the older, smaller `claude-opus-4-8` manages 88% on both. There is no ordering
here you could have guessed from benchmarks or parameter counts — which is
exactly why the list below asks you to test rather than telling you what to
expect. Pass `model` to `tanuki_estimate` and it refuses to route a measured
weak reader to images at all.

### What a page costs, per provider — implemented

The same 200 KB journal, rendered once, counted by each provider's own rule:

| provider | how it counts an image | image tokens | vs Anthropic |
| --- | --- | ---: | ---: |
| Anthropic | 28 px patches | 10,528 | — |
| OpenAI | 512 px high-detail tiles, 85 + 170/tile | 10,880 | +3% |
| Google Gemini | 768 px tiles, 258/tile | **6,192** | **−41%** |
| anything else | falls back to the patch grid | 10,528 | approximate — set `TANUKI_RATES` `{"default":{...}}` |

Gemini's coarser tiles make the identical page notably cheaper to *send*. That
is a counting fact, not a comprehension one: it says nothing about whether
Gemini can read the page, which is the question above.

```sh
npx tanuki-context estimate your.log 0 --model gpt-5      # OpenAI tile rule
npx tanuki-context estimate your.log 0 --model gemini-2.5-pro
```

### Help us measure yours

These are **unmeasured**. We are not going to guess on your behalf — the table
above is the reason why.

| model | read-back |
| --- | --- |
| GPT-5 / GPT-5-mini | unmeasured |
| Gemini 2.5 Pro / Flash, Gemini 3 | unmeasured |
| GLM-4.6 / GLM-4.5V | unmeasured |
| Qwen2.5-VL, Qwen3-VL | unmeasured |
| DeepSeek-VL, Mistral, Llama vision | unmeasured |

The fixtures are committed, so testing one takes a few minutes and needs no
harness changes. The question is stored with them, verbatim:

> This service log has exactly one FATAL panic line - the root cause. Reply with
> ONLY the component name in its `component=` field (the word after
> `component=`, drop any #id).

1. **Text arm** — send `reference/task/seed-11.log` with that question.
2. **Image arm** — send `reference/task/seed-11-default/page0.png` plus the
   `verbatim.txt` beside it, same question.
3. Both should answer `vclock-merger`. Ground truth for every seed is in
   `reference/task/answers.json`; repeat across `seed-23` and `seed-37`.

A model that answers the text arm but not the image arm is a weak reader, and
belongs in the refusal list. `npm run taskqual` automates exactly this, but it
posts to the Anthropic API today, so other providers need the manual run above —
or a provider adapter, which is a welcome contribution.

**Please open an issue with what you find**, including the model id and the
seeds you ran. Measured results go into the table above and into the router's
refusal list, where they stop other people wasting money.

## Every feature, measured

One sweep, four corpora (real journald log, pacman log, JSON, TypeScript
source), current engine. `[calc]` means arithmetic at published rates, not an
end-to-end measurement. Reproduce any row from the linked eval section.

| Feature | Applies to | Tokens saved (measured) | Task / fidelity result | Verdict & comment | Evals |
| --- | --- | ---: | --- | --- | --- |
| **— text-side transforms —** | | | | | |
| `L1` whitespace | any text | **0%** on all 4 corpora | lossless | Safe no-op. Only pays on ragged or indented text. | [§4](reference/EVALS.md) |
| `L2` prose / `L3` dense | prose | **0–0.1%** | light/medium **loss** | **Not worth enabling.** Irreversible rewording for a tenth of a percent. | [§4](reference/EVALS.md) |
| `L4` caveman | prose | **0–1%** | heavy **loss** | **Not worth enabling.** Worst trade in the codebase. | [§4](reference/EVALS.md) |
| `distill` (stage 0) | logs, noisy output | **30%** log · **45%** pacman · **94%** JSON · 16% TS | keeps every error line verbatim | **Best text feature.** The only text tier that pays for itself. | [§4](reference/EVALS.md) |
| `table` (columnar) | JSON/NDJSON only | **59%** JSON · 0% elsewhere | reversible | Excellent, narrow. Keys stated once. | [§4](reference/EVALS.md) |
| `codebook` (sigils) | repeated long tokens, paths | image 5,264 → 3,808 (**−28%** off image) | reversible; confusability guard | Free win, no downside measured. | [§4](reference/EVALS.md) |
| **— imaging —** | | | | | |
| Imaging, normal font | bulk you will *read* | **85–91%** vs raw text | capable readers match their own text score (88–100%); **2 of 5 models score 0%**; exact strings **0/14** | The headline, and the only **conditional** capability here. | [§2](reference/EVALS.md), [§3](reference/EVALS.md) |
| `tiny` font (4×6) | bulk you will *never* read | **91–96%** (−40% off image) | **0/5 task**, 3/10 needle recall | Cheapest number on the page; cannot do the job. Lossy-bulk only. | [§3](reference/EVALS.md), [§4](reference/EVALS.md) |
| `distill` + imaging | navigation index | **88–100%** | **1/5 task** | Locating only, never understanding. | [§4](reference/EVALS.md) |
| **— exactness & safety —** | | | | | |
| `verbatim` sidecar | ids, hashes, MACs, base64 | **costs** ~42% of render payload | **100%** of at-risk ids over 19.7 MB; **94.5%** on never-seen shapes | Essential: it is what makes imaging safe at all. | [§7](reference/EVALS.md) |
| `verbatim: "lazy"` | cold, one-shot renders | cuts 42% of payload | **no measurable cost win**; 97% cache hit | Opt-in. Cached bytes bill at $0.30/Mtok, so cutting them saves the cheapest thing. | [§6](reference/EVALS.md) |
| `stash` | content beyond the window | n/a — a capability | **19,722,893 / 19,722,893** chars byte-identical | Flawless. Not an optimisation; a capability. | [§7](reference/EVALS.md) |
| `fetch` + match-count | slice retrieval | n/a | **retrieval precision 66.7%**; bare words reach pixels only | Essential. The match-count marker is the only text route to an aggregate answer. | [§10](reference/EVALS.md) |
| `verify` | settling a misread value | ~40 tokens | corrects one-character misreads, **no model** | Flawless backstop; covers the sidecar's residual. | [§7](reference/EVALS.md) |
| Credential gate | secrets | refuses to image | never imaged | Essential. | [§8](reference/EVALS.md) |
| Redaction on `fetch` | secrets in returned slices | n/a | **2 false positives in 166,985 lines**, both real secrets | Essential — `fetch` returned secrets as text until 0.18. | [§8](reference/EVALS.md) |
| `dense` refusal | identifier-dense pages | forces text | 2 of 1,393 pages flagged | Correct. Prevents a silently capped sidecar. | [§7](reference/EVALS.md) |
| Weak-reader gate | haiku-4-5, sonnet-4-5 | forces text | those two: 100% as text, **0% as pages** | Essential — but only fires when the caller passes `model`. | [§3](reference/EVALS.md) |
| Fidelity band | all imaging | n/a | band now agrees with outcome: good ↔ 100%, unreliable ↔ 20% | Honest since 0.19; previously called `distill` "degraded" while it solved 1/5. | [§9](reference/EVALS.md) |
| Router | every call | n/a | declined to image **2 of 4** real corpora (credentials; past the cliff) | Best evidence the engineering is sound: it refuses to sell itself. | [§5](reference/EVALS.md) |
| **— proxy —** | | | | | |
| In-request dedupe | repeated blocks | repeat → ~283-byte pointer | safe: the first copy still carries pages and sidecar | Keep. | [§6](reference/EVALS.md) |
| Cross-request reuse | — | — | **rejected**: changes the prefix and invalidates the cache it meant to save; also drops the sidecar | Built, measured, reverted. Guard test mirrored into Rust. | [§6](reference/EVALS.md) |
| `cache_control` breakpoint | multi-turn conversations | **2.1× / 3.0× / 4.7×** at 3/5/10 turns `[calc]` | byte-stable pages | Biggest cost lever found. Cache *writes* are the whole variance story (5.1×). | [§6](reference/EVALS.md) |
| Fail-open | any transform throw | n/a | survives malformed, astral-plane and null-byte bodies | Essential: a throw used to kill every in-flight call. | [§6](reference/EVALS.md) |
| **— accounting —** | | | | | |
| `textTokens` (class-weighted) | every routing decision | n/a | real content **median 3.3% / worst 16.2%**, vs `chars/4` at 38.3% / 65.6% | Fixed a 3× error in both directions. One documented bound: 239% on pure camelCase blobs. | [§9](reference/EVALS.md) |
| Output-share reporting | every workload | n/a | **output = 53.3% of spend** | **The ceiling: no input-side tool can cut more than 46.7% of the bill.** Tightens as the tool succeeds. | [§6](reference/EVALS.md) |

**Reading it in three lines.** Unconditional value: `distill` (30–94%), `table` on JSON (59%), and `stash`/`verify` (byte-exact). Conditional value: imaging at the normal font (85–91%), for a measured-capable reader, for comprehension, never for exact strings. Not worth enabling: `L2`/`L3`/`L4`, and `tiny` or `distill`+imaging when the goal is understanding.

Every percentage above is **input-side**. With output measured at 53% of spend, halving input tokens is at best a ~23% cut to the bill.

## What imaging saves

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

The last two rows are **lossy on purpose**, and measured they are lossy about
the task as well: on a capable reader the normal font holds **5/5** on the
root-cause task while cutting **76%**, `distill` drops to **1/5** and `tiny`
font to **0/5** ([EVALS §4](reference/EVALS.md)). Reach for them for bulk you
only need the gist of, not for a log you will be asked questions about.
`estimate` reports a `fidelity` band per config (mapped to DeepSeek-OCR's
measured read-back curve), and since the estimator was fitted against a real
tokenizer the band agrees with the outcome — *good* ↔ 100%, *unreliable* ↔ 20%
([EVALS §9](reference/EVALS.md)).

## When not to reach for it

- **Your model can't read dense pages.** Measured at n=8: Opus-4-8/Opus-5/Sonnet-5 match their own text score off pixels (88–100%), while Sonnet-4-5 and Haiku-4-5 score **100% as text and 0% as pages** ([evals](reference/EVALS.md)). Pass `model` to `tanuki_estimate` and it refuses to route those to images; profile your own with `TASK_MODELS=… npm run taskqual`.
- **The exact bytes must survive.** Secrets and credentials are **auto-refused — never imaged**, and **masked out of a fetched slice** (`redact:false` when you really want them). Dense random strings misread silently — measured, even frontier models (Opus 4.8/5) read back just **0–1 of 14** needles byte-exact ([evals](reference/EVALS.md)) — so the `verbatim` sidecar ships ids, hashes, MACs, pod names and base64 as text beside the pages: **97%** of unrecoverable identifiers across 19.7 MB of real logs, **92.9%** against id shapes it was never designed for (`npm run coverage`, `npm run adversarial`). Exactness itself never rides on pixels at all — the stash holds the original bytes under a sha256, **19,722,893 / 19,722,893 characters recovered byte-identical** on that corpus (fetched with `redact:false`), and `tanuki_verify` settles any value you read off a page — exact, a corrected near-miss, or absent — no model.
- **The content is small, or your bill is output-dominated.** `tanuki_stats` reports the output share so you can tell.
- **You're not on Anthropic pricing.** Pass `model` to `tanuki_estimate` for provider-correct `cost` (OpenAI tiles, Gemini tiles), overridable via `TANUKI_RATES`.

## Measured and rejected

Ideas that were built or priced and then declined. A dead end nobody records
costs the next reader a week:

- **`tiny` font as a densification lever.** 1.67× denser, and **0/5** on the
  comprehension task where the normal font scores 5/5. It stays what the
  fidelity band always called it: a lossy-bulk tier, not free tokens.
- **`verbatim: "lazy"` as the default.** The sidecar is **42%** of a render's
  tokens, so deferring it looked like the largest payload cut available.
  Measured as its own arm it halves cache writes and lifts the hit rate to
  **97%** — and saves nothing outside the noise, because a cached payload bills
  at **$0.30/Mtok**, so removing 42% of it removes 42% of the cheapest thing in
  the request. Lazy stays opt-in, and stays right for cold one-shot renders
  ([EVALS §6](reference/EVALS.md)).
- **Sidecar prefix-folding.** Factoring shared prefixes out of the carried
  strings saves **68 tokens** — not worth a second encoding both engines must
  agree on byte-for-byte.
- **Template dedup inside distill.** distill already cuts a real pacman log
  **70.9%**, above the ceiling a naive template-collapse pass was projected to
  reach.
- **In-block frequency for needle detection.** It would add **19–32 false
  needles per page** on real logs (`DISCONNECTED`, `configuration`,
  `firmware`) — enough to tip pages to `dense`, which forfeits imaging
  outright — to chase a shape with **zero instances across 19.5 MB** of real
  logs ([EVALS §7](reference/EVALS.md)).

## More

- **[Changelog](CHANGELOG.md)** — every release, with the measurement or the decision that caused it, including the ideas that were built and then rejected.
- **[Full manual](docs/manual.md)** — three run modes, the seven tools, stash/fetch, the table knob, benchmarks, internals.
- **[Design notes](DESIGN.md)** — why each pipeline stage exists.
- **[Evals](reference/EVALS.md)** — we publish the harness, not a number: `needles` (read-back fidelity, results published), `paired` (cost per successful task), `taskqual` (task success on pages vs text).
- **[Research roadmap](docs/research-roadmap-2026-07.md)** — how tanuki maps onto DeepSeek-OCR, Glyph, and VIST.

**Prior art.** [ctxdiff](https://github.com/salmanzafar949/ctxdiff) by
[@salmanzafar949](https://github.com/salmanzafar949) (Apache-2.0) — a
local-first debugger for the agent context window: content-hashed block
capture, git-style turn diffs, prompt-cache break attribution, and detection
of tool schemas you pay for on every call but never invoke. It answers *what
did the model see and what changed*; tanuki decides *what it sees at all*, so
the two compose rather than compete — run ctxdiff around an agent using tanuki
and the imaged blocks show up as ordinary diffs. Its fail-open guarantee and
schema-bloat framing are the source of the three properties audited in 0.16.1.

Rust: `cargo install --git https://github.com/Osyna/tanuki-context --branch rust`
— the same engine as one static binary, held byte/pixel-exact with the npm
package by a parity harness.

MIT. The bundled glyph atlas derives from the Spleen font, GNU Unifont, and
pxpipe — see [NOTICE](NOTICE).
