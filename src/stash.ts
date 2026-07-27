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
import { rustTrim, truncateChars } from "./serde.ts";

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
