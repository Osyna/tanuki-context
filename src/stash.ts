//! Stash mode: context-mode's shape (content parked outside the context
//! window, queried on demand) fused with tanuki's pricing (big answers come
//! back as dense pages).
//!
//! stash = write the text to a content-addressed file and pay a few hundred
//! tokens for a deterministic map of what's there (distill stats, top
//! repeats, first/last lines, the id). fetch = pull a slice by regex query
//! (distill-powered) or line range; the caller images it only when pages
//! clearly win. Contract is byte-identical with the Rust engine.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { distillLog } from "./distill.ts";
import { cmpCodepoints, rustTrim, truncateChars } from "./serde.ts";

function stashDir(): string {
  const env = process.env.TANUKI_STASH;
  if (env !== undefined && env !== "") return env;
  return `${process.env.HOME ?? ""}/.tanuki/stash`;
}

export interface Stashed {
  id: string;
  overview: string;
}

export function stashText(text: string): Stashed {
  const id = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  const dir = stashDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${id}`, text);

  const bytes = Buffer.byteLength(text, "utf8");
  const segments = text.split("\n");
  const stats = distillLog(text, null, 2).stats as {
    origLines: number;
    outLines: number;
    savedPct: number;
    importantKept: number;
    topRepeats: { count: number; exemplar: string; kind: string }[];
  };

  const lines: string[] = [
    `stashed ${id} · ${bytes} bytes · ${segments.length} lines`,
    `distill map: ${stats.origLines} -> ${stats.outLines} lines · ${stats.savedPct}% of chars removable · ${stats.importantKept} error/warn lines`,
  ];
  if (stats.topRepeats.length > 0) {
    lines.push("top repeats:");
    for (const r of stats.topRepeats.slice(0, 5)) {
      const tag = r.kind === "template" ? " (template)" : "";
      lines.push(`  ×${r.count}${tag}  ${r.exemplar}`);
    }
  }
  let last = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "") {
      last = segments[i];
      break;
    }
  }
  lines.push(`first: ${truncateChars(rustTrim(segments[0]), 160)}`);
  lines.push(`last: ${truncateChars(rustTrim(last), 160)}`);
  lines.push(`fetch: tanuki_fetch {"id":"${id}","query":"<regex>"} or {"id":"${id}","lines":"a-b"}`);
  return { id, overview: lines.join("\n") };
}

/** Pull a slice of a stashed text. Throws Error with the contract message on
 *  bad input; the caller maps it to a tool error / CLI fatal. */
export function fetchSlice(id: string, query: string | null, lines: string | null): string {
  if ((query === null) === (lines === null)) {
    throw new Error("give exactly one of query or lines");
  }
  let text: string;
  try {
    text = readFileSync(`${stashDir()}/${id}`, "utf8");
  } catch {
    throw new Error(`unknown stash id: ${id}`);
  }
  if (lines !== null) {
    const m = /^(\d+)-(\d+)$/.exec(lines);
    if (m === null) throw new Error("bad lines range");
    const segments = text.split("\n");
    const a = Math.max(1, Number(m[1]));
    const b = Math.min(segments.length, Number(m[2]));
    if (Number(m[1]) > Number(m[2])) throw new Error("bad lines range");
    return segments.slice(a - 1, b).join("\n");
  }
  return distillLog(text, query, 2).distilled;
}

export interface VerifyResult {
  status: "exact" | "corrected" | "ambiguous" | "absent";
  line: number | null;
  found: string | null;
  candidates: string[];
}

/// ponytail: below this length a distance-1 neighborhood is mostly noise
/// (every short string is one edit from dozens of others), so short values
/// get an exact-or-absent answer only. Raise if a real value class needs it.
const MIN_FUZZY_LEN = 4;
const VERIFY_CAND_CAP = 8;

/// Disk-grounded exact check for a value read off a rendered page. No model in
/// the loop: the original bytes are already stashed, so a plausible-wrong-
/// character misread becomes an `exact` match, a unique `corrected` string, an
/// `ambiguous` shortlist, or an explicit `absent` flag - never a silent guess.
/// Parity-locked with the Rust engine (same scan order, same code-point math).
export function verifyValue(id: string, value: string): VerifyResult {
  if (value === "") throw new Error("verify needs a non-empty value");
  let text: string;
  try {
    text = readFileSync(`${stashDir()}/${id}`, "utf8");
  } catch {
    throw new Error(`unknown stash id: ${id}`);
  }

  const idx = text.indexOf(value);
  if (idx >= 0) {
    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (text[i] === "\n") line++;
    }
    return { status: "exact", line, found: value, candidates: [] };
  }

  const val = [...value];
  const n = val.length;
  if (n < MIN_FUZZY_LEN) return { status: "absent", line: null, found: null, candidates: [] };

  const cps = [...text];
  // 1-based line of every code point, one pass.
  const lineAt = new Int32Array(cps.length);
  let ln = 1;
  for (let i = 0; i < cps.length; i++) {
    lineAt[i] = ln;
    if (cps[i] === "\n") ln++;
  }

  // Distance-1 neighbourhood, same length only: one substitution (the dominant
  // dense-glyph misread 0/O, 5/S, 1/l) or one adjacent transposition (a digit
  // swap like f0->0f, observed in real read-backs). Both preserve length, so a
  // window cannot match a fragment of a longer token the way an indel would
  // (ponytail: indels would need token-boundary awareness and are not
  // fragment-safe; not worth it).
  const found = new Map<string, number>();
  if (n <= cps.length) {
    for (let off = 0; off + n <= cps.length; off++) {
      let diffs = 0;
      let a = -1;
      let b = -1;
      for (let i = 0; i < n; i++) {
        if (val[i] !== cps[off + i]) {
          diffs++;
          if (diffs === 1) a = i;
          else if (diffs === 2) b = i;
          else break;
        }
      }
      const match =
        diffs === 1 ||
        (diffs === 2 && b === a + 1 && val[a] === cps[off + b] && val[b] === cps[off + a]);
      if (match) {
        const s = cps.slice(off, off + n).join("");
        if (!found.has(s)) found.set(s, lineAt[off]);
      }
    }
  }

  if (found.size === 0) return { status: "absent", line: null, found: null, candidates: [] };
  if (found.size === 1) {
    const [s, line] = [...found][0];
    return { status: "corrected", line, found: s, candidates: [] };
  }
  const candidates = [...found.keys()].sort(cmpCodepoints).slice(0, VERIFY_CAND_CAP);
  return { status: "ambiguous", line: null, found: null, candidates };
}
