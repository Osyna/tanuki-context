// Stage 0: log/output distillation (port of src/distill.rs, itself a port of
// pxpipe mcp/distill.mjs).
//
// pass 1: collapse CONSECUTIVE repetitions of 1..MAX_CYCLE-line blocks
//         (masked comparison) into the first block + "[×N similar]"
// pass 2: global near-dupe suppression — exact masked key, then a coarse
//         template key (non-alpha tokens -> <v>); exact counts in a summary
// pass 3: optional query — matching lines ±context + important lines only
// Error/warn/fail/exception lines are ALWAYS kept verbatim.

import { Buffer } from "node:buffer";

// No `u` flag anywhere: the Rust spec uses `(?-u:\b)` / ASCII classes precisely
// to match legacy JS regex semantics (\b, \w, \d are ASCII there).
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const IMPORTANT =
  /\b([0-9A-Za-z_]*(error|exception)s?|err|warn(ing)?s?|fail(s|ed|ure|ures)?|panic(s|ked)?|fatal|critical|traceback|denied|refused|timeouts?|timed.?out|assert(s|ed|ion|ions)?|segfault(s|ed)?)\b/i;
const M_TS =
  /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?/g;
const M_TIME = /\b[0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?\b/g;
const M_UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const M_HEX = /\b[0-9a-f]{7,64}\b/gi;
const M_NUM = /\b[0-9]+(\.[0-9]+)?[ \t\u00a0]?(ms|us|µs|ns|s|m|h|%|[KMGT]i?B)?\b/gi;
// Every mask pattern needs at least one of [0-9a-f] to match; lines without one
// (very common in prose logs) skip all five replace passes.
const HAS_MASKABLE = /[0-9a-f]/i;

const MIN_RUN = 3;
const MAX_CYCLE = 8;
const KEEP_FIRST = 2;
const TOP_CAP = 40;

/** Mask volatile tokens so "same event, different timestamp" compares equal. */
function maskLine(l: string): string {
  if (!HAS_MASKABLE.test(l)) return l;
  let s = l.replace(M_TS, "<ts>");
  s = s.replace(M_TIME, "<time>");
  s = s.replace(M_UUID, "<uuid>");
  s = s.replace(M_HEX, "<hex>");
  return s.replace(M_NUM, "<n>");
}

/** Rust `char::is_whitespace` (Unicode White_Space). All members are BMP,
 * non-surrogate, single UTF-16 unit — safe on charCodeAt values too. */
function isRustWs(cp: number): boolean {
  if (cp === 0x20) return true;
  if (cp < 0x09) return false;
  if (cp <= 0x0d) return true;
  if (cp < 0x85) return false;
  return (
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Rust `str::trim` (Unicode-whitespace on both ends). */
export function rustTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isRustWs(s.charCodeAt(a))) a++;
  while (b > a && isRustWs(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** true iff Rust `l.trim().chars().count() < n` (codepoint count, early exit). */
function trimmedCpCountLt(l: string, n: number): boolean {
  let a = 0;
  let b = l.length;
  while (a < b && isRustWs(l.charCodeAt(a))) a++;
  while (b > a && isRustWs(l.charCodeAt(b - 1))) b--;
  let count = 0;
  for (let i = a; i < b && count < n; count++) {
    const c = l.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < b ? 2 : 1;
  }
  return count < n;
}

/** true iff Rust `l.trim_start().starts_with("[×")`. */
function trimStartHasMarker(l: string): boolean {
  let a = 0;
  const b = l.length;
  while (a < b && isRustWs(l.charCodeAt(a))) a++;
  // "[×" is two BMP units: 0x5b, 0xd7
  return l.charCodeAt(a) === 0x5b && l.charCodeAt(a + 1) === 0xd7;
}

/**
 * Coarse template: non-alpha tokens -> <v> (groups "same event, different path").
 * Mirrors the JS reference exactly: `split(/\s+/)` yields a leading/trailing
 * EMPTY token on leading/trailing whitespace, which maps to `<v>` — so an
 * indented line and its unindented twin get DIFFERENT templates there too.
 */
function coarseKey(masked: string): string {
  const parts: string[] = [];
  let tokStart = -1;
  let tokAlpha = true;
  let sawNonWs = false;
  let endsWs = false;
  let first = true;
  for (let i = 0; i < masked.length; ) {
    const cp = masked.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const ws = isRustWs(cp);
    if (first) {
      first = false;
      if (ws) parts.push("<v>");
    }
    if (ws) {
      if (tokStart >= 0) {
        parts.push(tokAlpha ? masked.slice(tokStart, i) : "<v>");
        tokStart = -1;
      }
      endsWs = true;
    } else {
      sawNonWs = true;
      endsWs = false;
      if (tokStart < 0) {
        tokStart = i;
        tokAlpha = true;
      }
      if (tokAlpha) {
        const c = cp | 32;
        if (c < 97 || c > 122 || cp > 0x7f) tokAlpha = false;
      }
    }
    i += step;
  }
  if (tokStart >= 0) parts.push(tokAlpha ? masked.slice(tokStart) : "<v>");
  if (sawNonWs && endsWs) parts.push("<v>"); // trailing whitespace -> trailing empty token in JS
  return parts.join(" ");
}

/** Rust `truncate_chars`: first n codepoints of s. */
export function truncateChars(s: string, n: number): string {
  let i = 0;
  let c = 0;
  const len = s.length;
  while (i < len && c < n) {
    const u = s.charCodeAt(i);
    i += u >= 0xd800 && u <= 0xdbff && i + 1 < len ? 2 : 1;
    c++;
  }
  return i >= len ? s : s.slice(0, i);
}


const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

interface Entry {
  count: number;
  exemplar: string;
}

export interface Distilled {
  distilled: string;
  stats: {
    collapsedRuns: number;
    importantKept: number;
    origChars: number;
    origLines: number;
    outChars: number;
    outLines: number;
    query: string | null;
    savedPct: number;
    suppressedLines: number;
    templateSuppressed: number;
    topRepeats: { count: number; exemplar: string; kind: string }[];
  };
}

// NOTE: third parameter is the ±context window of pass 3 (Rust `context`,
// always 2 in main.rs); named per the shared TS contract.
export function distillLog(
  text: string,
  query: string | null = null,
  minRun = 2,
): Distilled {
  const context = minRun;
  const clean = text.replace(ANSI, "");
  // rtk-style truncation for terminal progress: a captured line full of \r
  // frames ("45%\r46%\r...done") is one line on a real terminal - keep only
  // the final frame, exactly what the screen would have shown. A lone
  // trailing \r is CRLF, not a frame boundary: strip it first.
  const lines = clean.split("\n").map((l) => {
    const s = l.endsWith("\r") ? l.slice(0, -1) : l;
    const cr = s.lastIndexOf("\r");
    return cr === -1 ? s : s.slice(cr + 1);
  });
  const nLines = lines.length;
  const origLines = nLines;
  const masked = new Array<string>(nLines);
  const important = new Array<boolean>(nLines);
  let importantKept = 0;
  for (let i = 0; i < nLines; i++) {
    masked[i] = maskLine(lines[i]);
    const imp = IMPORTANT.test(lines[i]);
    important[i] = imp;
    if (imp) importantKept++;
  }

  // pass 1: consecutive repetitions of near-identical blocks (chronology kept)
  const out: string[] = [];
  const outImp: boolean[] = [];
  const outMasked: (string | null)[] = [];
  let collapsedRuns = 0;
  let i = 0;
  while (i < nLines) {
    let bestK = 0;
    let bestR = 0;
    for (let k = 1; k <= MAX_CYCLE && i + 2 * k <= nLines; k++) {
      if (important[i + k - 1]) break; // block would contain an error/warn line — never collapse
      let r = 1;
      reps: for (;;) {
        const s = i + r * k;
        if (s + k > nLines) break;
        for (let j = 0; j < k; j++) {
          if (important[s + j] || masked[s + j] !== masked[i + j]) break reps;
        }
        r++;
      }
      if (r >= MIN_RUN && k * (r - 1) > bestK * (bestR > 0 ? bestR - 1 : 0)) {
        bestK = k;
        bestR = r;
      }
    }
    if (bestK > 0) {
      for (let j = i; j < i + bestK; j++) {
        out.push(lines[j]);
        outImp.push(important[j]);
        outMasked.push(masked[j]);
      }
      out.push(
        bestK === 1
          ? `   [×${bestR} similar]`
          : `   [×${bestR} similar ${bestK}-line blocks]`,
      );
      outImp.push(false); // "[×N similar…]" never matches IMPORTANT
      outMasked.push(null);
      collapsedRuns++;
      i += bestK * bestR;
    } else {
      out.push(lines[i]);
      outImp.push(important[i]);
      outMasked.push(masked[i]);
      i++;
    }
  }

  // pass 2: global near-dupe suppression (exact masked key, then coarse template)
  const seen = new Map<string, Entry>();
  const coarseSeen = new Map<string, Entry>();
  const coarseKeep = KEEP_FIRST + 1;
  const pass2: string[] = [];
  const pass2Imp: boolean[] = [];
  let suppressed = 0;
  let templateSuppressed = 0;
  for (let idx = 0; idx < out.length; idx++) {
    const l = out[idx];
    const imp = outImp[idx];
    if (imp || trimStartHasMarker(l) || trimmedCpCountLt(l, 4)) {
      pass2.push(l);
      pass2Imp.push(imp);
      continue;
    }
    const key = outMasked[idx]!; // == maskLine(l): non-marker lines carry their pass-0 mask
    const e = seen.get(key);
    if (e !== undefined) {
      e.count++;
      if (e.count <= KEEP_FIRST) {
        pass2.push(l);
        pass2Imp.push(false);
      } else {
        suppressed++;
      }
      continue;
    }
    const ck = coarseKey(key);
    seen.set(key, { count: 1, exemplar: l });
    const c = coarseSeen.get(ck);
    if (c !== undefined) {
      c.count++;
      if (c.count <= coarseKeep) {
        pass2.push(l);
        pass2Imp.push(false);
      } else {
        templateSuppressed++;
      }
    } else {
      coarseSeen.set(ck, { count: 1, exemplar: l });
      pass2.push(l);
      pass2Imp.push(false);
    }
  }
  const top: [number, string, string][] = [];
  for (const e of seen.values()) {
    if (e.count > KEEP_FIRST) top.push([e.count, "exact", e.exemplar]);
  }
  for (const c of coarseSeen.values()) {
    if (c.count > coarseKeep) top.push([c.count, "template", c.exemplar]);
  }
  top.sort((a, b) => b[0] - a[0]); // stable, mirrors sort_by_key(Reverse(count))
  if (top.length > TOP_CAP) top.length = TOP_CAP;
  if (suppressed + templateSuppressed > 0) {
    const summary = `── ${suppressed + templateSuppressed} repeated lines suppressed (${suppressed} exact ×N, ${templateSuppressed} same-template; first occurrences kept above) ──`;
    pass2.push(summary);
    pass2Imp.push(IMPORTANT.test(summary));
    for (const [count, kind, exemplar] of top) {
      const tag = kind === "template" ? " (template)" : "";
      const line = `  ×${count}${tag}  ${truncateChars(rustTrim(exemplar), 160)}`;
      pass2.push(line);
      pass2Imp.push(IMPORTANT.test(line));
    }
  }

  // pass 3: optional query filter
  let finalLines: string[];
  if (query != null) {
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch {
      re = new RegExp(query.replace(ESCAPE_RE, "\\$&"), "i");
    }
    const n2 = pass2.length;
    const keep = new Uint8Array(n2);
    for (let idx = 0; idx < n2; idx++) {
      if (pass2Imp[idx] || re.test(pass2[idx])) {
        const lo = idx > context ? idx - context : 0;
        const hi = Math.min(idx + context, n2 - 1);
        keep.fill(1, lo, hi + 1);
      }
    }
    finalLines = [];
    let omitted = 0;
    for (let idx = 0; idx < n2; idx++) {
      if (keep[idx]) {
        if (omitted > 0) {
          finalLines.push(`… ${omitted} lines omitted`);
          omitted = 0;
        }
        finalLines.push(pass2[idx]);
      } else {
        omitted++;
      }
    }
    if (omitted > 0) finalLines.push(`… ${omitted} lines omitted`);
  } else {
    finalLines = pass2;
  }

  const distilled = finalLines.join("\n");
  const origChars = Buffer.byteLength(text); // Rust str::len = UTF-8 bytes
  const outChars = Buffer.byteLength(distilled);
  // Rust f64::round = half away from zero (JS Math.round differs for negatives)
  const pctRaw = (1.0 - outChars / origChars) * 100.0;
  const savedPct =
    text.length === 0 ? 0 : pctRaw < 0 ? -Math.round(-pctRaw) : Math.round(pctRaw);
  const topRepeats = top.map(([count, kind, exemplar]) => ({
    count,
    exemplar: truncateChars(rustTrim(exemplar), 160),
    kind,
  }));
  // Key order matches the Rust binary's serde_json output (BTreeMap = sorted).
  const stats = {
    collapsedRuns,
    importantKept,
    origChars,
    origLines,
    outChars,
    outLines: finalLines.length,
    query: query ?? null,
    savedPct,
    suppressedLines: suppressed,
    templateSuppressed,
    topRepeats,
  };
  return { distilled, stats };
}
