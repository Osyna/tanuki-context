# Evals

tanuki publishes the **harness, not a percentage.** A savings number nobody
can re-measure is the exact failure this project exists to avoid (the rakuen
post *"Token compression tools measure the wrong thing"* — this repo's own
bar). Every harness is seeded and reproducible.

Below is a real API run on **2026-07-28** across five models — `claude-opus-5`,
`claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`.
Where a number does not flatter the tool, it is here anyway.

## TL;DR — what's proven, what's open

- **Proven, deterministic:** imaging cuts input tokens **72–94%** on real logs;
  `estimate` prices it and the router picks the right route (§1, §5).
- **Proven, measured:** dense random strings never survive pixels —
  **0/14 byte-exact, every one of 5 models** — which is *why* the `verbatim`
  sidecar carries them as text and the credential gate refuses to image secrets
  (§2).
- **Model-dependent:** image *comprehension* needs a capable reader —
  opus-4-8 / opus-5 / sonnet-5 solve the task off pixels as well as off text;
  sonnet-4-5 and haiku-4-5 do not (§3). The fidelity band is calibrated to a
  capable reader — measure yours.
- **Open, not a win yet:** handing the tools to a fully-autonomous agent loop
  thrashes on our harness. Drive tanuki *explicitly* (estimate → render); don't
  dump the tools on the agent and hope (§6).

## 1. Pricing — `estimate --model`   *(deterministic, no vision needed)*

`estimate` prices the decision in real dollars via each provider's tile/patch
rule. Two corpora, two providers:

| corpus | raw text tokens | imaged | cut | $ text → image |
| --- | ---: | ---: | ---: | --- |
| 384 KB / 4,001-line log (opus-4) | 95,980 | 20,160 | **−79%** | $1.44 → $0.30 |
| 384 KB, distill+codebook+tiny (opus-4) | 95,980 | 112 | **−100%** | $1.44 → $0.0017 |
| 1,200-line service log (sonnet-5) | 18,525 | 3,920 | **−79%** | $0.0556 → $0.0118 |

```
node dist/cli.js estimate <log> 0 --model claude-opus-4 [--distill --codebook --font tiny]
```

## 2. Read-back fidelity — `npm run needles`   *(measured)*

Blind byte-exact transcription of 14 dense random needles per density (uuid,
semver, hex id, `sha256:`, `path:line:col`, base64, ms timestamp),
containment-scored:

| model | normal (5×8) | tiny (4×6) |
| --- | ---: | ---: |
| claude-opus-5 | 0/14 | 0/14 |
| claude-opus-4-8 | 0/14 | 0/14 |
| claude-sonnet-5 | 0/14 | 0/14 |
| claude-sonnet-4-5 | 0/14 | 0/14 |
| claude-haiku-4-5 | 0/14 | 0/14 |

**0/14 across every model.** The misses are **value-drift** — confident
single-character misreads (`3→1`, `4→a`, `5→8`, `a→3`), delivered as fact, not
blanks. That is the silent failure the project is built around, and **why the
`verbatim` sidecar exists**: it ships 10/14 of these needles as text beside the
pages, so exactness never rides on transcription — but that 10/14 is scored on
needle kinds the scanner already knows; **§7 measures what it misses on real
logs, and the answer is 69%.** (An earlier run scored
opus-5 at 1/14 — read-back of random strings is near-chance, so treat the floor
as 0–1/14, not zero-with-certainty.) `claude-fable-5` refuses the task outright
(`stop_reason: refusal`).

Takeaway: dense random strings — hashes, ids, secrets — must never be trusted
to pixels. The credential gate enforces that for secrets; `tanuki_verify` is
the deterministic backstop for anything you *do* read off a page (`exact` /
`corrected` / `ambiguous` / `absent`, no model), so a silent miss becomes a
flagged one.

`score` also splits *glyph-shape* confusions (a bigger font could recover)
from *value-drift* (it cannot). base64 and ms are deliberately **not** matched
by the production `scanNeedles` sidecar — a generic base64 pattern would
false-positive across normal logs — so they ride font fidelity alone.

