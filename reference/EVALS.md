# Evals

tanuki publishes the **harness, not a percentage.** A savings number nobody
can re-measure is the exact failure this project exists to avoid (see the
rakuen post *"Token compression tools measure the wrong thing"* — these
scripts are its bar, applied to ourselves). Every harness is seeded and
reproducible; run it on your own model and corpus.

## Read-back fidelity — `npm run needles`   *(published; corpus expanded)*

Can a vision model transcribe dense pages back **byte-exact**? Seeded needles
— uuid, semver, 12-char hex id, `sha256:` digest, `path:line:col` frame, and
now **base64 tokens** and **ms timestamps** (the confusable-rich kinds) — are
rendered at both densities and read back blind. On the original five kinds:
**5/10 survive normal density, 3/10 tiny** — this is *why* the `verbatim`
sidecar exists and why secrets are never imaged.

`score` now adds a **char-to-char substitution tally** on the misses and
splits them into *glyph-shape* confusions (a bigger font or higher-res tier
recovers them — `l/I/1`, `O/0`) vs *value-drift* (the model settled on a
plausible wrong value a font won't fix — keep those as text). base64's mixed
case and the ms tail are what make that split legible.

Note: base64 and ms are deliberately **not** matched by the production
`scanNeedles` sidecar (a generic base64 pattern would false-positive across
normal logs and gut compression), so they ride on font fidelity alone —
exactly what the new diagnostic measures. Their read-back rates and the /14
headline **await a keyed run**.

## Cost per successful task — `npm run paired`   *(run it)*

**THE honest number:** cost per *successful* task, tool-on vs tool-off, same
model, same 4 seeded tasks, N repeats, byte-exact/containment success checks.
A cheap wrong answer counts as a **failure, not a save.** Needs the Claude
Agent SDK and a key:

```
ANTHROPIC_API_KEY=... PAIRED_RUNS=5 npm run paired          # add --json out.jsonl to log
node reference/paired-report.mjs --dry                       # plan only, no calls
```

**Status: unrun here** — the build machine has no `ANTHROPIC_API_KEY`. This
table is deliberately empty rather than fabricated. Run the command above and
paste the four-task cost-per-success table; even an unflattering result is the
most valuable artifact this repo can carry.

## Task success on pages vs text — `npm run taskqual`   *(run it)*

Can the model still **do the job** — find the injected root cause in a noisy
log — when the context is IMAGE pages instead of TEXT? Same model, same seeded
corpus, two arms (text | image), substring-scored. The claim customers
actually buy, next to the read-back claim.

```
ANTHROPIC_API_KEY=... npm run taskqual                       # TASK_MODEL=, TASK_SEEDS= to override
node reference/task-report.mjs                               # no key: prints seeded fixtures + expected answers, exits 0
```

**Status: unrun here** (no API key). With no key it prints the fixtures and
the expected root-cause token per seed and exits without calling a model — no
fabricated scores.

## Token math (no model needed) — `npm run tiers`

Deterministic token accounting across every knob on seeded corpora;
reproduces the README savings tables byte-for-byte on your machine.
