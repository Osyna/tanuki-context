// Stage -0.5: run output crushing (rtk-style, prior art rtk-ai/rtk Apache-2.0)
//
// Generic pass: strip \r tails, drop spinner/progress lines
// Rule pass: command-specific noise filters + success elision (exit==0)
// Never-worse guard: if crushing doesn't shrink char count, return original

import { charCount } from "./serde.ts";

export interface Crushed {
  text: string;
  rule: string | null;
}

export function crushOutput(cmd: string[], text: string, exitCode: number): Crushed {
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
  } else if (
    ["ls", "find", "grep", "rg", "fd"].includes(basename) ||
    (basename === "docker" && sub === "ps") ||
    (basename === "kubectl" && sub === "get")
  ) {
    if (lines.length > 200) {
      const kept = lines.slice(0, 200);
      const more = lines.length - 200;
      kept.push(`[... ${more} more lines]`);
      lines = kept;
      ruleApplied = "list-cap";
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
  } else if (genericChanged || result !== original) {
    finalRule = "generic";
  }

  return { text: result, rule: finalRule };
}