## 3. Task comprehension — `npm run taskqual`   *(measured)*

The claim that matters: can the model still **do the job** from image pages?
Find the FATAL root-cause component in a 120-line log, TEXT arm vs IMAGE-pages
arm, same model, **n=5 seeds**:

| model | text | image | image reads pages? |
| --- | ---: | ---: | :---: |
| claude-opus-4-8 | 5/5 | 5/5 | ✅ |
| claude-opus-5 | 4/5 | 5/5 | ✅ |
| claude-sonnet-5 | 5/5 | 5/5 | ✅ |
| claude-sonnet-4-5 | 5/5 | **0/5** | ❌ |
| claude-haiku-4-5 | 3/5 | **0/5** | ❌ |

**Image comprehension tracks model capability.** The three capable readers
match their text score off the pixels — the whole thesis, measured: *prose and
structure survive imaging.* But sonnet-4-5 and haiku-4-5, strong on the text
arm, drop to **0/5** on image — they cannot reliably read one line out of a
dense page. They misread the panic line as a nearby word (`worker`,
`LatenciesMs`), not blanks.

This is the honest caveat behind the `fidelity` band: the DeepSeek-OCR curve it
maps to assumes a *capable* OCR reader. A smaller model underperforms the band,
so the band is an upper bound, not a promise — run this harness on the model
you actually use before trusting imaged pages for comprehension. The knob that
recovers a weak reader is **a larger font / lower density**, not a lossier
tier.

## 4. Lossy tiers: tokens vs task — `npm run tier`   *(measured)*

Levels 2–4, `--distill`, `--codebook`, `--font tiny` are **not** byte-lossless.
Do they keep the *task* solvable? Same root-cause task per tier, on a capable
reader (`claude-sonnet-5`, **n=5 seeds**):

| tier | image-tokens | vs raw text | task solved |
| --- | ---: | ---: | ---: |
| L0 normal (near-lossless) | 2,240 | −76% | **5/5** |
| L4 caveman (normal font) | 2,240 | −76% | **5/5** |
| distill (errors kept verbatim) | 728 | −92% | 1/5 |
| L0 tiny (4×6) | 1,400 | −85% | 0/5 |
| distill tiny | 560 | −94% | 1/5 |
| distill+codebook tiny | 560 | −94% | 1/5 |
| L4 caveman tiny | 1,400 | −85% | 0/5 |

The fidelity-preserving cut is **normal font**: L0 and even L4 caveman (which
telegraphs prose but keeps the FATAL line verbatim and legible) hold at 5/5
while cutting **76%**. Two knobs break the task on this reader: **tiny font**
(4×6 is past the legibility cliff — 0/5) and **distill** (reshaping the log into
a denser page drops it to 1/5, even though the FATAL line survives verbatim —
the model reads the smaller, restructured page worse). A stronger reader
(opus-class) tolerates distill better; a weaker one, worse. **The sell:** reach
for L0 or caveman at normal font for a −76% cut with the task intact; reserve
tiny font and heavy distill for bulk you only need the gist of.

## 5. The router — `estimate.route` / `recommend`   *(deterministic)*

Since 0.12.0 `estimate` returns a **`route`**: one hybrid pick (image / text /
raw) that weighs real cost **and** the read-back fidelity band **and** the
content — not just token count. It images only when imaging clears the clean
band *and* is the genuine save; it routes to the lossless text side on
credentials, cached content, or past-the-cliff density. On the 1,200-line log:

```
route: { pick: "image", fidelity: "high", savedPct: 81,
         reason: "imaging clears the read-back band and beats the text side on tokens" }
```

The same call also prices a **no-image** route (`recommend.text`): lossless
whitespace plus a distill sibling, so there is a token answer even when imaging
is the wrong call. On that log, `recommend.text.withDistill` is **100 tokens**
(distill-as-text) vs 18,525 raw — the router's answer when you must keep the
bytes as text. Every alternative is priced in `recommend` for override. The
decision is a transparent policy over measured signals, byte-identical across
the TS and Rust engines (see `reference/parity-ts.mjs`).

