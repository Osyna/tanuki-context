# Evals

tanuki publishes the **harness, not a percentage.** A savings number nobody
can re-measure is the failure this project exists to avoid (the rakuen post
*"Token compression tools measure the wrong thing"* — this repo's own bar).
Every harness is seeded and reproducible. Below: a real API run on
**2026-07-27** across `claude-opus-4-8`, `claude-opus-5`, and `claude-fable-5`.

## 1. Pricing — `estimate --model`   *(deterministic, no vision needed)*

`estimate` prices the decision in real dollars via each provider's tile/patch
rule. A 384 KB / 4,001-line service log, for `claude-opus-4`:

| pipeline | image-tokens | vs 95,980 text | cost |
| --- | ---: | ---: | ---: |
| raw imaging | 20,160 | **-79%** | $1.44 -> $0.30 |
| distill + codebook + tiny | 112 | **-100%** | $1.44 -> $0.0017 |

```
node dist/cli.js estimate <log> 0 --model claude-opus-4 [--distill --codebook --font tiny]
```

## 2. Read-back fidelity — `npm run needles`   *(measured)*

Blind byte-exact transcription of 14 dense random needles per density (uuid,
semver, hex id, `sha256:`, `path:line:col`, base64, ms timestamp),
containment-scored:

| model | normal (5x8) | tiny (4x6) |
| --- | ---: | ---: |
| claude-opus-4-8 | 0/14 | 0/14 |
| claude-opus-5 | 1/14 | 0/14 |
| claude-fable-5 | refused | refused |

Even Opus 5, thinking for ~4.7k tokens, lands **1/14**. The misses are
**value-drift** — real single-character misreads (`8->3`, `5->9`, `a->8`,
`f->0`), delivered with full confidence, not blanks. That is the silent
failure the project is built around, and **why the `verbatim` sidecar
exists**: it ships 10/14 of these needles as text beside the pages, so
exactness never rides on transcription. Fable-5 declines the task outright
(`stop_reason: refusal`). Takeaway: dense random strings — hashes, ids,
secrets — must never be trusted to pixels (the credential gate enforces that
for secrets).

`score` also prints a char-to-char substitution tally splitting *glyph-shape*
confusions (a bigger font/higher-res tier could recover) from *value-drift*
(it can't). base64 and ms are deliberately **not** matched by the production
`scanNeedles` sidecar (a generic base64 pattern would false-positive across
normal logs and gut compression), so they ride on font fidelity alone.

## 3. Task comprehension — `npm run taskqual`   *(measured)*

The claim that matters: can the model still **do the job** from image pages?
Find the FATAL root-cause component in a 120-line log, TEXT arm vs IMAGE-pages
arm, same model, n=3 seeds:

| model | text | image |
| --- | ---: | ---: |
| claude-opus-4-8 | 3/3 | 2/3 |
| claude-opus-5 | 2/3* | 3/3 |

**Image ≈ text.** The models read the `FATAL panic ... component=<x>` line off
the pixels and name the failing component; only its random `#<hex>` id (a
needle) doesn't survive. Small n — rerun with more `TASK_SEEDS`. *one opus-5
text run truncated inside extended thinking (empty answer), not a wrong one.

The split across §2 and §3 is the whole thesis: **prose and structure survive
imaging (task ✓); byte-exact random strings do not (needles ✗ -> sidecar).**

## 4. Lossy tiers: tokens vs task — `npm run tier`   *(measured)*

Levels 2-4, `--distill`, `--codebook`, and `--font tiny` are **not** byte-
lossless - they trade fidelity for tokens. Do they keep the *task* solvable?
Same root-cause task, rendered at each tier, on `claude-opus-5` (n=2 seeds):

| tier | image-tokens | vs raw text | task solved |
| --- | ---: | ---: | ---: |
| L0 normal (near-lossless) | 896 | -76% | 2/2 |
| distill (errors kept verbatim) | 280 | -93% | 1/2 |
| L4 caveman | 896 | -76% | 2/2 |
| L0 tiny (4x6) | 560 | -85% | 0/2 |
| distill tiny | 224 | -94% | 0/2 |
| distill+codebook tiny | 224 | -94% | 1/2 |
| L4 caveman tiny | 560 | -85% | 0/2 |

The fidelity knob is **font, not ladder level**: normal-font tiers (L0,
distill, even L4 caveman) keep the task solved while cutting **76-93%** of
tokens - the FATAL line survives because distill keeps error/warn lines
verbatim and the ladder protects symbol-dense lines. `--font tiny` (4x6) is
where it breaks: the model near-reads the component, then mangles a char
(`vclock-merger` -> `clock-merger`, `merge`). **The sell:** reach for the
lossy ladder/distill freely when the model must *understand* the context, not
transcribe it - biggest cut, task intact; reserve **tiny font** for bulk you
won't need exact words back from. Small n - rerun with more `TIER_SEEDS`.

`estimate` surfaces this as a `fidelity` field — the density ratio mapped to
the DeepSeek-OCR read-back curve ([arXiv:2510.18234](https://arxiv.org/abs/2510.18234)),
with the 4x6 tiny font floored to `low` — so the tradeoff above ships as a
first-class signal, not tribal knowledge.

The deterministic backstop is `tanuki_verify`: give it a stash id and a value
you read off a page, and it checks the original bytes on disk — `exact` (with
line), `corrected` (a unique single-character neighbour — the character you
misread), `ambiguous`, or `absent`. No model, so the silent miss above becomes
a flagged one; the read-back rate is a recall floor, not a corruption risk,
once a quote is verified.

## Reproduce

```
# pricing (no key)
node dist/cli.js estimate <log> 0 --model claude-opus-4

# read-back: render sealed pages, transcribe with your model, score by containment
node reference/needle-report.mjs                                            # pages + answers.json
ANTHROPIC_API_KEY=... NEEDLE_MODELS=claude-opus-5 node reference/needle-call.mjs
#   or score a hand-made transcript: node reference/needle-report.mjs score <t.json>

# task comprehension (text arm vs image arm), your model + seeds
ANTHROPIC_API_KEY=... TASK_MODEL=claude-opus-5 npm run taskqual

# lossy tiers: deterministic token saving + task success per tier
ANTHROPIC_API_KEY=... TIER_MODEL=claude-opus-5 npm run tier
```

**Still open** (needs more budget): `npm run paired` — cost per *successful*
task over a full agent loop (tool-on vs tool-off), the one honest end-to-end
number; and larger seed/repeat counts for tighter intervals. Thinking models
need a raised `max_tokens` (both harnesses already do) or they truncate mid-
thought before answering.
