# Evals

tanuki publishes the **harness, not a percentage.** A savings number nobody
can re-measure is the exact failure this project exists to avoid (the rakuen
post *"Token compression tools measure the wrong thing"*: this repo's own
bar). Every harness is seeded and reproducible.

Below is a real API run on **2026-07-28** across five models: `claude-opus-5`,
`claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`.
Where a number does not flatter the tool, it is here anyway.

## TL;DR: what's proven, what's open

- **Proven, deterministic:** imaging cuts input tokens **72–94%** on real logs;
  `estimate` prices it and the router picks the right route (§1, §5).
- **Proven, measured:** dense random strings never survive pixels;
  **0/14 byte-exact, every one of 5 models**, which is *why* the `verbatim`
  sidecar carries them as text and the credential gate refuses to image secrets
  (§2).
- **Proven, 0.20, no model:** the rtk-style `run` rules remove **79%
  (weighted)** of real command-output chars with errors kept verbatim (§11);
  the `crush` knob cuts a 500-row NDJSON **94-96%** with the full set stashed
  (§12); `find` lifts retrieval precision to **73.3%** and is the only
  strategy that carries a bare-word answer as text (§10); hedge rewrites take
  hedge-dense prose at L2 from 0% to **27%** with technical prose untouched
  byte-for-byte (§13); and the routes COMPOSE - `recommend` prices selection
  through the imaging walk unprompted, taking a 500-row NDJSON the old router
  billed at 14,247 tok to **112** and fat rows from 44,804 to **1,008** (§15).
- **Model-dependent:** image *comprehension* needs a capable reader;
  opus-4-8 / opus-5 / sonnet-5 solve the task off pixels as well as off text;
  sonnet-4-5 and haiku-4-5 do not (§3). The fidelity band is calibrated to a
  capable reader; measure yours.
- **Open, not a win yet:** handing the tools to a fully-autonomous agent loop
  thrashes on our harness. Drive tanuki *explicitly* (estimate → render); don't
  dump the tools on the agent and hope (§6).

## The seam: three capabilities, one of them conditional

Every result below splits along the same line. tanuki bundles three separable
capabilities, and they do not carry equal risk.

- **A. Imaging**: characters become pixels. Every bad result in this document
  belongs to A: read-back of dense random strings (§2), the two tested models
  that score 0% on pages (§3), the tiers that break the task (§4), and the
  capped cost case (§6): prompt caching prices a stable inlined log at
  **$0.30/Mtok**, so plain inlining wins the median **3.5×**. A is conditional
  on the reader, on the content, and on the tier. §2-§4 and §6 are its
  envelope.
- **B. Stash / fetch / verify**: park bytes under a hash, retrieve slices,
  settle exact values. B has not missed a measurement: byte-identity over
  19.7 MB and sidecar coverage on the same corpus (§7), deterministic
  correction of a one-character misread with no model in the loop (§7),
  credential masking on the way out at 2 false positives in 166,985 lines
  (§8). Exact by construction, not statistically.
- **C. Text reduction**: distill, compress, table, codebook, output stays
  text. Priced on every `estimate` call as `recommend.text` (§5), on a
  denominator now measured against a real tokenizer instead of `chars / 4`
  (§9). No fidelity risk, no model dependence, nothing to read off a page.

A is the capability the tool was named for and the only one whose value is
conditional. B and C hold regardless of which model is reading. And every
figure in this document is **input-side**: whatever share of a bill is output
tokens is a ceiling no input-side tool can cross, however well it compresses.

## 1. Pricing: `estimate --model`   *(deterministic, no vision needed)*

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

## 2. Read-back fidelity: `npm run needles`   *(measured)*

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

**0/14 across every model.** The misses are **value-drift**: confident
single-character misreads (`3→1`, `4→a`, `5→8`, `a→3`), delivered as fact, not
blanks. That is the silent failure the project is built around, and **why the
`verbatim` sidecar exists**: it ships 10/14 of these needles as text beside the
pages, so exactness never rides on transcription, but that 10/14 is scored on
needle kinds the scanner already knows; **§7 measures what it misses on real
logs, and the answer is 69%.** (An earlier run scored
opus-5 at 1/14. Read-back of random strings is near-chance, so treat the floor
as 0–1/14, not zero-with-certainty.) `claude-fable-5` refuses the task outright
(`stop_reason: refusal`).

Takeaway: dense random strings (hashes, ids, secrets) must never be trusted
to pixels. The credential gate enforces that for secrets; `tanuki_verify` is
the deterministic backstop for anything you *do* read off a page (`exact` /
`corrected` / `ambiguous` / `absent`, no model), so a silent miss becomes a
flagged one.

`score` also splits *glyph-shape* confusions (a bigger font could recover)
from *value-drift* (it cannot). base64 and ms are deliberately **not** matched
by the production `scanNeedles` sidecar; a generic base64 pattern would
false-positive across normal logs, so they ride font fidelity alone.

## 3. Task comprehension: `npm run taskqual`   *(measured)*

The claim that matters: can the model still **do the job** from image pages?
Find the FATAL root-cause component in a 120-line log, TEXT arm vs IMAGE-pages
arm, same model, same corpus, **n=8 seeds**
(`TASK_MODELS=… npm run taskqual`):

| model | n | text | image | reader |
| --- | ---: | ---: | ---: | --- |
| claude-opus-4-8 | 8 | 88% | 88% | capable |
| claude-opus-5 | 8 | 100% | 100% | capable |
| claude-sonnet-5 | 8 | 100% | 88% | capable |
| claude-sonnet-4-5 | 8 | 100% | **0%** | **cannot read pages** |
| claude-haiku-4-5 | 8 | 100% | **0%** | **cannot read pages** |

**Image comprehension tracks model capability, and the split is binary.** The
three capable readers match their own text score off the pixels; the whole
thesis, measured: *prose and structure survive imaging.* sonnet-4-5 and
haiku-4-5 score **100% on the text arm and 0% on the image arm** of the same
task. Not degraded: zero. They misread the panic line as a nearby word
(`worker`, `LatenciesMs`), confidently, rather than reporting failure.

**This is no longer just a caveat; it is wired into the product.** The
`fidelity` band maps a density ratio to a DeepSeek-OCR read-back curve that
assumes a capable reader, so for these two models the band was not optimistic,
it was *wrong*: tanuki would answer `fidelity: high, route: image` to a caller
whose measured task success is 0%. Passing `model` to `tanuki_estimate` now
floors the band to `unreliable` and routes to text for any measured weak
reader.

That table is safe to pin where a model→context-window table would not be: a
model id names an **immutable snapshot**, so a measurement of one never goes
stale. The list only ever grows, and an unmeasured model is treated as capable
today's behaviour, so nothing regresses for a reader we have not tested. Run
the harness on yours before trusting pages for comprehension; the knob that
recovers a weak reader is **a larger font / lower density**, not a lossier
tier.

## 4. Lossy tiers: tokens vs task: `npm run tier`   *(measured)*

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
(4×6 is past the legibility cliff, 0/5) and **distill** (reshaping the log into
a denser page drops it to 1/5, even though the FATAL line survives verbatim;
the model reads the smaller, restructured page worse). A stronger reader
(opus-class) tolerates distill better; a weaker one, worse. **The sell:** reach
for L0 or caveman at normal font for a −76% cut with the task intact; reserve
tiny font and heavy distill for bulk you only need the gist of.

## 5. The router: `estimate.route` / `recommend`   *(deterministic)*

Since 0.12.0 `estimate` returns a **`route`**: one hybrid pick (image / text /
raw) that weighs real cost **and** the read-back fidelity band **and** the
content, not just token count. It images only when imaging clears the clean
band *and* is the genuine save; it routes to the lossless text side on
credentials, cached content, or past-the-cliff density. On the 1,200-line log:

```
route: { pick: "image", fidelity: "high", savedPct: 81,
         reason: "imaging clears the read-back band and beats the text side on tokens" }
```

The same call also prices a **no-image** route (`recommend.text`): lossless
whitespace plus a distill sibling, so there is a token answer even when imaging
is the wrong call. On that log, `recommend.text.withDistill` is **100 tokens**
(distill-as-text) vs 18,525 raw; the router's answer when you must keep the
bytes as text. Every alternative is priced in `recommend` for override. The
decision is a transparent policy over measured signals, byte-identical across
the TS and Rust engines (see `reference/parity-ts.mjs`).

## 6. End-to-end: cost per successful task: `npm run paired` / `npm run trace`

The honest end number is cost per *successful* task, tool-off (log inlined) vs
tool-on (the log stashed; the agent gets a ~700-token map plus the tanuki tools
and fetches what it needs), on a 1,200-line log with `claude-sonnet-5`.

### The ceiling on all of it: output is 53% of the bill

Read this before any other number in this file. Every saving tanuki can produce
is **input-side**, and on a measured agent run the input side is not most of the
bill:

| arm | fresh in | cache write | cache read | output tok | **output $ share** |
| --- | ---: | ---: | ---: | ---: | ---: |
| off (raw text), n=1 | 10 | 127,708 | 415,462 | 45,914 | **53.3%** |

**Output is 53.3% of modeled spend, so no input-side tool (tanuki included)
can ever cut more than 46.7% of this bill.** Output bills at $15.00/Mtok against
$0.30 for a cache read: a 50× ratio that makes 45,914 output tokens outweigh
543,180 input tokens.

Worse for the pitch, the ceiling *tightens as the tool succeeds*: cutting input
mechanically raises output's share of what remains. An arm whose input tanuki has
already shrunk has a higher output share than the raw arm, so the second half of
any saving is harder-won than the first.

This is **n=1** on the off arm (the budget stopped the run), so treat 53.3% as
an order of magnitude, not a constant, and expect it to swing with how verbose
the agent is. It is nonetheless the number that bounds every other table here,
and it went unmeasured for nine releases. `npm run paired` now reports it per
arm, and refuses to print a ceiling at all if `output_tokens` comes back zero;
otherwise the most flattering possible conclusion ("input is 100% of the bill")
would print silently.

### Rejected: reusing imaged pages across requests

If a byte-identical block is imaged in request N, why image it again in request
N+1? The proxy already collapses an in-request repeat into a short pointer, and
`ProxySession.seenBlocks` already tracks hashes across requests, and it looked like
two lines of plumbing. It was built in both engines, and it is wrong for two
independent reasons.

**It inverts the goal.** The same block sits at the same position in every later
request of a conversation. Swapping it for a pointer *changes the prefix*, so the
cache entry for everything from that block onward is invalidated and rewritten:
the exact prefix the `cache_control` breakpoint exists to hold stable. Measured
by the test that caught it: expected body ~59 KB of pages, emitted ~283 bytes of
pointer, divergence starting at message 0. Cross-request substitution does not
avoid cache writes, it causes them. In-request dedupe is safe *only* because the
pointer replaces a second occurrence while the first still carries the pages.

**It also loses the sidecar.** The pointer replaces the whole emitted block
group, `verbatim` included. In-request that is harmless; the first occurrence
still carries the sidecar above it. Across requests the sidecar vanishes with
nothing above to recover it, so every exact id the scanner extracted is gone: a
direct regression on §7's coverage, independent of caching.

So `seenBlocks` stays ledger-only, and both engines now carry a comment saying
why, because the idea is attractive enough to recur. The guard is the proxy test
**"session never changes the emitted bytes"**, which now drives three sequential
calls on a warm session and asserts all three bodies equal the session-less
body. Rust had *no* session coverage at all before this. Every Rust proxy test
passed `None`, so the same idea could have landed there alone and gone
unnoticed; that test is now mirrored.

**This section previously reported that "the fully-autonomous loop is not a win
handed the tools, a capable agent thrashes: fetching, imaging, re-fetching."
That diagnosis was wrong.** It was inferred from token counts. Tracing the loop
call-by-call (`npm run trace`) showed two ordinary bugs, neither of them about
agent discipline:

1. **`tanuki_fetch` was not in the advertised tool surface.** `tanuki_stash`
   was, and fetch is the only way to read a stash back, so the model parked
   text it could never retrieve. The trace is unambiguous: five `ToolSearch`
   calls, then *"No `tanuki_fetch` tool exists in my toolset. I searched
   exhaustively."* Every "over-fetch" token was a tool hunt.
2. **The verbatim sidecar shipped *after* the image blocks.** With fetch
   exposed, the answer was handed to the agent in the sidecar on turn 4:
   `L21 42440ce06042`, and it re-queried six more times before finding it.
   Exact strings trailing a 12 KB PNG are easy to skip past.

Both are fixed in 0.15: fetch joins the default surface, and every emitter
(`render`, `fetch`, proxy) puts the sidecar **before** the pages.