## 6. End-to-end: cost per successful task — `npm run paired` / `npm run trace`

The honest end number is cost per *successful* task, tool-off (log inlined) vs
tool-on (the log stashed; the agent gets a ~700-token map plus the tanuki tools
and fetches what it needs), on a 1,200-line log with `claude-sonnet-5`.

**This section previously reported that "the fully-autonomous loop is not a win
— handed the tools, a capable agent thrashes: fetching, imaging, re-fetching."
That diagnosis was wrong.** It was inferred from token counts. Tracing the loop
call-by-call (`npm run trace`) showed two ordinary bugs, neither of them about
agent discipline:

1. **`tanuki_fetch` was not in the advertised tool surface.** `tanuki_stash`
   was, and fetch is the only way to read a stash back — so the model parked
   text it could never retrieve. The trace is unambiguous: five `ToolSearch`
   calls, then *"No `tanuki_fetch` tool exists in my toolset — I searched
   exhaustively."* Every "over-fetch" token was a tool hunt.
2. **The verbatim sidecar shipped *after* the image blocks.** With fetch
   exposed, the answer was handed to the agent in the sidecar on turn 4 —
   `L21 42440ce06042` — and it re-queried six more times before finding it.
   Exact strings trailing a 12 KB PNG are easy to skip past.

Both are fixed in 0.15: fetch joins the default surface, and every emitter
(`render`, `fetch`, proxy) puts the sidecar **before** the pages.

| task | arm | before | after (0.15) |
| --- | --- | ---: | ---: |
| `upstream-502-request-id` (read an id verbatim) | on | **0/1 FAIL**, 521k in-tokens | **3/3 PASS** |
| `upstream-502-request-id` | off | 1/1 PASS | 3/3 PASS |
| `dominant-error-unit` (count across the whole log) | on | fail | **still fails** |

Cost per success on the verbatim task: **$0.215 tool-on vs $0.0257 tool-off.**
Read that with care — the off arm inlines the same log every run and is largely
served from prompt cache, which is exactly the situation §5's router already
routes to text.

**What is now true, stated narrowly:** verbatim retrieval through
stash→fetch→sidecar works reliably (3/3) where it categorically did not before.
Whole-corpus *aggregation* ("which unit logged the most errors") still fails on
the tool arm — slices cannot count what they do not see, and imaging does not
help counting. And the loop is still not a cost win against inlining a log this
size. The proven savings remain the input-side ones (§1–5) driven explicitly:
call `estimate`, read the verdict, render when it says so.

The lesson worth keeping: **a token count is a symptom, not a diagnosis.** Two
releases of narrative about agent behaviour dissolved the moment the loop was
actually traced.

## 7. Sidecar coverage on real logs — `npm run coverage` / `npm run adversarial`

The needle harness (§2) seeds uuid/semver/hex/digest/path — **the same kinds
the scanner's allowlist already matches.** So its 20/20 measured *that the two
lists agree*, not how much of a real log is protected. The miss that actually
hurt was a high-entropy string nobody wrote a regex for, riding as pixels
silently. Credit for the framing goes to a reader who spotted it; here is the
check they proposed, run on **19.7 MB of real logs** (systemd journal, kernel,
git history, pacman), plus the fix it forced.

A token counts as **at-risk** when a single-character misread would be both
*silent* and *unrecoverable*: rare (≤2 occurrences, so repetition can't
self-correct), ≥6 chars, and **not** a format recoverable from context
(durations, ISO timestamps, versions, small ints, words are all excluded).

### What the allowlist actually covered

| | before (0.12) | after (0.14) |
| --- | ---: | ---: |
| at-risk ids protected | **1,588 / 5,136 (30.9%)** | **4,568 / 4,568 (100%)** |
| unprotected at-risk chars | 4,204/million = **1 in 238** | **0** |
| needle-dense pages (refused, kept as text) | (silently truncated) | 2 / 1,374 |

