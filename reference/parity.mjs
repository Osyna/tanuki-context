#!/usr/bin/env node
// Parity harness: run the SAME input through the node reference implementation
// and the rust binary, compare distill counts and render page/token geometry.
//   node reference/parity.mjs [file...]        (defaults: a synthetic log + this script)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { distillLog } from "./node-mcp/distill.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.TANUKI_BIN || path.join(HERE, "..", "target", "release", "tanuki-context");
const PXPIPE = process.env.PXPIPE_ROOT || path.join(process.env.HOME, "Projects", "pxpipe");
const { renderTextToImages } = await import(path.join(PXPIPE, "dist", "core", "index.js"));
const neutralize = (s) => s.replace(/\u21b5/g, "\u23ce");

function syntheticLog() {
  const L = [];
  for (let i = 0; i < 300; i++) {
    const ts = `2026-07-15T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.123Z`;
    L.push(`${ts} INFO  heartbeat ok latency=${3 + (i % 7)}ms conn=a1b2c3d${i}e`);
    if (i % 3 === 0) L.push(`${ts} INFO  poll queue depth=${i % 11} worker=w-${i % 4}`);
  }
  L.push("2026-07-15T10:05:01.999Z ERROR connection refused to db-primary:5432 after 3 retries");
  for (let i = 0; i < 100; i++) L.push(`2026-07-15T10:06:${String(i % 60).padStart(2, "0")}.000Z INFO  retry backoff sleeping 500ms`);
  return L.join("\n");
}

const files = process.argv.slice(2);
const samples = files.length
  ? files.map((f) => ({ name: path.basename(f), file: f }))
  : (() => {
      const tmp = path.join(os.tmpdir(), "parity-log.txt");
      writeFileSync(tmp, syntheticLog());
      return [
        { name: "synthetic log", file: tmp },
        { name: "this script", file: fileURLToPath(import.meta.url) },
      ];
    })();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

for (const { name, file } of samples) {
  const text = readFileSync(file, "utf8");
  console.log(`\n== ${name} (${text.length} chars) ==`);

  // distill parity: exact-tier counts must match; template tier within 0.1%
  // (documented JS<->Rust \b nuance on unicode-adjacent tokens).
  const js = distillLog(text).stats;
  const rs = JSON.parse(execFileSync(BIN, ["distill", file], { encoding: "utf8", maxBuffer: 1 << 28 }));
  check("distill exact tier", js.suppressedLines === rs.suppressedLines, `${js.suppressedLines} vs ${rs.suppressedLines}`);
  check("distill runs", js.collapsedRuns === rs.collapsedRuns, `${js.collapsedRuns} vs ${rs.collapsedRuns}`);
  check("distill important", js.importantKept === rs.importantKept, `${js.importantKept} vs ${rs.importantKept}`);
  const tmplDelta = Math.abs((js.templateSuppressed ?? 0) - (rs.templateSuppressed ?? 0));
  check("distill template tier <=0.1%", tmplDelta <= Math.max(3, (js.templateSuppressed ?? 0) * 0.001), `delta ${tmplDelta}`);

  // render parity: identical page count and image tokens (28-px patch grid).
  const { pages } = await renderTextToImages(neutralize(text), { reflow: true });
  const patches = pages.reduce((a, p) => a + Math.ceil((p.width || 0) / 28) * Math.ceil((p.height || 0) / 28), 0);
  const nodeR = { pages: pages.length, imageTokens: patches };
  const rustR = JSON.parse(execFileSync(BIN, ["render", file, "0", "--no-pack"], { encoding: "utf8", maxBuffer: 1 << 28 }));
  check("render pages", nodeR.pages === rustR.pages, `${nodeR.pages} vs ${rustR.pages}`);
  check("render tokens", nodeR.imageTokens === rustR.imageTokens, `${nodeR.imageTokens} vs ${rustR.imageTokens}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
