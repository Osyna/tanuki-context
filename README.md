<div align="center">

<img src="https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/logo.png" alt="the tanuki-context logo: a pixel-art tanuki in a straw hat" width="180" />

# tanuki-context

**A content-addressed store for the bulky parts of a conversation: park bytes, fetch precise slices, settle exact values — and image a slice when imaging is measured to win.**

[![npm](https://img.shields.io/npm/v/tanuki-context?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/tanuki-context)
[![CI](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml/badge.svg)](https://github.com/Osyna/tanuki-context/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-zero-3DA639?style=for-the-badge)](https://www.npmjs.com/package/tanuki-context?activeTab=dependencies)
[![license](https://img.shields.io/badge/license-MIT-8ab4f8?style=for-the-badge)](LICENSE)

</div>

AI models charge for every token they read. tanuki-context is a
content-addressed store for the bulky parts of a conversation — logs, command
output, long documents. Text goes into a stash under a sha256; the model gets a
small map and fetches the slices it needs; anything it reads back is checkable
against the original bytes with no model in the loop. Node >= 18 or a static
Rust binary, zero dependencies either way.

Three separable capabilities ship in that box, and they do not carry equal
risk. Two are unconditional:

- **Park, fetch, verify — exact by construction.** stash → fetch → diff over
  19.7 MB of real logs recovers **19,722,893 / 19,722,893 characters
  byte-identical**; the `verbatim` sidecar carries **100%** of at-risk
  identifiers on that corpus as text; `tanuki_verify` turns a one-character
  misread into `corrected` with no model call at all
  ([EVALS §7](reference/EVALS.md)).
- **Text reduction — no fidelity risk, no model dependence.** distill,
  compress, table and codebook cut a real pacman log **70.9%** with the output
  still text. `estimate` prices this on every call as `recommend.text`, so
  there is a token answer even when imaging is the wrong one
  ([EVALS §5](reference/EVALS.md)).

One is conditional, and it is the one the tool is named for:

- **Imaging — 79% off input tokens on a real log, inside a measured
  envelope.** Text costs roughly a token per few characters (real logs
  tokenise at 1.9-2.9 chars/token, prose near 5.0); an image costs a fixed
  amount set by its pixel size, no matter how much text is drawn inside it.
  [pxpipe](https://github.com/teamchong/pxpipe) found how far that gap
  stretches; tanuki packages it so the model itself decides when to use it,
  plus a proxy mode for clients you can't change. The envelope, stated: pages
  need a capable reader (2 of 5 tested models score **0%** on a task they solve
  100% as text), exact strings never survive them (**0/14** needles byte-exact
  on every model tested — which is why they ride the sidecar as text), the
  fidelity-preserving tier is normal font (`tiny` is **0/5** on the task,
  `distill` **1/5**), and the cost case is capped by prompt caching: a cached
  payload bills at **$0.30/Mtok**, so plain inlining wins the **median by
  3.5×**. The honest cost claim is *predictable*, not cheaper —
  **$0.124–$0.225** across nine runs against inlining's **$2.94** worst run
  ([EVALS §2-§4, §6](reference/EVALS.md)).

Every figure above is input-side. An output-dominated bill bounds what any
input-side tool can save at all, whatever it does to the input —
`tanuki_stats` reports that share.

The strongest evidence the router is well built is that it refuses to sell
itself: pointed at four real corpora it declined to image two — one for
credentials, one for being past the read-back cliff.

![a rendered page: dense 5x8-pixel text, 312 columns of system log](https://raw.githubusercontent.com/Osyna/tanuki-context/main/docs/example-page.png)

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

## New in 0.19

- **Output is 53% of the bill, so this whole tool is capped at 46.7%.** Every saving tanuki produces is input-side, and nobody had measured the other side. `npm run paired` now records `output_tokens` beside the three input classes and prints the ceiling. Output bills at $15.00/Mtok against $0.30 for a cache read, so **45,914 output tokens outweighed 543,180 input tokens**. Worse for the pitch, the ceiling *tightens as the tool succeeds*: cutting input raises output's share of what remains. n=1, so read it as an order of magnitude — but it bounds every other number in the repo ([EVALS §6](reference/EVALS.md)).
- **Retrieval failure is now separable from reasoning failure** — `npm run retrieval`, model-free, needs no API key. Scoring three outcomes per (answer, query) pair — carried as **TEXT**, on **PIXELS** only (a miss, since exact read-back is 0/14), or **ABSENT** — gives **66.7% precision**, identical on both engines. All four misses are one cause: the sidecar carries id-, hash- and version-shaped strings, and a bare English word like a unit name never qualifies. So a *dominant-error-unit* failure is retrieval; an id or version failure is reasoning ([EVALS §10](reference/EVALS.md)).
- **`chars / 4` was wrong by a factor of three, and it was the denominator of every routing decision.** Measured against Anthropic's own tokenizer (free via `count_tokens`): real content runs from **1.14 chars/token** (base64) to **4.97** (prose). `chars/4` was **−72%** on base64, **−53%** on pacman logs, **+24%** on prose. The error never cancelled — image tokens come from exact pixel geometry — so tanuki declined log wins it should have taken *and* imaged prose it should have left alone. `textTokens` now prices character classes by how a BPE treats them. Held out on 37 fresh samples: real content **median 3.3%, worst 16.2%** against 38.3% / 65.6% for the old divisor, with one documented pathology (239% on a blob of pure camelCase). `npm run tokenizer` reproduces it ([EVALS §9](reference/EVALS.md)).
- **That silently re-calibrated the fidelity band, which had been flattering itself.** Its 8/12/16/20 thresholds come from DeepSeek-OCR's table, defined with a *real* tokenizer, so feeding it `chars/4` made every log ratio ~1.5× too low. Re-running the tier sweep: `distill` used to report **"degraded, ~75-87%"** while actually solving **1 task in 5**; it now reports **"unreliable, <60%"**. Band and outcome finally agree — *good* ↔ 100%, *unreliable* ↔ 20%.
- **The cost tail has a mechanism now, not a story.** Splitting the three input classes (0.18) shows the inlining arm writes **5.1× more cache** than tanuki (215,673 vs 42,237 tokens) at **12.5× the price of a read**, running a 71% hit rate against tanuki's 92%. The expensive runs aren't "the agent re-read the log" — a warm re-read is nearly free. Inlining a large body keeps invalidating the prefix and paying to rebuild it.
- **`tiny` is not a densification lever.** It is 1.67× denser, but measured **0/5** on the comprehension task at L0 where the normal font scores 5/5. It stays what the band always said it was: a lossy-bulk tier, not free tokens.
- **`verbatim: "lazy"` measured, and it stays opt-in.** The sidecar is 42% of a render's tokens, so deferring it looked like the biggest payload cut going. It isn't: measured as its own arm it halves cache writes, lifts the hit rate to 97%, and saves **nothing outside the noise** — because a cached payload bills at $0.30/Mtok, so removing 42% of it removes 42% of the cheapest thing in the request. The lever is keeping the cache warm, not shrinking the payload. Lazy is still right for cold one-shot renders.
- **A wrong published table, caused by a duplicated number.** `tiers-report` re-derived tokens as `chars/4` with the comment *"same rule as rawTextTokens"*. Once the real estimator landed that comment became false, and the table reported `L1 whitespace` — which is **lossless** — as a 49% saving. `estimate` now reports `stage1Tokens` and the harness uses it. A second implementation of a number is a second answer waiting to disagree.
- **Cross-request page reuse: built, measured, rejected.** Reusing pages for a block already imaged in an earlier request looks like free savings. It is the opposite: the same block sits at the same position every turn, so a pointer **changes the prefix** and invalidates the cache entry for everything after it — the prefix the breakpoint exists to hold stable. It also drops the `verbatim` sidecar with nothing above to recover it. Guarded now by a test that drives three sequential calls on a warm session, mirrored into Rust, which had *no* session coverage at all.
- **The eval harnesses stopped duplicating each other.** `reference/lib/{rand,corpus,mcp,png}.mjs`: `lcg` had been copied into six harnesses, the corpora into five, the PNG pixel decoder into two, and ad-hoc MCP clients had omitted parts of the handshake and "passed" while comparing nothing. Net **−164 lines** across seven harnesses, every baseline output byte-identical.
- **`withTanuki(options, { env })`** passes server environment explicitly, so eval arms stop communicating through ambient `process.env`. The paired harness had been mutating it globally, which is why the full-vs-lazy sidecar comparison had a contamination path that could not be ruled out.
- **`TANUKI_VERBATIM=lazy|full|off`** sets the sidecar policy once for a deployment instead of per call. An explicit `verbatim` argument always wins — the env is a default, never an override the caller can't escape.

## New in 0.18

- **The proxy now marks the imaged prefix cacheable.** It has always *priced* prompt caching but never *created* it — which is backwards, because imaged pages are the ideal cache payload: large, re-sent verbatim every turn, and byte-stable. One `cache_control` breakpoint on the last imaged message turns every later turn's re-send into cache reads: at Sonnet rates on a 7,530-token page set, **$0.226 → $0.0486 over 10 turns (4.7×)**, 3.0× over 5, 2.1× over 3. It counts the client's existing breakpoints first and declines at Anthropic's ceiling of four, so a request that worked before still works. `--no-cache` opts out.
- **A fetched slice no longer hands back secrets.** The credential gate refused to *image* them; `tanuki_fetch` returned them as text — the same secret in the same context window by a shorter route. Values now come back as `[redacted:<kind>]` with a visible count line, from the same detector that gates imaging. The stash still stores raw bytes and `redact: false` returns them (that is how the 19,722,893-character byte-identity round-trip is still asserted).
- **…and that detector was an allowlist with an unbounded complement.** Every rule matched a *shape*, which only works for vendors who prefix their tokens: `AWS_SECRET_ACCESS_KEY=` is 40 chars of base64 with no marker and leaked straight through. The fix is the same inversion the sidecar classifier needed — when the **left** side of an assignment names a secret, the right side is one whatever it looks like. Tuned against 19.7 MB of real logs down to **2 false positives in 166,985 lines, and both are real secrets** ([EVALS §8](reference/EVALS.md)).
- **`verbatim: "lazy"`** ships a one-line pointer instead of the carried strings. On a 1,200-line service log the sidecar is **5,611 of 13,213 rendered tokens — 42%**, and it is paid on every render whether or not the caller ever needs an exact id. Lazy defers it to `tanuki_fetch`/`tanuki_verify`. Default is unchanged; the dense refusal still fires first.
- **The proxy wire path is now parity-checked** (`npm run parity:proxy`). The MCP harness only drives `tools/call`, so the proxy's rewritten request body had no cross-engine test at all.
- **The eval harness can no longer report a dead API key as a measurement.** `task-report` scored transport errors as wrong answers, so an expired key rendered as a confident table declaring every model unable to read pages — including two the n=8 run proves can. Errors are now counted apart from answers, unrun cells read `unrun`, and the run exits non-zero.

## New in 0.17

- **`estimate` now refuses to recommend pages to a model that can't read them.** Measured at n=8: `claude-sonnet-4-5` and `claude-haiku-4-5` score **100% on a task as text and 0% on the same task as imaged pages**. The fidelity band is calibrated to a capable reader, so for those two it wasn't optimistic — it was wrong, and tanuki was answering `fidelity: high, route: image` to callers whose real task success was zero. Pass `model` and the band floors to `unreliable` and the route stays text. An unmeasured model is still treated as capable, so nothing regresses.
- **A per-model reader profile, not a caveat** — `TASK_MODELS=a,b,c npm run taskqual` profiles several readers in one run ([EVALS §3](reference/EVALS.md)). Model ids are immutable snapshots, so unlike a model→context-window table this one can't go stale.
- **The end-to-end cost claim is corrected — twice wrong before.** At n=1 tanuki looked 6× cheaper; at n=3 warm it looked like parity. At **n=9 per arm** the truth is neither: inlining wins the **median** ($0.049 vs $0.173) because prompt caching makes re-reads nearly free, but its cost has a long tail — one run hit **$2.94**, a 73× spread. Tanuki's runs land in **$0.124–$0.225**, a 2× spread. The honest claim is *predictable*, not *cheaper*: worst case 13× better. Full distribution in [EVALS §6](reference/EVALS.md).

## New in 0.16.1

- **The proxy now fails open.** `transformRequestBody` ran unguarded inside an async `req.on("end")` callback — a throw there wasn't one dropped request, it was an uncaught exception that would take the whole proxy down with every in-flight call. Both engines now forward the original bytes on any error (Rust via `catch_unwind`), and a test feeds the transform malformed, oversized, null-byte and astral-plane bodies to prove it never throws.
- **Render output is byte-stable, now enforced.** Rendering the same text twice produces identical PNG bytes — if it ever drifts, every re-image silently re-bills the caller's whole cached prefix. That's a cost regression no other test here would catch, so it has its own.
- **The slim tool surface is priced, not assumed** — 549 tok/request for 5 tools vs 749 for 8. Hiding `tanuki_fetch` saved 74 tok/request and cost 521,000 tokens in one failed run ([EVALS §6](reference/EVALS.md)).

Fail-open capture, prompt-cache break attribution and dead tool-schema detection are properties [ctxdiff](https://github.com/salmanzafar949/ctxdiff) audits by design — see [Prior art](#more). All three were unasserted here; now they are tested.

## New in 0.16

- **A query fetch now reports how many raw lines matched** — `[query matched 18 of 1201 lines]`. The distilled slice is context-padded and collapsed, so its line count was never a match count, and nothing else reported one: the agent literally could not count. This was the last unexplained §6 failure.
- **That closes the aggregation gap, and flips the economics.** "Which unit logged the most ERROR lines" went **FAIL → PASS**, and the tool arm is now **~6× cheaper per success than inlining** ($0.17 vs $1.03) — the first measured case where the loop beats the baseline rather than matching it. One 40-token count replaces a full re-read of 1,200 lines. Caveat stated in [EVALS §6](reference/EVALS.md): n=1 on that arm, and the inlining arm's cost swings from $0.03 to $1.72.
- **The coverage residual was chased and declined, with numbers.** An in-block frequency rule would add **19–32 false needles per page** on real logs (`DISCONNECTED`, `configuration`, `firmware`) — enough to tip pages to `dense` and forfeit imaging. Measured, not argued. And what the sidecar misses is still covered: `tanuki_verify` returns `exact`/`corrected` on exactly those ids, now a regression test.

## New in 0.15

- **`tanuki_fetch` is in the default tool surface.** It wasn't — while `tanuki_stash` was. Fetch is the only way to read a stash back, so the model could park text it could never retrieve. Traced, a capable agent spent every turn on `ToolSearch` and concluded *"No `tanuki_fetch` tool exists in my toolset."*
- **The verbatim sidecar now ships *before* the image blocks**, in `render`, `fetch` and the proxy. Trailing exact strings after a 12 KB PNG meant a traced agent was handed the answer on turn 4 and re-queried six more times before finding it.
- **This corrects a claim in [EVALS §6](reference/EVALS.md).** Two releases said the autonomous loop "thrashes — the agent over-fetches, re-images, never converges." That was inferred from token counts and it was wrong; both causes were ordinary bugs. Measured after the fix: verbatim retrieval goes **0/1 → 3/3**. Whole-corpus aggregation still fails, and the loop is still not a cost win against inlining — both stated plainly there.
- **`npm run trace`** ships the diagnostic that found it: every tool call, every result block, sizes and all. A token count is a symptom, not a diagnosis.
- **`npm run paired` got cost controls** — `PAIRED_TASKS`, `PAIRED_MAXTURNS`, `PAIRED_BUDGET`. An unattended run had previously burned $4+ before anyone could stop it.

## New in 0.14.1

- **The CLI `fetch` prints the sidecar too.** 0.14 fixed the MCP tool and the CLI *gate*, but the CLI still emitted only JSON metadata and PNG files — so scripting `tanuki-context fetch` against an imaged slice silently lost every exact string. Caught by smoke-testing the published package, which is why that step exists.

## New in 0.14

- **`tanuki_fetch` was imaging slices with no verbatim sidecar at all.** The path the manual recommends for large references — stash once, fetch slices later — shipped pages with zero exact-string protection, so every id in a fetched slice rode as unprotected pixels. It now ships the sidecar exactly like `render`, counts those tokens against the win, and leaves a needle-dense slice as text. This is also a direct cause of the loop thrash in [EVALS §6](reference/EVALS.md): an agent that can't read an id off the page just fetches again.
- **Git sha ranges no longer slip through.** A bare 7-hex sha was at risk but `ee70833..0c331b6` was not, because its segments fell under the length gate. Segment rules now mirror the whole-token hex and long-numeric rules.
- **Coverage on real logs is 100%** (4,568/4,568 at-risk ids, 19.5 MB, zero unprotected characters). Two fixes to the measurement got there honestly: the harness had been scoring paths (`dev/input/event5`) and UTC timestamps as unrecoverable ids, and it scored a refused block as a miss when a refused block actually stays text and is fully readable.
- **Adversarial widened to 26 shapes × 500 draws — mean 94.4%.** Every real-world format added scores 93–100%: KSUID, snowflake, ARN, JWT, dash-less UUID, IPv6, docker id, traceparent, S3 version id, URL-safe base64. CI now gates at `--min 90`.
- **Not done, deliberately:** in-block frequency and a word list. The residual is confined to pure-random alphabets (70–76%), a shape with **zero instances across 19.5 MB of real logs**, and since 0.13.1 a false positive can push a block to `dense` and forfeit imaging entirely. Paying that cost to chase a synthetic shape is a bad trade; the limit is documented instead.

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