Two corrections to the *measurement* were needed to state that honestly, and
both had been understating the engine: the criterion scored paths
(`dev/input/event5`) and UTC timestamps as unrecoverable ids, because `/` is in
the base64 alphabet and the ISO pattern's character class omitted `Z`; and a
**refused** block counted as a miss when a refused block stays text and is
therefore fully readable. The at-risk population changed (5,136 → 4,568) for
the first reason.

The families the allowlist could not name, ranked by misses before the fix —
the reader's three guesses (internal id, pod name, base64 chunk) were the top
three:

| missed | family |
| ---: | --- |
| 1,785 | mixed alnum id (pod name, build id, container id) |
| 617 | MAC address |
| 158 | base64 blob |
| 82 | PCI/USB id |
| 74 | hex run ≥6 (**git short sha** — the allowlist floor was 12) |

### The fix: ask the answerable question

"Is this a known id format?" has an unbounded complement — every id format
anyone will ever invent. "Is this token *recoverable* if one character flips?"
has a small, enumerable one. 0.13 inverts the classifier: ship a token unless
it is provably recoverable, using structure rather than a format list —
a long alnum run mixing letters and digits, or a long alphabetic run that is
not a word (words alternate vowels and consonants; random letters pile up).
Bias is to recall: a false positive costs a few tokens and is never wrong.

A second, independent hole compounded the first: `NEEDLE_CAP` was a flat 32
per rendered block, so **74% of 240-line pages hit it and dropped 31% of the
needles the scanner had already found** (10% at 120 lines). Better patterns
are worthless while the cap discards them.

**0.13.0 half-fixed this and shipped a worse bug.** Scaling the cap by line
count (32…512) stopped the truncation but left the cap *bounding its own
cost*: a needle-dense block therefore stayed cheap while dropping the ids the
sidecar exists to carry, and the router picked it up as a bargain —

```
720 at-risk ids | sidecar kept 120 | dropped 600 | dense=true
route: {"pick":"image", "fidelity":"high", "savedPct":65}
```

600 values unverifiable, imaged at "high" fidelity. The cost math structurally
cannot catch this, because the thing that overflowed is the thing that would
have priced it. 0.13.1 fixes both halves:

- the cap is a **budget, not a count** — the sidecar grows until its text
  would reach half the **raw** characters it protects, the point where imaging
  stops paying. Measured against raw, not the compressed text handed to the
  scanner, or a `codebook`/`tiny` run would be refused precisely for
  compressing well.
- `dense` is a **hard refusal**, ranked with credentials: `route` stays text,
  `verdict` reads `TEXT cheaper (needle-dense)`.

Real-log pages flagged dense fell **21/1393 → 2/1393** (fewer false
truncations) while the genuinely id-dense block is now correctly refused.
Cost of all this: **~10 extra text tokens per 120-line page**, about 0.5% of
that page's image cost.

### The check that cannot be a tautology — `npm run adversarial`

Coverage scored against a hand-written risk criterion still compares two lists
from the same head. So the engine is also tested against **synthetic ids in
shapes it was never designed around**, injected into real log lines:

| | 0.12 | 0.14 |
| --- | ---: | ---: |
| mean catch rate, **26 shapes × 500 draws** | **62.8%** | **94.4%** |
| pure-alphabetic random (`ryvkuvrdmg`) | **0/500** | 349/500 |
| KSUID, snowflake, ARN, JWT, dash-less UUID, IPv6, docker id, traceparent | — | **100%** |
| S3 version id, URL-safe base64, pod-style, ulid, slash-path | — | 93–100% |

This is what found the worst bug: a blanket `^[A-Za-z]+$` "words are
recoverable" rule was waving through **every** random alphabetic id, 0/500.
**Every named real-world format now scores 93–100%.**