**The tradeoff that caused bug 1, priced.** The slim surface exists to save
advertised-schema tokens: a real cost, and one worth measuring rather than
assuming. Dead-schema accounting ("tool schemas you pay for on every call but
never invoke") is a first-class check in
[ctxdiff](https://github.com/salmanzafar949/ctxdiff); measured on our own
`tools/list`:

| surface | tools | tokens/request |
| --- | ---: | ---: |
| default (brief descriptions) | 5 | **549** |
| `TANUKI_ALL_TOOLS=1` | 8 | 749 |
| `TANUKI_TOOL_VERBOSE=1` | 5 | 1,250 |

Hiding three tools saves **200 tokens per request**; `tanuki_fetch` itself
costs **74**. Hiding it burned **521,000 input tokens in a single failed run**
a break-even of roughly 7,000 requests, against a workflow it made
impossible. Schema thrift is worth measuring *and* worth losing to a
capability the documented workflow depends on.


A third gap survived those two. `dominant-error-unit` ("which unit logged the
most ERROR lines") still failed, and tracing showed why: **the agent had no way
to count.** A query fetch returns a distilled, context-padded slice, so its
line count is not a match count, and nothing else reported one. Slices cannot
count what they do not show. 0.16 makes a query fetch report the raw tally:

```
[query matched 18 of 1201 lines]
```

which turns "which unit dominates" into six cheap queries. Measured:

| task | arm | before | after |
| --- | --- | ---: | ---: |
| `upstream-502-request-id` (read an id verbatim) | on | **0/1 FAIL**, 521k in-tokens | **PASS** |
| `dominant-error-unit` (count the whole log) | on | **FAIL** | **PASS** |

Both arms now solve both tasks. **The cost comparison is where this gets
interesting, and where an earlier version of this section was wrong twice.**

At n=1 the tool arm looked ~6× cheaper ($0.17 vs $1.03) and this section
called it "the first measured case where the loop beats inlining." At n=3 with
a warm cache the same comparison came out at parity ($0.171 vs $0.148). Both
were artifacts. Here is n=9 per arm, `claude-sonnet-5`, both tasks pooled:

| | inlining (off) | tanuki (on) |
| --- | ---: | ---: |
| success | 9/9 | 9/9 |
| **median cost/run** | **$0.049** | $0.173 |
| mean cost/run | $0.392 | $0.175 |
| worst run | **$2.94** | **$0.225** |
| spread (max/min) | 10–73× | **1–2×** |

**Inlining is usually cheaper, and occasionally catastrophic.** By median it
beats tanuki 3.5×: prompt caching makes re-reading an inlined log nearly free,
which is exactly the cached-content case §5's router already sends to text. But
its cost distribution has a long right tail: one `dominant-error-unit` run hit
**$2.94**, a 73× spread within a single task, because nothing bounds how often
the agent re-reads.

The tool arm's distribution is flat: **$0.124–$0.225 across nine runs**, a 2×
spread, because it ships a ~700-token map and a 40-token count instead of the
log. So the honest claim is not "cheaper"; it is **predictable**, with a worst
case 13× better ($0.225 vs $2.94). Whether that trade is worth it depends on
whether you are optimising the median bill or the tail.

A mean-only reading would have said "tanuki is 2.24× cheaper" ($0.392 vs
$0.175) and been just as misleading in the other direction: the mean is one
$2.94 run.

### What that median gap is actually made of

Prompt caching is doing the work on both sides, and the harness could not see
it: `paired-report` summed `input_tokens`, `cache_read_input_tokens` and
`cache_creation_input_tokens` into one figure. Those three are priced **$3.00 /
$0.30 / $3.75 per Mtok** on Sonnet, a 12.5× spread between the cheapest and
dearest, so one collapsed number cannot distinguish a cheap run from a cached
one, and every "why" in this section was unfalsifiable. 0.18 records them
separately and reports a cache hit rate.

With the split in place, the tail stops being mysterious
(`claude-sonnet-5`, both tasks, budget-capped mid-run):

| arm | fresh | cache **write** | cache **read** | hit rate | $/success |
| --- | ---: | ---: | ---: | ---: | ---: |
| off (inlining) | 14 | **215,673** | 529,067 | **71%** | $0.9952 |
| on (tanuki) | 24 | **42,237** | 498,953 | **92%** | $0.1955 |

Both arms read a similar volume from cache. The difference is entirely in
**cache writes (the inlining arm creates 5.1× more of them)**, at 12.5× the
price of a read. That is the $2.94 outlier's mechanism, and it is not "the
agent re-read the log" as this section previously guessed: a re-read of a
*warm* prefix is nearly free. It is that inlining a large body keeps
invalidating the prefix and paying to re-create it, while tanuki's payload is
small and byte-stable, so it stays cached (92%).

That also explains why the median and the mean disagreed so violently: the
median run is one where the off arm's cache happened to hold, the tail is one
where it churned. Compare arms at equal hit rate or the token columns are
meaningless, which is exactly what summing the three classes hid.

### Corollary: shrinking a cached payload buys almost nothing

The `verbatim` sidecar is **42% of a render's tokens** (5,611 of 13,213 on a
1,200-line service log), so `verbatim: "lazy"` (ship a one-line pointer, defer
the strings to `tanuki_fetch`/`tanuki_verify`) looked like the largest single
payload cut available. Measured as its own arm (`PAIRED_ARMS=on,lazy`,
`claude-sonnet-5`, budget-capped):

| arm | cache write | hit rate | $/success | solved |
| --- | ---: | ---: | ---: | ---: |
| on (full sidecar) | 126,687 | 94% | $0.3351 | 4/6 |
| lazy | 57,269 | **97%** | $0.3168 | 3/5 |

Lazy halves the cache writes and improves the hit rate, and the cost
difference is **inside the noise at this n**. The reason is the previous
table: once a payload is cached it is billed at **$0.30/Mtok**, so removing
42% of a *cached* payload removes 42% of the cheapest thing in the request.

**So lazy stays opt-in, not the default.** The measurement says the lever
worth pulling is keeping the cache warm, not making the payload smaller;
which inverts the intuition the sidecar-size number invites. Both arms also
failed runs on the verbatim task (the `on` arm 2 of 6), so this is not
evidence that lazy hurts recall either; it is evidence that at n=5-6 this task
is too flaky to separate them. Lazy remains the right choice for cold,
one-shot renders where nothing is cached yet.

That reframes the goal. Losing the median to inlining is not a compression
problem; it is that a re-read of an already-cached log costs almost nothing
while tanuki paid full price for its pages **every turn**. Imaged pages are the
ideal thing to cache: large, re-sent verbatim each turn, and byte-stable
(asserted in the render tests since 0.16.1). But the proxy priced caching
without ever creating it. 0.18 places one `cache_control` breakpoint on the last
imaged message:

| turns re-sending a 7,530-token page set | uncached | cached | |
| ---: | ---: | ---: | ---: |
| 3 | $0.0678 | $0.0328 | 2.1× |
| 5 | $0.1129 | $0.0373 | 3.0× |
| 10 | $0.2259 | $0.0486 | **4.7×** |

This is arithmetic at published rates, not an end-to-end measurement; the
paired run that would confirm it needs a working key and is **not yet done**.
The breakpoint counts the client's existing ones first and declines at
Anthropic's ceiling of four, so it cannot break a request that already worked.

The lesson worth keeping: **a token count is a symptom, not a diagnosis.** Two
releases of narrative about agent behaviour dissolved the moment the loop was
actually traced, and all three causes turned out to be ordinary missing
capabilities: a tool that was not advertised, a text block in the wrong order,
and no way to count.

## 7. Sidecar coverage on real logs: `npm run coverage` / `npm run adversarial`

The needle harness (§2) seeds uuid/semver/hex/digest/path, **the same kinds
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

The families the allowlist could not name, ranked by misses before the fix:
the reader's three guesses (internal id, pod name, base64 chunk) were the top
three:

| missed | family |
| ---: | --- |
| 1,785 | mixed alnum id (pod name, build id, container id) |
| 617 | MAC address |
| 158 | base64 blob |
| 82 | PCI/USB id |
| 74 | hex run ≥6 (**git short sha**, the allowlist floor was 12) |

### The fix: ask the answerable question

"Is this a known id format?" has an unbounded complement: every id format
anyone will ever invent. "Is this token *recoverable* if one character flips?"
has a small, enumerable one. 0.13 inverts the classifier: ship a token unless
it is provably recoverable, using structure rather than a format list;
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
sidecar exists to carry, and the router picked it up as a bargain;

```
720 at-risk ids | sidecar kept 120 | dropped 600 | dense=true
route: {"pick":"image", "fidelity":"high", "savedPct":65}
```

600 values unverifiable, imaged at "high" fidelity. The cost math structurally
cannot catch this, because the thing that overflowed is the thing that would
have priced it. 0.13.1 fixes both halves:

- the cap is a **budget, not a count**; the sidecar grows until its text
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

### The check that cannot be a tautology: `npm run adversarial`

Coverage scored against a hand-written risk criterion still compares two lists
from the same head. So the engine is also tested against **synthetic ids in
shapes it was never designed around**, injected into real log lines:

| | 0.12 | 0.14 |
| --- | ---: | ---: |
| mean catch rate, **26 shapes × 500 draws** | **62.8%** | **94.4%** |
| pure-alphabetic random (`ryvkuvrdmg`) | **0/500** | 349/500 |
| KSUID, snowflake, ARN, JWT, dash-less UUID, IPv6, docker id, traceparent | – | **100%** |
| S3 version id, URL-safe base64, pod-style, ulid, slash-path | – | 93–100% |

This is what found the worst bug: a blanket `^[A-Za-z]+$` "words are
recoverable" rule was waving through **every** random alphabetic id, 0/500.
**Every named real-world format now scores 93–100%.**

**Residual, stated plainly:** pure-random alphabets still escape: 70–76% on
the three weakest shapes. Structure alone cannot separate `UXASIMOWMOFRUAB`
(47% vowels, longest consonant run 2) from a word without a dictionary.

Three shape-free oracles were tried and **rejected rather than shipped**.
Shannon entropy over a token's own characters measures diversity, not
unpredictability (it flags `ocean-sound-theme` and `DESIGN.md`). Bigram
surprisal against the corpus scores MACs *low*, because `NN:NN` pairs are
everywhere. And in-block frequency ("a long alphabetic token appearing once
is likelier an id than vocabulary") was measured on the real corpus rather
than argued about:

| corpus | needles now | frequency rule would ADD |
| --- | ---: | ---: |
| journal | 39,571 | +19,135 (19/page, worst 95) |
| gitlog | 2,010 | +8,039 (32/page) |
| pacman | 7,703 | +2,776 (25/page) |

The additions are `DISCONNECTED`, `generated`, `configuration`, `firmware`,
`information`: plain vocabulary. At 19–32 false needles per page the sidecar
bloats and pages tip to `dense`, which since 0.13.1 means **imaging is refused
outright**. The rule costs the compression win to chase a shape with *zero
instances across 19.5 MB of real logs*. Declined, with numbers.

**The residual is not unprotected data, and that is testable.** A random
alphabetic id that rides as pixels is still covered by `tanuki_verify` against
the stash, measured on exactly the ids the sidecar misses:

| id | in sidecar | verify(exact) | verify(one char flipped) |
| --- | :---: | --- | --- |
| `ryvkuvrdmg` | yes | `exact` | `corrected` |
| `UXASIMOWMOFRUAB` | **no** | `exact` | `corrected` |
| `oazhseiengfosy` | **no** | `exact` | `corrected` |
| `qsYfhjBOhAqAOqRRr` | **no** | `exact` | `corrected` |

So the bound is: the sidecar carries 100% of at-risk ids on real logs and
~94% of synthetic shapes; anything it misses is still recoverable from the
stash and checkable without a model. That is the honest ceiling, not a promise
that every conceivable string rides as text.

### What is actually exact: the lossless spine

Pixel accuracy is not, and will never be, 1-in-10-million; §2 measures 0/14
across five models. The **stash** is a different guarantee, exact by
construction rather than statistically: original bytes held under a sha256,
`tanuki_verify` checking any string against them with no model in the loop.
Measured end to end on the same corpus: stash, fetch `redact:false`, compare
(the store is raw bytes either way; the default fetch masks credential-shaped
values on the way into the context window, so byte-identity is asserted with
the mask off):

```
dmesg.log        218,036 bytes  BYTE-IDENTICAL
pacman.log     1,036,967 bytes  BYTE-IDENTICAL
gitlog.log     1,469,888 bytes  BYTE-IDENTICAL
journal.log   16,998,002 bytes  BYTE-IDENTICAL
== recovered byte-exact: 19,722,893 / 19,722,893 characters
```

**Zero characters dropped in 19.7 million**, and it is not a sampling result.
the bytes are addressed by hash. So for do-or-die logs the answer is not "trust
the pixels": treat the image as a navigation index over bytes that stay
recoverable in full, keep exact strings in the sidecar, and settle anything you
read off a page with `tanuki_verify`.

## 8. Credential redaction: measured false-positive rate   *(measured)*

The credential gate has always refused to *image* a secret. It never stopped
`tanuki_fetch` from returning one as text: the same secret in the same context
window by a shorter route. 0.18 masks them on the way out.

Building it exposed that the detector had the **same flaw the sidecar
classifier had in 0.12**: nine rules, each matching a value by its own *shape*.
That works only for vendors who prefix their tokens (`AKIA…`, `ghp_…`,
`sk-ant-…`). An AWS **secret** access key is 40 characters of base64 with no
marker at all (indistinguishable from a build hash by shape), so
`AWS_SECRET_ACCESS_KEY=wJalr…` walked straight through a feature whose whole
job was to stop it. An allowlist of known shapes has an unbounded complement.

The fix is the inversion that worked before: stop asking what the value looks
like and ask what the **key** calls it. When the left side of an assignment
names a secret, the right side is one regardless of shape.

Name-based rules invite false positives, so the bounds were tuned against the
same 19.7 MB real-log corpus used for sidecar coverage (journal, dmesg, git
log, pacman: 166,985 lines). Each bound below is there because it was
*measured*, not guessed:

| rule | why | false positives removed |
| --- | --- | ---: |
| secret word must **end** the key | `systemd-ask-password-console.path: Deactivated` is a status line | 8 |
| **singular only** (no `tokens`) | `imageTokens: rev.tokens` is source code | 84 |
| value excludes **backticks** | `` const token = `frame-…` `` is a template literal | 2 |
| value must not start with `[` | otherwise it re-redacts `[redacted:aws-key]` and double-counts | n/a |

Residual: **2 hits in 166,985 lines (1 in 83,493)**, and both are real
secrets, not noise: a test fixture holding an `sk-ant-` key, and
`"x-api-key": process.env.ANTHROPIC_API_KEY`. Against a set of assignment-shaped
secrets the shape rules all miss (`AWS_SECRET_ACCESS_KEY=`, `db_password:`,
`{"client_secret": …}`, `DATABASE_PASSWORD=`) it is 4/4.

Two boundaries stated rather than hidden:

- **The mask is on `fetch`, not on the stash.** The store keeps raw bytes;
  that is what makes the 19,722,893-character byte-identity round-trip
  assertable at all, and `redact: false` returns them. The threat model is
  bytes entering a context window, not bytes on your own disk.
- **`private-key` still matches only the `BEGIN` header**, so a PEM *body*
  ships as text under a redacted header. Widening it needs the same edit in
  both engines; a second heuristic was deliberately not added, because then the
  gate and the mask could disagree about what a secret is.

A parity case pins `password=password`, where an `indexOf`-based splice masks
the key instead of the value and silently diverges between engines.

## 9. The token estimator: `npm run tokenizer`   *(measured)*

`textTokens` in `src/serde.ts` is the denominator of every decision the router
makes: the imaging gate (`cost > rawTok * ratio`), the minimum saving, the
fidelity band's ratio, and the entire saved-token ledger. It was `chars / 4`
and had never been checked against a real tokenizer.

**The error does not cancel.** Image tokens come from pixel geometry
(`w*h/750`, exact); text tokens came from a guess. Measured against
Anthropic's own tokenizer (`/v1/messages/count_tokens`, free; this whole
section cost $0), 30 samples:

| content | real chars/token | `chars/4` was |
| --- | ---: | ---: |
| prose | 4.97 | **+24% high** |
| gitlog | 2.90 | −27% low |
| stack-trace | 2.77 | −31% low |
| ts-source | 3.00 | −25% low |
| journal | 2.42 | −39% low |
| dmesg | 2.21 | −45% low |
| json | 1.92 | −52% low |
| pacman | 1.90 | −53% low |
| hex | 1.55 | −61% low |
| base64 | 1.14 | **−72% low** |

A **2.8× spread**, and it straddles zero: prose was over-priced, logs
under-priced. So tanuki declined log wins it should have taken *and* imaged
prose it should have left alone. One divisor cannot fit that, so `textTokens`
now prices character classes by how a BPE treats them: letters in a word-like
run are nearly free (~6 chars/token), letters in a vowelless or overlong run
(base64, hex, ids) fragment to well under one, digits and punctuation
fragment, whitespace mostly merges into the next word. Least squares over the
30 samples, integer per-mille weights so both engines are bit-identical.

### Held out, not fitted: the honest bound

"Worst residual 19.8%" was the *fit* on those 30 samples, which is the number a
model always flatters itself with. A second, larger and deliberately more
diverse batch of **37 measurements** (real logs, TS and Rust source, markdown,
CSV, JSON, stack traces, UUIDs, paths, mixed ids, plus synthetic extremes) was
then scored against the **shipped** weights without refitting:

| | `chars/4` | shipped estimator |
| --- | ---: | ---: |
| real content, n=30 (worst) | 65.6% | **16.2%** |
| real content (median) | 38.3% | **3.3%** |
| real logs only, n=18 (worst) | n/a | **11.6%** |
| real logs (median) | n/a | **2.7%** |
| synthetic extremes, n=7 (worst) | 71.3% | **239%** |

On the content tanuki actually routes it holds up: **median 3.3%, worst 16.2%**,
against 38.3% / 65.6% for the old divisor. On real source code specifically
(TypeScript and Rust files from this repo) it lands between −3.2% and +14.2%.

**The 239% is real and worth naming.** It is a synthetic blob of nothing but
long camelCase identifiers (`someLongCamelCaseIdentifierNumber123 = …`). Runs
over 14 characters are priced as random blobs at ~1.5 tokens/char, but a BPE
splits camelCase into known subwords, so the estimate is 3.4× too high. Real
source code never triggers it: punctuation, keywords and digits break the runs
up, but generated or machine-mangled identifier soup could.

**The obvious fix was measured and rejected.** Splitting alpha runs at
lowercase→uppercase boundaries before the word test collapses that case from
239% to −27%, and also fixes base64 (−33% → −1.6%) and solid hex (+38% → +1.8%).
But on the 30 real samples it is *worse*: median 5.7% against 3.3%. Trading a
2.4-point median regression on everything real to fix a fixture nobody will send
is the wrong trade, so the shipped weights stand and the bound is documented
instead. All weights are non-negative by construction; a negative one would
claim a character class makes text cheaper.

`test/tokens.test.ts` pins the measured counts, keeps the held-out families as
fixtures, and includes a guard asserting `chars/4` would still fail the suite;
a bound that stops discriminating is a decorative bound.

### It also re-calibrated the fidelity band

The band's 8/12/16/20 thresholds come from DeepSeek-OCR's Fox table, which
defines its ratio with a **real tokenizer**. Feeding it `chars/4` made every
ratio ~1.5× too low on logs, i.e. tanuki reported a rosier read-back band than
the density warranted. Re-running the tier sweep after the fix
(`claude-sonnet-5`, n=5):

| tier | ratio now | band says | task solved |
| --- | ---: | --- | ---: |
| L0 normal | 8.3 | good, ~90-97% | **5/5** |
| L0 tiny | 14.3 | low (tiny floor) | **0/5** |
| distill | 25 | unreliable, <60% | **1/5** |
| distill tiny | 33 | unreliable | 1/5 |
| L4 caveman | 8.3 | good | 5/5 |

Band and outcome now agree: *good* ↔ 100%, *unreliable* ↔ 20%. Under `chars/4`
distill scored a ratio near 16 and was labelled **"degraded, ~75-87%"** while
actually solving **1 task in 5**. The estimator fix removed a miscalibration
nobody had looked for.

Two offline attempts at ground truth were tried first and discarded, which is
why this waited for a key: assistant `output_tokens` from local session logs
(thinking bills to output but is not in the logged text; 161 chars against
962 tokens), and input-token deltas across turns (Claude Code elides tool
results, so the reconstruction spans 0.15–20.15 chars/token, i.e. noise).

## 10. Retrieval precision: `npm run retrieval`   *(measured, no model)*

§6 measures whether the agent *answered*, which conflates two failures needing
opposite fixes: tanuki handed back a slice without the answer, or tanuki handed
back the answer and the model fumbled it. The last run solved 4 of 6 and we
could not say which. This harness separates them, deterministically, with **no
API key and no model**; it asks only whether the ground truth came back as
**readable text**.

Three outcomes per (answer, query-strategy) pair, and the distinction is the
whole point:

- **TEXT**: the value is in a text block. Recoverable.
- **PIXELS**: it is in the slice but only on a page. Since read-back of exact
  strings is measured at **0/14** (§2), this is scored a MISS, not a success.
- **ABSENT**: not retrievable by that strategy at all.

Measured on `opsCorpus()`, five strategies × three planted answers, **identical
cell-for-cell on both engines**:

| answer | exact-substring | near-keyword | alt-keyword | line-range | find-words |
| --- | --- | --- | --- | --- | --- |
| request id `42440ce06042` | TEXT | TEXT | TEXT | TEXT | TEXT |
| version `9.4.1-rc.2` | TEXT | TEXT | TEXT | TEXT | TEXT |
| unit `ingest` | **PIXELS** | **PIXELS** | **PIXELS** | **PIXELS** | **TEXT** |

**Retrieval precision 11/15 = 73.3%** (was 8/12 = 66.7% before the fifth
strategy existed). The 4 misses are one coherent cause: the `verbatim` sidecar
carries id-, hash-, version- and path-shaped strings. **`ingest` is a bare
English word**, so none of the four 0.19 strategies ever carried it as text;
every route put it on a page only.

The fifth column is 0.20's `find` mode (free words, integer-scored windows;
prior art [context-mode](https://github.com/mksglu/context-mode), Elastic-2.0,
reimplemented independently - no floats, no FTS5, no code shared), and it is
the **only strategy that carries the unit answer as
text**: the top-ranked ERROR windows contain the `ingest` lines verbatim. It
went 3/3 - but only after this harness caught the first shipped version
routing its windows through the imaging gate (2,758 chars of windows -> 1 PNG
page -> the answer scored ABSENT). The rule is now pinned in both engines and
their test suites: **find output is never imaged.** A relevance result read
back off pixels is the exact miss this section exists to count.

**0.22: BM25 ranking.** The 3/3 above holds unchanged (the table is
byte-identical before and after). What the flat 3-points-per-word count got
wrong is a *plain-language* ask: every word scored the same, so `which request
failed with the digest mismatch` ranked the one digest line below every line
carrying `request failed`. Measured on a real 6,000-line system journal with
200 seeded asks built from a target line's rare words plus corpus-common ones:
right line first **11/200 flat, 25/200 BM25**;
one common + one rare word **0 -> 10**; pure rare-word asks tied (11 vs 11). The
journal is machine data and is not committed; the seeded noisy corpus in
`reference/gate.mjs` reproduces the effect (**0/60 flat, 60/60 BM25**) and
gates it in CI. Scores are integer micro-points, so a last-bit difference in
the two engines' `ln()` cannot reorder lines; the parity harness pins four
asks (IDF, repeated words, Unicode case and whitespace, a 27-word ask).

That resolves the §6 ambiguity precisely: **a failure on
`dominant-error-unit` is retrieval; a failure on the id or version tasks is
reasoning.** Two different bugs that had been averaging into one number.

The aggregate answer is still settleable from text, by a different route: the
`[query matched N of M lines]` marker added in 0.16. Per-unit ERROR counts come
back `ingest=16, api-gateway=5, worker=5, cache=5, scheduler=4, relay=4`, so the
marker ranks the answer first by 3.2×, and the harness asserts that ranking. If
the marker ever stops reporting raw counts, the question becomes unanswerable
from text at all.

### The control I specified was invalid, and the harness said so

The brief asked for a no-match query as the zero baseline. Measured, it scores
**2 of 3 TEXT, not 0**: distill keeps every ERROR/WARN line regardless of query,
and all three answers are planted on ERROR/WARN lines, so even a random hex
query hands both ids back. Using it as the zero baseline would have "proved" the
instrument worked while measuring nothing. It is kept and printed as a finding;
the valid zero control is a **near-miss decoy** set (`egress`, `9.4.1-rc.3`,
`42440ce06043`), which scores 0/12 and proves the classifier matches returned
bytes exactly rather than approximately.

Non-vacuity is proven by mutation, not asserted: making the classifier count any
reply containing images as TEXT (the whole-dump-grep regression) inflates
precision to 12/12 and trips two controls. Disabling the sidecar
(`TANUKI_VERBATIM=off`) drops precision to 0.0% while all four controls still
pass, which is the correct split: controls check the instrument, the gate checks
the engine.

## 11. Command-output crush: `npm run crush`   *(measured, no model)*

0.20.0 gives `tanuki-context run` an rtk-style rule table (prior art:
[rtk](https://github.com/rtk-ai/rtk), Apache-2.0): per-command noise rules,
success elision on exit 0, a never-worse guard, and the full original always
stashed. `reference/crush-report.mjs` replays **committed real command
outputs** (cargo, pytest, go, npm, git, docker, find; tsc/eslint are
realistic-shaped synthetics, marked in the manifest) through shims named after
the real tools, in BOTH engines:

| fixture | exit | rule | chars | saved | distill-only |
| --- | ---: | --- | ---: | ---: | ---: |
| cargo-test-pass | 0 | cargo | 8,062 → 909 | **89%** | 65% |
| find-list (400 lines) | 0 | list-cap | 19,548 → 873 | **96%** | 95% |
| pytest-pass | 0 | pytest | 504 → 235 | **53%** | -12% |
| git-status | 0 | git-status | 387 → 216 | **44%** | -16% |
| cargo-build-fail | 101 | cargo | 355 → 376 | -6% | -17% |
| npm-install (2 lines) | 0 | npm-install | 21 → 97 | -362% | -276% |

**Weighted over all 13 fixtures: 79% of chars removed** (32,242 → 6,631).
The honest split: elision-eligible successes save 44-96%; failures stay
near-neutral because error context is deliberately kept verbatim; tiny outputs
go negative because `run` always prints its one-line header - a fixed ~70-char
tax that only matters when the command printed less than the header. A mean of
per-fixture percentages would report that tax (-23%) instead of the answer, so
the harness reports the weighted figure and prints both columns.

Three guards make this a measurement instead of a story: the harness
byte-compares both engines on every fixture (it caught a `lines()` vs
`split("\n")` trailing-newline divergence and a Rust-only exit!=0 gap before
they shipped), it replays every fixture under a rule-less command name and
fails if the rules do not beat plain distill on at least half the success
fixtures (4/6 currently), and it fails if any exit code is not passed through.

## 12. JSON row crush: the `crush` knob   *(measured, no model)*

Headroom's SmartCrusher insight (prior art:
[headroom](https://github.com/chopratejas/headroom), Apache-2.0), fused with
tanuki's stash instead of a bespoke retrieval store: when the whole input is a
JSON array / NDJSON of ≥30 object rows, keep the first 10, the last 5 and
every IMPORTANT-matching row (error/warn/fail..., capped at 40), stash the
FULL original, and append one pointer line:

```
·crushed· kept 28 of 500 rows - full set: fetch <id> (--query re | --lines a-b)
```

Measured on a 500-row ops NDJSON (3% error rows): **33,179 → 1,881 tokens
(94%)**; with `table:true` on the kept rows, **1,294 tokens (96%)**. Nothing
is unrecoverable - the pointer names the stash id and `tanuki_fetch` takes a
regex or line range against the original 500 rows. Both engines emit the
selection and the marker byte-identically (parity ids 38-39, which also pin
the CRUSH_MIN=30 no-op boundary).

What it does NOT do: statistical anomaly detection (headroom flags >2σ numeric
outliers; that needs floats we will not put in a parity-pinned selection), and
it never fires on row sets under 30 or when selection would keep every row.

## 13. Hedge rewrites at L2+: caveman's rules   *(measured)*

tanuki L2-L4 already shared caveman's filler/function-word core (prior art:
[caveman](https://github.com/JuliusBrussee/caveman), MIT - independently
derived from the same observation, credited since the lists converged).
0.20.0 adds the part it lacked: 14 hedging/recommendation rewrites (H1-H14:
"it could potentially be worth considering that" → gone, "I'd recommend
using" → "use", "you should ensure that" → "ensure", ...), applied at L2+
before the filler pass, protected lines untouched.

Measured before/after on a hedge-dense prose fixture (the 0.19.5 published
build as the before-engine):

| level | 0.19.5 | 0.20.0 |
| --- | ---: | ---: |
| L2 prose | 0% (311 tok) | **27%** (228 tok) |
| L3 dense | 10% (281 tok) | **36%** (200 tok) |
| L4 caveman | 25% (234 tok) | **42%** (181 tok) |

The boundary, stated plainly: that fixture is hedge-dense by construction.
The control is the same comparison on this repo's README - **byte-identical
output across versions** (0%, 9,204 tok, 179 protected lines). The rules fire
on hedges, not on technical prose, so the win is real where hedges are and
exactly zero where they are not. caveman's own JetBrains number (-8.5% on 82
agentic tasks vs 65% advertised on chat prose) is the same lesson from the
other direction.

Also ported from caveman: the filename gate. `render`, `distill` and `stash`
refuse `.env*`, `id_rsa`, `*.pem`, `*credential*`, `*secret*`, `.aws/`,
`.ssh/` ... paths outright (`--allow-sensitive` overrides). Deliberately
overcautious - `secretary-notes.md` refuses too, and the tests pin that.

## 14. Proxy session diagnostics: ctxdiff's questions   *(deterministic)*

The proxy now answers three questions per request that
[ctxdiff](https://github.com/salmanzafar949/ctxdiff) (Apache-2.0) asks offline,
plus one from headroom's CacheAligner - without changing a single forwarded
byte:

- **`cacheBreak`**: every content block is hashed (sha256 of role + canonical
  JSON, 12 hex); consecutive requests are compared positionally. A pure append
  is NOT a break (that is the cache working); otherwise the first divergence
  is classified `modified` / `added` / `evicted` / `reordered` and the tokens
  from that block onward are reported as `rebilled`.
- **`toolTax`**: tools advertised in the request minus tools ever invoked in
  its own history, priced with `textTokens` - the recurring per-request cost
  of schemas the model never calls. Only reported when the request shows at
  least one `tool_use`, so first turns do not spam it.
- **`volatileSystem`**: a uuid / ISO-timestamp / JWT shape in the system
  prompt means the client busts its own prefix cache; flagged once per event.

`tanuki_stats` renders all three; the per-request stdout line appends
` · break@N kind` and ` · toolTax Ntok`. Scope stated honestly: attribution is
positional (like ctxdiff's), assumes one conversation per proxy process,
hashes the bytes AFTER imaging but BEFORE our own cache_control placement (the
breakpoint moves forward as content gets imaged; hashing it would forge a
false break on every advance), and `rebilled` counts input-side text tokens
only. This is diagnosis, not savings - no number here is ever added to a
savings figure.

Building the classifier surfaced one real bug worth recording: two IDENTICAL
consecutive requests fell through both prefix short-circuits - the TS engine
reported a bogus `modified` break at index len, the Rust engine panicked on
the same input. The Rust panic is what caught it; both engines now pin
identical-lists → no break, with the mutation guard in both test suites.

## 15. Composed routes: selection × imaging: `npm run combined`   *(measured, no model)*

Sections 11-14 measured the 0.20 text-side techniques one at a time. This
section measures what they do to the routes that already existed - the
question that matters is not "does crush work" but "does the router now find
a cheaper route than it could before, without giving anything up".

The mechanism: `recommend` prices the crush selection unprompted, exactly the
way it has always priced `table` - and then keeps composing: the kept rows go
through the same walk (columnar table × codebook) and are priced BOTH as text
and as pages. So the new selection (§12) feeds the old DeepSeek-OCR imaging
route (§1, §4), and `route.reason` names the composition whenever it beats
the picked route. The probe is pure: `crushRowsSelect` stashes nothing;
the stash happens only when a caller actually passes `crush: true`.

Measured on deterministic corpora (seeded, no model, both engines
byte-identical cell-for-cell):

| corpus | raw tok | 0.19 route would bill | crush as text | crush **+ table + pages** | saved |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500-row NDJSON, thin rows | 14,247 | 14,247 (raw) | 680 | **112** | **99%** |
| 60-row NDJSON, ~900-char rows | 44,804 | 44,804 (raw) | 14,880 | **1,008** | **98%** |
| real journal log (control) | 37,591 | 3,665 (image) | - | - | - |
| 29 rows (below CRUSH_MIN) | 649 | 649 (raw) | - | - | - |

Two rows carry the finding:

- **Thin rows**: selection alone is a 95% cut (680 tok); the old walk stacked
  on top takes it to 112. Composition is a real multiplier, not double
  counting - table restates the keys once, codebook and pages compress what
  selection kept.
- **Fat rows**: selection alone leaves 14,880 tok of text - still expensive.
  Imaging the crushed remainder is a further **14.8×** cut to 1,008. This is
  the case the composition exists for: neither technique wins alone.

The controls hold the boundaries: a real (non-row) log gets no `crush` key
and routes exactly as before, and 29 rows sit below `CRUSH_MIN` untouched -
the 0.19 replies for non-row inputs are byte-identical, which parity ids
43-45 pin across engines.

Honesty notes, so the table cannot oversell:

- `crush.imageTokens` prices pages the way `recommend.imageTokens` always
  has - the verbatim sidecar is priced separately at route time, so the two
  candidates stay comparable within one reply.
- The route's `pick` never becomes "crush": the router only picks loss
  classes it can label honestly (exact text or a banded image), and crush is
  lossy by omission with the full set stashed. The steer lives in
  `route.reason` and the priced candidate in `recommend.crush`; the caller
  opts in with `crush: true`.
- Purity is asserted non-vacuously: the harness counts stash entries after
  every estimate (0) and then proves the counter works by calling
  `{crush: true}` and seeing exactly 1.

Reproduce: `npm run combined` (add `TANUKI_BIN=<rust binary>` for the
cross-engine comparison; without it the parity line honestly reports
`n/a (single engine - nothing was compared)`).

## 16. Find vocabulary gaps, run-rule shapes and delta   *(measured, no model)*

### Vocabulary gaps: `node reference/retrieval-report.mjs`

BM25 (§10) cannot find an answer that shares no word with the ask: "why did the
service crash" against `FATAL panic: invariant violated in shard-router`. 0.23
adds a fixed table of log synonyms (15 symmetric groups, about 110 words: crash /
panic / fatal / abort, slow / latency / timeout / deadline, fail / error /
exception, auth / 401 / bearer / unauthorized, disk / enospc, and so on) and
light stemming (plural, `-ed`, `-ing`, `-er`, never below 3 characters). An ask
word that has no direct hit on a line but a synonym or stem hit counts at **half**
a direct hit, with tf pinned to 1, so an expansion can tie a direct hit at best
and never adds onto one. Each `·find·` header now ends with the matched ask words;
`~` marks a synonym or stem hit (`· panic, crash~`).

The set is committed: `VOCAB_GAP` in `reference/lib/corpus.mjs`, 24 asks over 624
lines whose noise repeats common ask words as decoys. A control in the report
fails if any gold line shares a whole word (or a 4+ character substring) with its
ask, so the set stays a vocabulary-gap set.

| set | 0.22.1 hit@1 / MRR | 0.23.0 hit@1 / MRR |
| --- | ---: | ---: |
| `VOCAB_GAP`, written alongside the table | 0/24 · 0.000 | **19/24** · 0.854 |
| `VOCAB_GAP_HELDOUT`, written blind to the table | 1/24 · 0.042 | **3/24** · 0.201 |

**The 19/24 is fitted.** The same hand wrote the table and the first set. A second
set of 24 asks, written without seeing the table (same noise generator, another
seed), moves from 1/24 to 3/24: the hits are a full disk, a locked-out login and
a configuration change; 18 asks rank nowhere in the printed windows. One held-out
ask (`leaked file handles`) shares `file` with `EMFILE` in its gold line; the
report's guard flags it, and it misses on both engines. Read the table as a small
hand-made list that helps when an ask happens to use its words, not as a thesaurus.

Nothing dropped. The seeded find set of §10 stays 60/60 (MRR 1.000), the retrieval
report 11/15. A rebuilt journal benchmark (a `journalctl -n 6000` snapshot, 188
asks of 2 rare + 2 common words; the original 25/200 script is not in the tree, and
this one is easier) ranks identically ask by ask on both engine versions, 154/188.
Twenty asks sharing a rare literal (an id, an error code, a host) with their answer:
20/20 before and after; with decoys added 18/20 before, 20/20 after. No synonym
expansion outranked a literal hit. The gate holds `find.vocab_gap_hit1_of_24` and
`find.vocab_gap_mrr_permille` (the fitted set: a regression guard, not a claim).

### 0.23 run rules on real captures

Each fixture under `reference/crush/` is a real capture (kubectl from a k3s node,
terraform with random/local/null/time providers, both in aisandbox instances;
cargo and node locally). `node reference/crush-report.mjs --min 60` runs both
engines on all of them. Chars are the routed answer; tokens are o200k.

| fixture (rule) | raw chars | 0.22.1 answer | 0.23 answer | 0.22.1 tokens | 0.23 tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| cargo-test-json (`cargo+ndjson`) | 3,663 | 2,258 | 1,777 | 765 | 545 |
| ps-aux (`table`) | 1,622 | 1,336 | 1,051 | 597 | 531 |
| df-h (`table`) | 738 | 929 | 741 | 392 | 345 |
| docker-ps (`table`) | 767 | 824 | 560 | 247 | 240 |
| kubectl-get-pods (`table`) | 954 | 744 | 525 | 233 | 216 |
| kubectl-get-yaml (`managedfields`) | 29,863 | 2,847 | 572 | 839 | 205 |
| kubectl-get-json (`managedfields`) | 57,891 | 3,763 | 476 | 620 | 178 |
| terraform-plan | 8,450 | 2,818 | 2,236 | 858 | 661 |
| terraform-plan-noop | 6,085 | 927 | 352 | 267 | 80 |
| terraform-plan-fail | 6,580 | 1,211 | 475 | 391 | 136 |
| terraform-apply-change | 9,715 | 3,752 | 3,152 | 1,227 | 1,006 |

Weighted over all 29 fixtures: 79.9 % of chars removed under 0.22.1, **83.9 %**
now (gate `crush.weighted_saved_permille` 799 -> 839; in o200k tokens 845 permille).
The lossless rules were checked for content: a table keeps the whitespace-normalised
text of every line (asserted on four real fixtures and twelve local commands:
`docker images/ps -a`, `lsblk`, `ss -tln`, `ps aux`, `pip list`, `lscpu`, `df -h`);
managedFields blocks are replaced by one marker and everything else replays
byte-exact against the input; terraform keeps every `#`/`+`/`-`/`~` line, the
`Plan:` summary and every error, ANSI included. About 2,300 random inputs
(seven seeds) run through both engines produced no divergence after one fix
(whitespace-only output reported `rule generic` in TS only).

**A regression the first version of the kubectl rule had, and its fix.** Dropping
managedFields made the 505-line YAML small enough to hand back inline: 7,327
chars and 2,478 tokens, against the 2,847 chars / 839 tokens 0.22.1 had answered
(its list-cap showed the first 200 raw lines). More useful to a reader, but a
larger answer than before, and the gate rows `out_chars` / `out_tokens` said so.
The rule now compares against what the run wrapper answered without it (the
never-grow yardstick) and falls back to the stash map when the inline document
would be bigger, with the map's line counts, repeats and first/last lines taken
from the cleaned document (`distill map (managedFields dropped): ...`), not from
the bookkeeping. `crush.kubectl_yaml_chars_vs_0_22_1` carries a hard limit of
2,847. Limits: the stash still holds the raw capture, so a `fetch` slice of the
JSON contains managedFields; kubectl output WITHOUT managedFields is still capped
at 200 lines by the older list-cap rule (lossy; the stash keeps everything).

### Delta between runs

Second run of the same command in one stash (`routeOutput`, both engines
byte-identical): a run whose output leads with what changed against the previous
run, and blocks identical to it collapsed into pointers.

| pair (real `cargo test` / `node --test`) | run 2 raw | run 2 alone | run 2 after run 1 | o200k alone -> after |
| --- | ---: | ---: | ---: | ---: |
| cargo test: 1 failure fixed, 1 new, 2 unchanged | 2,047 | 1,777 | 1,478 | 508 -> 430 |
| npm test x2, identical modulo timings | 2,353 | 2,412 | 212 | 855 -> 78 |

The npm pair reads `output identical` plus one pointer (88 % saved against -3 % for
the run alone); a failing run followed by a 95-char passing run leads with
`exit 101 -> 0 · 3 fixed · 0 new` and the three test names. Limits: unchanged blocks
are compared as sets of normalised lines, so a change that only touches a masked
token (a timestamp, a duration with its unit, a 6+ hex-digit `0x` address, a test
thread id in `thread 'x' (N)`) reads as identical; any other number, a count in
parentheses included, is content (tested: `(1204 items)` -> `(1205 items)` shows
as a change). Fixed/new lists use test-runner vocabulary. Every routed run of 400+
chars is now stashed (content-addressed, so identical bytes dedupe) plus a
20-byte index file per command. Both engines cap the stash's own entries at
`TANUKI_STASH_MAX_MB` (default 512): after each write, oldest mtime first, down to
75 % of the cap, never the entry just written, `runs/` and foreign files untouched.
The scan costs about 1 ms per 1,000 entries (4.8 ms at 5,000, 53 ms at 50,000).

The gate holds `crush.new_rules_fired_of_12`, `delta.cargo-test.second_run_chars`,
`delta.npm-test.second_run_chars` (and their o200k tokens) and that the second run
leads with a delta block.

## 17. Comparison with rtk and context-mode   *(measured, small sample)*

`reference/compare-report.mjs` (method and sandbox recipe in its header) runs
[rtk](https://github.com/rtk-ai/rtk) v0.50.0 and
[context-mode](https://github.com/mksglu/context-mode) 1.0.169 on the committed
`reference/crush/` captures and scores each tool's output in o200k tokens and by
**planted-answer survival**: 1-5 strings per fixture, chosen as content rather
than layout and verified present in the raw bytes (a spelling list where a tool
legitimately says the same thing another way, e.g. rtk's `84 passed` against
`82 passed` + `2 passed`). Everything was installed inside a throwaway aisandbox
instance (context-mode with Bun, since `npm i -g` refuses Node 20), never on the
host. Replay: tanuki via `run -- <cmd>` through a shim named after the tool (the
production path); rtk via `rtk pipe -f <filter>` where it has one, else through
the same shim; context-mode via `ctx_execute(intent=question)` and
`ctx_batch_execute(queries=[question])`, a fresh server per call. Tanuki figures
here are from the 0.22.1 bundle measured at the time; 12 of the committed
fixtures have questions (the 0.23 fixtures are not scored).

**Faithful replay only** (9 of 12 fixtures: every tool saw the format it asks its
child for):

| tool | o200k tokens out | saved vs raw | answers kept | fixtures with every answer |
| --- | ---: | ---: | ---: | ---: |
| raw (no tool) | 8,362 | - | 26/26 | 9/9 |
| tanuki-context `run` | 1,561 | 81 % | 24/26 | 8/9 |
| rtk | **1,045** | **88 %** | 21/26 | 7/9 |
| context-mode `ctx_execute` + intent | 1,886 | 77 % | 22/26 | 7/9 |
| context-mode `ctx_batch_execute` | 3,878 | 54 % | 24/26 | 8/9 |

Fewest tokens among the arms that kept every answer: rtk on 5 fixtures, tanuki on
2, raw on 2.

**All 12 fixtures** (rtk's `go test` and `docker ps` filters ask for formats the
shim cannot provide, so those three rows are replay artefacts, marked in the tool
output; with real docker and go rtk would very likely do fine):

| tool | tokens out | saved | answers kept | fixtures complete |
| --- | ---: | ---: | ---: | ---: |
| raw | 8,667 | - | 36/36 | 12/12 |
| tanuki-context `run` | 1,932 | 78 % | 34/36 | 11/12 |
| rtk | 1,064 | 88 % | 21/36 | 7/12 |
| context-mode `ctx_execute` | 2,217 | 74 % | 32/36 | 10/12 |
| context-mode `ctx_batch_execute` | 4,506 | 48 % | 32/36 | 10/12 |

**Where each wins, plainly.**

- **rtk is smaller almost everywhere both are comparable**: 88 % against 81 % saved,
  and below tanuki on cargo-build-fail, pytest-pass/fail, git-diff and npm-install
  (pytest-fail 132 tokens against 294: tanuki's output is *larger than raw* on
  small outputs because the fixed `[tanuki run] exit N ...` header and fetch
  pointer cost 35-50 tokens that a 100-token result cannot absorb). It pays in
  answers: on cargo-test-pass it keeps only the totals (the warning names go), on
  the 400-path find list none of the three planted paths, and it prints no pointer
  to the full output (`rtk recall` covers failures and truncation only).
- **tanuki wins** on cargo-test-pass (272 tokens with 3/3 answers; rtk 16 tokens
  with 1/3; context-mode needs 1,078 for 3/3) and git-status, and is the only tool
  that emits an exact recovery pointer where an answer was cut (find list: 1/3
  kept, `fetch <id>` for the rest). Its own numbers here do not include 0.23.
- **context-mode** is never smaller than raw on outputs under 5 KB (they come back
  verbatim plus a fence; `ctx_batch_execute` adds 128 tokens of index headers to a
  9-token `npm install`). Its real workflow, a model writing filter code over a
  sandbox, cannot be replayed without a model and is not scored.
- **No tool dominates**: on outputs of 300 tokens or fewer every tool, tanuki
  included, mostly adds noise over reading raw; the gains are in the two large
  fixtures (cargo-test-pass 2,086 tokens, find list 5,278).

Fairness: questions and answers were written before the first run; afterwards I
(a) rewrote answers as content-level strings with accepted spellings and (b) added
the unfaithful-replay exclusions, both in the competitors' favour. The sample is
12 fixtures (one, `tsc-fail`, synthetic in the manifest), one machine, one run
(every arm is deterministic). A vendor's own benchmark would use its own corpus;
this one is tanuki's, chosen before the tools were compared but not neutral.

## 18. Nightly read-back   *(needs an API key; local results below)*

`reference/readback-nightly.mjs` seeds the 14 needles of §2, plants them in a log
(`needleCorpus`), renders it through the real CLI, sends **only the pages** (never
the verbatim sidecar) to a model, and scores exact containment per needle kind.
`.github/workflows/nightly.yml` runs it on a schedule and on `workflow_dispatch`
against `anthropic` when the `ANTHROPIC_API_KEY` secret exists (it skips cleanly
otherwise), keeping a `readback-history` artifact of every run. The Claude number
is the one that matters and is **not measured here**: the environment that built
0.23 has no key, and the workflow itself was never executed on GitHub.

What a local model says, run through the same script (ollama, `temperature 0`):

| arm | model | result |
| --- | --- | ---: |
| pages, 80-line page (336 image tokens) | qwen3-vl:8b-instruct | **0/14** |
| pages, tiny font (224 tokens) | qwen3-vl:8b-instruct | 0/14 |
| pages | gemma4:e4b | 0/14 |
| 14 needle lines only (112 tokens) | qwen3-vl:8b-instruct / gemma4:e4b | 0/14 / 1/14 |
| **text control**: the document as text, no image | qwen3.5:9b | **13/14** (normal and tiny font) |
| text control | qwen3.5:2b | 4/14 (cannot follow the extraction instruction) |

The positive control is the reason to believe the 0/14. Before it, the harness
itself was wrong twice (the prompt said `sha256:<hex>` and `HH:MM:SS.mmm` while
models answered the bare hex and no trailing `Z`; filler timestamps invited
dumping), which read correct answers as misses (control 11/14, sha256 0/2). With
the prompt spelling each shape and digests scored on their hex payload, the 9b
text control reads 13/14 and both misses are omissions; every value it emitted
was byte-exact. So 0/14 at native scale is a real capability limit of 8B local
vision models on ~10 px glyphs, not a scorer bug. An upscaling diagnosis (not a
product feature: Claude's pixel-exact patching expects the native scale) made
qwen3-vl read 5/14 at 3x (sha256 2/2, file:line:col 2/2), all remaining misses
being glyph confusions (`45c55f8bd0a6` as `45c55f6bd0a6`). `verify` (§7) exists
for exactly that class of error.

## 19. The estimator against a real tokenizer   *(measured, no model)*

`bun reference/gate.mjs` counts **o200k_base** tokens (`gpt-tokenizer`, a
devDependency; the package still has zero runtime dependencies) next to the
package's own `textTokens` and gates `estimator.drift_pct`, the mean per-payload
|estimate - o200k| / o200k over every committed real capture, raw and routed, so
over- and under-counts on different payloads cannot cancel. It is 32.4 % now
(seeded JSON pair: 26.0 %), gated downward only.

The bias is one-sided. Measured on the original twelve fixtures, token-weighted:
estimator 13,701 against o200k 10,589, **+29.4 %**; per payload from -17 % (tiny
outputs such as eslint "no issues") to +157 % (routed pytest-pass, 47 real tokens
against 121 estimated), systematic on short punctuation- and number-heavy output
(pytest, docker, tsc +47 to +157 %) and mild on long prose-like logs (cargo 17-26 %).
Two caveats. The estimator was fitted to Claude's tokenizer (§9); o200k is
OpenAI's, so this is drift against a *different* real tokenizer, not against the
Claude bill. `tanuki_stats` reports that comparison (`estimatorRatioPct`) once the
proxy has logged billed tokens next to its estimates. And the runtime estimator is
deliberately unchanged: the parity harness and every pricing decision are
defined on it. Over-counting makes imaging and minify decisions more
conservative, not more aggressive.

## 20. Net savings, fetch back-off, tool pruning   *(measured live)*

Setup: Claude Code 2.1.285, `claude -p --model claude-sonnet-5-5`, `CLAUDE_CONFIG_DIR=~/.tanuki/claude`, through `tanuki-context proxy`; runs interleaved across arms, fresh copy and stash per run, bootstrap 95 % intervals.

**Net accounting and back-off.** Task: 40 calibration values that a checker reveals five at a time behind a 9 KB verbose trace that distill collapses (so the model has to `fetch`); `tanuki-context run -- python3 check.py` in CLAUDE.md; 8 sessions per arm.

| | back-off on | back-off off |
|---|---|---|
| solved | 8/8 | 8/8 |
| billed input tokens / session | 560,743 [461K, 681K] | 526,599 [417K, 648K] |
| paired on-off, billed input | +34,145 [-98,660, +190,859] | |
| paired on-off, cost | +$0.0096 [-$0.025, +$0.049] | |
| fetches / session (mean, median) | 14.0, 14 | 54.2, 5.5 |
| ledger: saved / fetched back (tokens/session) | 50,266 / 7,508 | 119,247 / 8,083 |

No gain, so the back-off is removed. Why it cannot win here: the fixture's 9,210-char output is 3,780 tokens raw, 318 as the normal answer; shown whole it is 3,821 (+3,503 per run); a fetch of the lines the model needed returns about 500. Break-even is about seven fetches per run, live median was 1-2. The accounting stays: fetched-back tokens are 6.8 % of what the stashes saved (8,083 of 119,247, back-off off).

**Tool pruning.** 5 tasks (create a file, fix a failing unit test, rename across files, summarise docs, collect TODOs) x 4 reps per arm; the evidence file came from 5 warm-up conversations, so `--prune-min 5` (default 20 needs more history; 5 is a stress setting that also stubs `Read`, which the warm-up tasks never called). Claude Code sends 26 tools here (72,103 chars of definitions, about 20K tokens).

| arm | solved | input tokens / request | cache-read share | cost / session |
|---|---|---|---|---|
| off | 20/20 | 38,157 | 89.6 % | $0.0709 [0.0696, 0.0722] |
| stub | 20/20 | 16,675 | 74.9 % | $0.0587 [0.0570, 0.0609] |
| drop | 20/20 | 15,168 | 72.1 % | $0.0574 [0.0561, 0.0589] |

Paired against off: input per request -21,490 [-21,528, -21,452] (stub), -22,993 [-23,029, -22,956] (drop); cost -$0.0121 [-0.0139, -0.0100] and -$0.0135 [-0.0151, -0.0118]. No tool errors and no call of an unadvertised tool in any arm. The tool bytes are identical on every request of a session (`proxy.prune_bytes_stable`). Open, not measured: a task that genuinely needs a pruned tool (the stub is meant to recover it; `drop` recovers on the next session), sessions longer than 5 requests, and whether the cached prefix survives across many sessions at `--prune-min 20`.

**Recovery of a pruned tool.** The evidence (10 conversations) had `Read` and `NotebookEdit` advertised and never called, so both were stubbed / dropped. Two tasks that use them, 5 reps per arm, same setup (an earlier `nb` run was discarded: the harness had not allowed `NotebookEdit`, so `off` and `stub` failed on permission, not on pruning).

| task | arm | solved | tool errors | calls | input/request | cost / session |
|---|---|---|---|---|---|---|
| nb (edit a notebook cell) | off | 5/5 | 0 | Read 5, NotebookEdit 5 | 38,109 | $0.0253 |
| | stub | 5/5 | 1 (an unrelated `Edit` refusal) | Read 5, NotebookEdit 5 | 16,675 | $0.0156 |
| | drop | 5/5 | 5 (`Edit`: "File is a Jupyter Notebook. Use the NotebookEdit") | Bash 10, Edit 5 | 15,203 | $0.0268 |
| readfile (count lines of a file) | off / stub / drop | 5/5 each | 0 | Bash only | 37,958 / 16,458 / 14,968 | $0.0598 / $0.0513 / $0.0507 |

`stub`: the stubbed `Read` and `NotebookEdit` were called with their real arguments straight away, with no validation error, so the stub costs nothing here. `drop`: the model met the client's hint at a tool that was no longer advertised, fell back to `Bash` (a small script rewriting the notebook JSON) and solved 5/5, at one more turn (4.0 against 3.0) and $0.0268 against $0.0253 for `off`. So recovery works in both modes; `stub` recovers with no detour, `drop` with a detour, which is why `stub` is the default. Nothing was changed in the design. Still open: tasks that need a pruned tool with arguments the model cannot guess.

**Own MCP schemas.** `tools/list` default surface: 893 estimator tokens for six tools (render 215, estimate 253, fetch 183, verify 102, stash 82, stats 48). About 3 % of Claude Code's own furniture, so not trimmed.

**Vision side (Tier 10).** SPIRAL (arXiv 2608.02109, Qwen3-VL-8B VTCBench 35.10 -> 54.02): github.com/Tianyu-Liang-seu/SPIRAL holds only LICENSE, README and assets; the README says code, checkpoints and data recipes are "coming soon", the four checkpoints are listed as "Coming soon" and no Hugging Face model exists. Not runnable, so the readback-nightly figure (0/14 for the local VLM) is unchanged. RenderRank (2609.35069) releases `nlpai-lab/RenderRank-2B`, a text reranker over rendered documents, not a page reader.

## Reproduce

```
# pricing (no key, deterministic)
node dist/cli.js estimate <log> 0 --model claude-opus-4

# sidecar coverage on YOUR logs (no key, runs on gigabytes) - the one to run first
bun reference/coverage-report.mjs /var/log/*.log
journalctl --no-pager -n 200000 > /tmp/j.log && bun reference/coverage-report.mjs /tmp/j.log

# generalisation: ids in shapes the engine never saw, injected into real lines
bun reference/adversarial-report.mjs            # --n 200 for tighter bounds

# 0.20 text-side additions (no key, both engines byte-compared)
node reference/crush-report.mjs --min 60        # rtk-style run rules on committed real outputs
node reference/retrieval-report.mjs --min 60    # now includes the find-words column
node reference/combined-report.mjs --min 90     # composed routes: selection x table x codebook x pages
bun reference/gate.mjs                          # the no-regression gate: o200k, delta, vocab-gap, proxy splice/memo/auto-cache
node reference/compare-report.mjs score out.json # rtk / context-mode comparison (collect step: header of the file)
node reference/readback-nightly.mjs --provider ollama --control text   # read-back; anthropic needs ANTHROPIC_API_KEY

# the lossless spine: stash it, fetch it, diff it (--no-redact: the default
# fetch masks credential-shaped values, so byte-identity needs the mask off)
ID=$(node dist/cli.js stash big.log | grep -oE '[0-9a-f]{12}' | head -1)
node dist/cli.js fetch "$ID" --lines "1-$(wc -l < big.log)" --no-redact | tail -n +2 | cmp - big.log

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

The 2026-07-28 run above cost ≈ **$7** of API, most of it the paired agent
loop, which is exactly why that arm is capped and run last. Thinking models
need a raised `max_tokens` (the harnesses set it) or they truncate mid-thought.
Rerun any table with more seeds/models before trusting a single delta; the
point of shipping the harness is that you don't have to trust ours.
