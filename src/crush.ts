// Stage -0.5: run output crushing (rtk-style, prior art rtk-ai/rtk Apache-2.0)
//
// Generic pass: strip \r tails, drop spinner/progress lines
// Rule pass: command-specific noise filters + success elision (exit==0)
// Never-worse guard: if crushing doesn't shrink char count, return original

import { DELTA_MIN, diffRuns, previousRun, recordRun, runKey, type Delta } from "./delta.ts";
import { distillLog } from "./distill.ts";
import { logStash } from "./ledger.ts";
import { charCount, pct, rustTrim, stripJsonSpace, textTokens } from "./serde.ts";
import { stashId, stashText, type MapView, type Stashed } from "./stash.ts";

/** Chars (~2k tokens) of command output handed back inline. */
// ponytail: fixed budget; make it a knob if real usage ever wants one.
export const RUN_INLINE_MAX = 8000;

/** The `run` wrapper's answer for one command's output: crush, distill, and
 *  stash the untouched capture when it is too big to hand back whole. Shared
 *  by the CLI and the pi/omp router; `pointer` names how the caller fetches a
 *  stash back (CLI command vs tool call). When the same command (argv + `cwd`)
 *  already ran in this stash, a delta block leads the output and blocks
 *  identical to that run become pointers (src/delta.ts); `TANUKI_DELTA=off`
 *  turns that off. */
export function routeOutput(
  cmd: string[],
  captured: string,
  code: number,
  query: string | null,
  pointer: (id: string) => string,
  cwd: string = process.cwd(),
): string {
  const crushed = crushOutput(cmd, captured, code);
  let stashed: Stashed | null = null;
  const stash = (): Stashed => (stashed ??= stashText(captured));
  const track = process.env.TANUKI_DELTA !== "off" && cmd.length > 0;
  const key = track ? runKey(cmd, cwd) : "";
  const prev = track ? previousRun(key) : null;
  let delta: Delta | null = null;
  if (prev !== null) {
    const before = crushOutput(cmd, prev.text, prev.code).text;
    delta = diffRuns({ ...prev, text: before, lines: prev.text.split("\n").length }, { text: crushed.text, code });
  }
  if (track && (prev !== null || charCount(captured) >= DELTA_MIN)) {
    try {
      recordRun(key, stash().id, code);
    } catch {
      /* unwritable stash: no delta next time, the run itself is unaffected */
    }
  }
  const head = delta?.head ?? [];
  const capturedLines = captured.split("\n").length;
  const compose = (c: Crushed, body: string | null, mapOnly: boolean, view?: MapView): string => {
    const d = distillLog(body ?? c.text, query, 2);
    const shown = [...head, d.distilled].join("\n");
    let header = `[tanuki run] exit ${code} · ${capturedLines} -> ${d.stats.outLines + head.length} lines · ${pct(charCount(captured), charCount(shown))}% of chars removed`;
    if (c.rule !== null) {
      header += ` · rule ${c.rule}`;
    }
    const lines = [header];
    if (!mapOnly && (charCount(d.distilled) <= RUN_INLINE_MAX || charCount(captured) <= RUN_INLINE_MAX)) {
      lines.push(shown);
      if (charCount(captured) > RUN_INLINE_MAX || delta?.collapsed === true) {
        lines.push(pointer(stash().id));
      }
    } else {
      lines.push(...head, stashText(captured, view).overview);
    }
    return lines.join("\n");
  };
  const out = compose(crushed, delta?.body ?? null, false);
  if (crushed.rule === null || !crushed.rule.includes("managedfields")) return finish(out);
  // Dropping managedFields makes a document readable inline, but a larger
  // answer than the run wrapper gave before that rule existed is a
  // regression: then it is the map, described from the cleaned document.
  const before = compose(crushOutput(cmd, captured, code, false), null, false);
  if (charCount(out) <= charCount(before)) return finish(out);
  return finish(compose(crushed, delta?.body ?? null, true, { text: crushed.text, note: "managedFields dropped" }));

  /** Every answer that points at (or maps) the stash is a ledger row: the
   *  tokens it saved now, so a later fetch can be charged against them. */
  function finish(answer: string): string {
    const id = stashId(captured);
    if (answer.includes(id)) logStash(id, crushed.rule ?? "distill", textTokens(captured) - textTokens(answer));
    return answer;
  }
}

export interface Crushed {
  text: string;
  rule: string | null;
}