**Residual, stated plainly:** pure-random alphabets still escape — 70–76% on
the three weakest shapes. Structure alone cannot separate `UXASIMOWMOFRUAB`
(47% vowels, longest consonant run 2) from a word without a dictionary.

Two shape-free oracles were tried and **rejected rather than shipped**:
Shannon entropy over a token's own characters measures diversity, not
unpredictability (it flags `ocean-sound-theme` and `DESIGN.md`), and bigram
surprisal against the corpus scores MACs *low* because `NN:NN` pairs are
everywhere. In-block frequency and a small word list were then costed and
declined: the residual shape has **zero instances across 19.5 MB of real
logs**, and since 0.13.1 a false positive can tip a block to `dense` and
forfeit imaging entirely — so recall-bias is no longer cheap. Chasing a
synthetic shape at that price is a bad trade; the bound is documented instead.

### What is actually exact — the lossless spine

Pixel accuracy is not, and will never be, 1-in-10-million; §2 measures 0/14
across five models. The **stash** is a different guarantee, exact by
construction rather than statistically: original bytes held under a sha256,
`tanuki_verify` checking any string against them with no model in the loop.
Measured end to end on the same corpus — stash, fetch, compare:

```
dmesg.log        218,036 bytes  BYTE-IDENTICAL
pacman.log     1,036,967 bytes  BYTE-IDENTICAL
gitlog.log     1,469,888 bytes  BYTE-IDENTICAL
journal.log   16,998,002 bytes  BYTE-IDENTICAL
== recovered byte-exact: 19,722,893 / 19,722,893 characters
```

**Zero characters dropped in 19.7 million**, and it is not a sampling result —
the bytes are addressed by hash. So for do-or-die logs the answer is not "trust
the pixels": treat the image as a navigation index over bytes that stay
recoverable in full, keep exact strings in the sidecar, and settle anything you
read off a page with `tanuki_verify`.

## Reproduce

```
# pricing (no key, deterministic)
node dist/cli.js estimate <log> 0 --model claude-opus-4

# sidecar coverage on YOUR logs (no key, runs on gigabytes) - the one to run first
bun reference/coverage-report.mjs /var/log/*.log
journalctl --no-pager -n 200000 > /tmp/j.log && bun reference/coverage-report.mjs /tmp/j.log

# generalisation: ids in shapes the engine never saw, injected into real lines
bun reference/adversarial-report.mjs            # --n 200 for tighter bounds

# the lossless spine: stash it, fetch it, diff it
ID=$(node dist/cli.js stash big.log | grep -oE '[0-9a-f]{12}' | head -1)
node dist/cli.js fetch "$ID" --lines "1-$(wc -l < big.log)" | tail -n +2 | cmp - big.log

# read-back fidelity: render sealed pages, transcribe, score by containment
node reference/needle-report.mjs                                    # pages + answers.json
ANTHROPIC_API_KEY=... NEEDLE_MODELS=claude-opus-5,claude-sonnet-5 node reference/needle-call.mjs

# task comprehension (text arm vs image arm), your model + seeds
ANTHROPIC_API_KEY=... TASK_MODEL=claude-sonnet-5 TASK_SEEDS=11,23,37,41,59 node reference/task-report.mjs

# lossy tiers: token saving (deterministic) + task success per tier
ANTHROPIC_API_KEY=... TIER_MODEL=claude-sonnet-5 TIER_SEEDS=11,23,37,41,59 node reference/tier-report.mjs

# end-to-end paired runs (the open one); costs real money, caps agent turns
node reference/paired-report.mjs --dry                              # plan only, no calls
ANTHROPIC_API_KEY=... PAIRED_MODEL=claude-sonnet-5 PAIRED_RUNS=2 node reference/paired-report.mjs
```

The 2026-07-28 run above cost ≈ **$7** of API — most of it the paired agent
loop, which is exactly why that arm is capped and run last. Thinking models
need a raised `max_tokens` (the harnesses set it) or they truncate mid-thought.
Rerun any table with more seeds/models before trusting a single delta; the
point of shipping the harness is that you don't have to trust ours.
