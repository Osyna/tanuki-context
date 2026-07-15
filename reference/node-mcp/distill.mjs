// Stage 0: log/output distillation (context-mode's idea, no MCP dependency).
//
// Logs are noisy in a structured way: the same lines repeat with only
// timestamps/ids/numbers changing — as straight runs, repeating multi-line
// cycles, or interleaved with a varying line. Instead of compressing noise,
// drop it:
//   pass 1: collapse CONSECUTIVE repetitions of 1..maxCycle-line blocks
//           (masked comparison) into the first block + "[×N similar]"
//   pass 2: global near-dupe suppression — keep the first `keepFirst`
//           occurrences of each masked key, drop the rest, exact counts in a
//           trailing summary (handles interleaved noise pass 1 can't)
//   pass 3: optional `query` — keep only matching lines ±context and
//           important lines, with "… N lines omitted" markers
// Error/warn/fail/exception/panic lines are ALWAYS kept verbatim.
// Deterministic, order-preserving, no model, no index.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const IMPORTANT = /\b(\w*(error|exception)s?|err|warn(ing)?s?|fail(s|ed|ure|ures)?|panic(s|ked)?|fatal|critical|traceback|denied|refused|timeouts?|timed.?out|assert(s|ed|ion|ions)?|segfault(s|ed)?)\b/i;
/** Mask volatile tokens so "same event, different timestamp" compares equal. */
function maskLine(l) {
  return l
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{7,64}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|s|m|h|%|[KMGT]i?B)?\b/gi, "<n>");
}

/** Distill noisy log/output text. Returns { distilled, stats }. */
export function distillLog(text, { query = null, context = 2, minRun = 3, maxCycle = 8, keepFirst = 2 } = {}) {
  const lines = text.replace(ANSI, "").split("\n");
  const origLines = lines.length;
  let collapsedRuns = 0;

  const masked = lines.map(maskLine);
  const important = lines.map((l) => IMPORTANT.test(l));
  const importantKept = important.filter(Boolean).length; // never collapsed, always emitted

  // pass 1: consecutive repetitions of near-identical blocks (chronology preserved)
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let bestK = 0, bestR = 0;
    for (let k = 1; k <= maxCycle && i + 2 * k <= lines.length; k++) {
      if (important[i + k - 1]) break; // block would contain an error/warn line — never collapse
      let r = 1;
      outer: for (;;) {
        const s = i + r * k;
        if (s + k > lines.length) break;
        for (let j = 0; j < k; j++) if (important[s + j] || masked[s + j] !== masked[i + j]) break outer;
        r++;
      }
      if (r >= minRun && k * (r - 1) > bestK * (bestR - 1)) { bestK = k; bestR = r; }
    }
    if (bestK) {
      for (let j = i; j < i + bestK; j++) out.push(lines[j]);
      out.push(bestK === 1 ? `   [×${bestR} similar]` : `   [×${bestR} similar ${bestK}-line blocks]`);
      collapsedRuns++;
      i += bestK * bestR;
    } else { out.push(lines[i]); i++; }
  }

  // pass 2: global near-dupe suppression (interleaved noise: cycles where one
  // line varies defeat pass 1). Keep first `keepFirst` occurrences per masked
  // key, drop the rest, exact counts in a trailing summary. Important lines and
  // block markers are never suppressed.
  const seen = new Map();   // exact masked key   -> { count, exemplar }
  const coarseSeen = new Map(); // template key    -> { count, exemplar }
  // Coarse template: non-alpha tokens -> <v>. Groups "same event, different
  // path/name" lines (sync/copy logs: 1.6M distinct paths, one event type).
  const coarseKey = (masked) => masked.split(/\s+/).map((t) => (/^[A-Za-z]+$/.test(t) ? t : "<v>")).join(" ");
  const coarseKeepFirst = keepFirst + 1; // keep one extra exemplar of each template
  const pass2 = [];
  let suppressedLines = 0, templateSuppressed = 0;
  for (const l of out) {
    if (IMPORTANT.test(l) || /^\s*\[×/.test(l) || l.trim().length < 4) { pass2.push(l); continue; }
    const key = maskLine(l);
    const e = seen.get(key);
    if (e) { // exact near-dupe tier
      if (++e.count <= keepFirst) pass2.push(l);
      else { suppressedLines++; continue; }
      continue;
    }
    seen.set(key, { count: 1, exemplar: l });
    const ck = coarseKey(key);
    const c = coarseSeen.get(ck);
    if (!c) { coarseSeen.set(ck, { count: 1, exemplar: l }); pass2.push(l); }
    else if (++c.count <= coarseKeepFirst) pass2.push(l);
    else templateSuppressed++;
  }
  const topExact = [...seen.values()].filter((e) => e.count > keepFirst).sort((a, b) => b.count - a.count);
  const topCoarse = [...coarseSeen.values()].filter((e) => e.count > coarseKeepFirst).sort((a, b) => b.count - a.count);
  const topRepeats = [
    ...topExact.slice(0, 40).map((e) => ({ kind: "exact", count: e.count, exemplar: e.exemplar.trim().slice(0, 160) })),
    ...topCoarse.slice(0, 40).map((e) => ({ kind: "template", count: e.count, exemplar: e.exemplar.trim().slice(0, 160) })),
  ].sort((a, b) => b.count - a.count).slice(0, 40);
  if (suppressedLines + templateSuppressed) {
    pass2.push(`── ${suppressedLines + templateSuppressed} repeated lines suppressed (${suppressedLines} exact ×N, ${templateSuppressed} same-template; first occurrences kept above) ──`);
    for (const e of topRepeats) pass2.push(`  ×${e.count}${e.kind === "template" ? " (template)" : ""}  ${e.exemplar}`);
  }

  // pass 3: optional query filter — matching lines ±context + important lines only
  let final = pass2;
  if (query) {
    let re;
    try { re = new RegExp(query, "i"); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    const keep = new Set();
    pass2.forEach((l, idx) => {
      if (re.test(l) || IMPORTANT.test(l)) for (let k = Math.max(0, idx - context); k <= Math.min(pass2.length - 1, idx + context); k++) keep.add(k);
    });
    final = [];
    let omitted = 0;
    for (let idx = 0; idx < pass2.length; idx++) {
      if (keep.has(idx)) {
        if (omitted) { final.push(`… ${omitted} lines omitted`); omitted = 0; }
        final.push(pass2[idx]);
      } else omitted++;
    }
    if (omitted) final.push(`… ${omitted} lines omitted`);
  }

  const distilled = final.join("\n");
  return { distilled, stats: {
    origLines, outLines: final.length, origChars: text.length, outChars: distilled.length,
    savedPct: text.length ? Math.round((1 - distilled.length / text.length) * 100) : 0,
    collapsedRuns, suppressedLines, templateSuppressed, importantKept, topRepeats, query: query || null } };
}