export function crushOutput(cmd: string[], text: string, exitCode: number, managed = true): Crushed {
  if (cmd.length === 0 || text === "") {
    return { text, rule: null };
  }

  const original = text;
  const originalChars = charCount(original);

  // Extract basename: strip dirs, strip .exe
  const path = cmd[0];
  let basename = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (basename.endsWith(".exe")) {
    basename = basename.slice(0, -4);
  }
  const sub = cmd[1] ?? "";

  // 1. GENERIC pass
  let lines = text.split("\n");
  let genericChanged = false;

  const processedLines: string[] = [];
  for (const line of lines) {
    // Take substring after last \r
    let processed = line;
    const lastCr = line.lastIndexOf("\r");
    if (lastCr !== -1) {
      processed = line.slice(lastCr + 1);
      genericChanged = true;
    }

    // Drop spinner lines (only when line contains a spinner char)
    const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    const hasSpinner = [...processed].some(c => spinnerChars.includes(c));
    if (hasSpinner && /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ \t]*$/.test(processed)) {
      genericChanged = true;
      continue;
    }

    // Drop bare-progress lines
    if (/^\s*[\[(]?[0-9]{1,3}%[\])]?\s*$/.test(processed)) {
      genericChanged = true;
      continue;
    }

    processedLines.push(processed);
  }

  lines = processedLines;
  let ruleApplied: string | null = null;

  // 2. RULE pass
  if (basename === "cargo") {
    const noise = [
      /^\s*(Compiling|Downloading|Downloaded|Checking|Fresh|Updating|Locking|Adding|Removing|Installing|Installed|Building|Blocking|Running) /,
      /^\s*Finished /,
    ];
    const success = [/test result:/, /^warning/];

    if (exitCode === 0) {
      const successLines = lines.filter(l => success.some(r => r.test(l)));
      if (successLines.length > 0) {
        lines = successLines;
        ruleApplied = "cargo";
      } else {
        const filtered = lines.filter(l => !noise.some(r => r.test(l)));
        if (filtered.length !== lines.length) {
          lines = filtered;
          ruleApplied = "cargo";
        }
      }
    } else {
      const filtered = lines.filter(l => !noise.some(r => r.test(l)));
      if (filtered.length !== lines.length) {
        lines = filtered;
        ruleApplied = "cargo";
      }
    }
  } else if (["npm", "pnpm", "yarn", "bun"].includes(basename) && ["install", "i", "add", "ci", "update", "up"].includes(sub)) {
    const noise = [/^npm (WARN|notice) /, /^> /];
    const success = /^(added|removed|changed|up to date|audited|found [0-9]+ vulnerabilit|[0-9]+ vulnerabilit|Done in|[0-9]+ packages? installed)/;

    if (exitCode === 0) {
      const successLines = lines.filter(l => success.test(l));
      if (successLines.length > 0) {
        lines = successLines;
        ruleApplied = "npm-install";
      } else {
        const filtered = lines.filter(l => !noise.some(r => r.test(l)));
        if (filtered.length !== lines.length) {
          lines = filtered;
          ruleApplied = "npm-install";
        }
      }
    } else {
      const filtered = lines.filter(l => !noise.some(r => r.test(l)));
      if (filtered.length !== lines.length) {
        lines = filtered;
        ruleApplied = "npm-install";
      }
    }
  } else if (["pytest", "py.test"].includes(basename)) {
    const noise = /^[.FEsxX]{4,}$/;
    const success = /^=+ .* =+$/;

    const filtered = lines.filter(l => !noise.test(l));
    if (filtered.length !== lines.length) {
      lines = filtered;
      ruleApplied = "pytest";
    }

    if (exitCode === 0) {
      const successLines = lines.filter(l => success.test(l));
      if (successLines.length > 0) {
        lines = successLines;
        ruleApplied = "pytest";
      }
    }
  } else if (basename === "go" && sub === "test") {
    const noise = /^=== (RUN|PAUSE|CONT) /;
    const success = /^(ok|PASS)\b/;

    const filtered = lines.filter(l => !noise.test(l));
    if (filtered.length !== lines.length) {
      lines = filtered;
      ruleApplied = "go-test";
    }

    if (exitCode === 0) {
      const successLines = lines.filter(l => success.test(l));
      if (successLines.length > 0) {
        lines = successLines;
        ruleApplied = "go-test";
      }
    }
  } else if (basename === "git" && sub === "status") {
    const noise = /^\s*\(use "git .*\)$/;
    const filtered = lines.filter(l => !noise.test(l));
    if (filtered.length !== lines.length) {
      lines = filtered;
      ruleApplied = "git-status";
    }
  } else if (basename === "git" && (sub === "diff" || sub === "show")) {
    const header = /^(diff --git|index |--- |\+\+\+ |@@ )/;
    const result: string[] = [];
    let inHunk = false;
    let hunkBodyCount = 0;
    const droppedPerHunk: number[] = [];
    let currentHunkDropped = 0;

    for (const line of lines) {
      if (header.test(line)) {
        if (inHunk && currentHunkDropped > 0) {
          result.push(`[... ${currentHunkDropped} lines truncated]`);
          droppedPerHunk.push(currentHunkDropped);
        }
        result.push(line);
        inHunk = line.startsWith("@@ ");
        hunkBodyCount = 0;
        currentHunkDropped = 0;
      } else if (inHunk) {
        hunkBodyCount++;
        if (hunkBodyCount <= 100) {
          result.push(line);
        } else {
          currentHunkDropped++;
        }
      } else {
        result.push(line);
      }
    }

    if (inHunk && currentHunkDropped > 0) {
      result.push(`[... ${currentHunkDropped} lines truncated]`);
      droppedPerHunk.push(currentHunkDropped);
    }

    if (droppedPerHunk.length > 0 || result.length !== lines.length) {
      lines = result;
      ruleApplied = "git-diff";
    }
  } else if (basename === "tsc") {
    const noise = /^\s*$/;
    const filtered = lines.filter(l => !noise.test(l));
    if (filtered.length !== lines.length) {
      lines = filtered;
      ruleApplied = "tsc";
    }
  } else if (basename === "eslint") {
    const noise = /^\s*$/;
    const success = /^(✖|.*problems? \()/;

    const filtered = lines.filter(l => !noise.test(l));
    if (filtered.length !== lines.length) {
      lines = filtered;
      ruleApplied = "eslint";
    }

    if (exitCode === 0) {
      const successLines = lines.filter(l => success.test(l));
      if (successLines.length > 0) {
        lines = successLines;
        ruleApplied = "eslint";
      }
    }
  }

  // 2b. CONTENT rules: the shape of the output, not the command name. They
  // chain after a command rule ("cargo+ndjson"), lossless ones first.
  const specific = ruleApplied !== null;
  const content = (name: string, r: string[] | null): void => {
    if (r === null) return;
    lines = r;
    ruleApplied = ruleApplied === null ? name : `${ruleApplied}+${name}`;
  };
  if (managed && basename === "kubectl") content("managedfields", dropManagedFields(lines));
  if (basename === "terraform" || basename === "tofu") content("terraform", collapseTerraform(lines));
  content("ndjson", ndjsonLines(lines));
  if (!specific) content("table", tableTabs(lines));
  if (
    ["ls", "find", "grep", "rg", "fd"].includes(basename) ||
    (basename === "docker" && sub === "ps") ||
    (basename === "kubectl" && sub === "get")
  ) {
    // a document whose managedFields went is "everything else byte-exact", not a row list to cap
    if (lines.length > 200 && !(ruleApplied ?? "").includes("managedfields")) {
      const kept = lines.slice(0, 200);
      const more = lines.length - 200;
      kept.push(`[... ${more} more lines]`);
      lines = kept;
      ruleApplied = ruleApplied === null ? "list-cap" : `${ruleApplied}+list-cap`;
    }
  }

  // 3. ok fallback
  let result = lines.join("\n");
  if (result.trim() === "") {
    result = "ok";
  }

  // 4. never-worse guard
  const resultChars = charCount(result);
  if (resultChars >= originalChars) {
    return { text: original, rule: null };
  }

  // Determine final rule attribution
  let finalRule: string | null = null;
  if (ruleApplied !== null) {
    finalRule = ruleApplied;
  } else if (genericChanged) {
    finalRule = "generic";
  }

  return { text: result, rule: finalRule };
}

/** NDJSON, lossless: every line that is a JSON object/array loses the
 *  whitespace between its tokens (strings stay byte-exact). Tolerant on
 *  purpose - `run` appends stderr, and cargo's `--format json` output has a
 *  `Running ...` line and a trailing `error:` line around the records - so
 *  the rule fires when JSON lines are at least 3 and at least as many as all
 *  other non-blank lines. null = not that shape. */
function ndjsonLines(lines: string[]): string[] | null {
  let json = 0;
  let other = 0;
  const out = lines.map((l) => {
    const t = rustTrim(l);
    if (t[0] === "{" || t[0] === "[") {
      try {
        JSON.parse(t);
        json++;
        return stripJsonSpace(t);
      } catch {
        /* not JSON: falls through to other */
      }
    }
    if (t !== "") other++;
    return l;
  });
  return json >= 3 && json >= other ? out : null;
}

/** kubectl `-o yaml|json` with `--show-managed-fields`: `metadata.managedFields`
 *  is server bookkeeping (which manager touched which field, and when) and is
 *  most of the bytes. Each block becomes one marker line that says how many
 *  lines it replaced (a YAML comment / a one-string JSON array, so the
 *  document still parses); every other line is byte-exact. */
function dropManagedFields(lines: string[]): string[] | null {
  const out: string[] = [];
  let hit = false;
  for (let i = 0; i < lines.length; ) {
    const y = /^( *)managedFields: *$/.exec(lines[i]);
    if (y !== null) {
      const ind = y[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        let s = 0;
        while (l[s] === " ") s++;
        if (s === l.length || !(s > ind || (s === ind && l.startsWith("- ", s)))) break;
        j++;
      }
      out.push(`${y[1]}managedFields: [] # ${j - i} lines dropped`);
      hit = true;
      i = j;
      continue;
    }
    const j = /^( *)"managedFields": \[$/.exec(lines[i]);
    if (j !== null) {
      const close = `${j[1]}]`;
      let k = i + 1;
      while (k < lines.length && lines[k] !== close && lines[k] !== `${close},`) k++;
      if (k < lines.length) {
        out.push(`${j[1]}"managedFields": ["... ${k - i + 1} lines dropped"]${lines[k].endsWith(",") ? "," : ""}`);
        hit = true;
        i = k + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return hit ? out : null;
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** `terraform plan/apply` progress: `<address>: Refreshing state... [id=..]`,
 *  `<address>: Reading...`, `<address>: Read complete after 0s [id=..]`. */
const TF_PROGRESS = /^[A-Za-z](?:[^\s:\[]|\[[^\]]*\])*: (Refreshing state\.\.\.|Reading\.\.\.|Read complete after )/;

/** terraform: the progress lines (one per resource in state, dozens in a real
 *  project) collapse into one count line at the place of the first; every
 *  other line - each `#` header, `+`/`-`/`~` diff line, the `Plan:` summary,
 *  every error - stays byte-exact, ANSI codes included. */
function collapseTerraform(lines: string[]): string[] | null {
  const kinds = ["Refreshing state", "Reading", "Read complete"];
  const counts = [0, 0, 0];
  const out: string[] = [];
  let at = -1;
  for (const l of lines) {
    const m = TF_PROGRESS.exec(l.replace(ANSI, ""));
    if (m === null) {
      out.push(l);
      continue;
    }
    if (at === -1) {
      at = out.length;
      out.push("");
    }
    counts[m[1].startsWith("Refreshing") ? 0 : m[1].startsWith("Reading") ? 1 : 2]++;
  }
  const n = counts[0] + counts[1] + counts[2];
  if (n < 3) return null;
  const parts = kinds.flatMap((k, i) => (counts[i] > 0 ? [`${counts[i]} ${k}`] : []));
  out[at] = `[terraform: ${n} progress lines dropped: ${parts.join(", ")}]`;
  return out;
}

const TABLE_MIN_ROWS = 3;

/** Column-aligned tables (`docker ps`, `kubectl get`, `ps aux`, `df -h`): the
 *  padding between columns becomes one TAB. Columns are the runs of character
 *  positions where at least one line has a non-space, so a gutter exists only
 *  where EVERY line has a space - a value can never be split. A run whose
 *  header cell is blank or whose data cells are all empty belongs to the
 *  previous column (it is a value that spans it). Empty cells stay as
 *  consecutive TABs; trailing empty cells go. Needs a header and 3 rows, no
 *  blank line, no TAB already, a non-blank first cell on every row, and >= 10 %
 *  of the chars saved, or it is prose that happens to align. null = not a table. */
function tableTabs(lines: string[]): string[] | null {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  if (end < 1 + TABLE_MIN_ROWS) return null;
  const rows: string[][] = [];
  let width = 0;
  let before = 0;
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (l === "" || l[0] === " " || l.includes("\t") || rustTrim(l) === "") return null;
    const cs = Array.from(l);
    width = Math.max(width, cs.length);
    before += cs.length;
    rows.push(cs);
  }
  const gutter: boolean[] = new Array(width).fill(true);
  for (const r of rows) for (let p = 0; p < r.length; p++) if (r[p] !== " ") gutter[p] = false;
  const cell = (r: string[], from: number, to: number): string => r.slice(from, to).join("").replace(/^ +| +$/g, "");
  const starts: number[] = [];
  for (let p = 0; p < width; ) {
    if (gutter[p]) {
      p++;
      continue;
    }
    let q = p;
    while (q < width && !gutter[q]) q++;
    if (starts.length === 0 || (cell(rows[0], p, q) !== "" && rows.slice(1).some((r) => cell(r, p, q) !== ""))) starts.push(p);
    p = q;
  }
  if (starts.length < 2) return null;
  const out = rows.map((r) => {
    const cells = starts.map((s, c) => cell(r, s, c + 1 < starts.length ? starts[c + 1] : r.length));
    return cells.join("\t").replace(/\t+$/, "");
  });
  if (out.some((o) => o[0] === "\t" || o === "")) return null;
  const after = out.reduce((a, o) => a + Array.from(o).length, 0);
  if ((before - after) * 10 < before) return null;
  return [...out, ...lines.slice(end)];
}
