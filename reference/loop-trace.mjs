// Trace what the agent actually DOES in the tanuki-on arm of paired-report.
// Same corpus, same prompt, but every tool call and result is logged so the
// thrash in EVALS §6 is visible instead of inferred. Env-only key.
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "dist", "cli.js");

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");
function corpus() {
  const r = lcg(41);
  const units = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
  const lines = [];
  for (let i = 0; i < 1200; i++) {
    const ts = `2026-07-27T${String(8 + ((i / 300) | 0)).padStart(2, "0")}:${String((i / 5) % 60 | 0).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    const u = units[(r() * units.length) | 0];
    if (r() < (u === "ingest" ? 0.09 : 0.015)) lines.push(`${ts} ${u} ERROR request failed status=502 retry=${(r() * 3) | 0}`);
    else lines.push(`${ts} ${u} INFO poll ok latency=${1 + ((r() * 40) | 0)}ms conn=${(r() * 9) | 0}`);
  }
  const reqId = hex(lcg(43), 12);
  lines.splice(400, 0, `2026-07-27T08:40:00Z relay ERROR upstream 502 request-id=${reqId} peer=10.0.4.2:8443`);
  lines.splice(800, 0, `2026-07-27T09:10:00Z relay WARN rollback: pinned to 9.4.1-rc.2 after failed canary`);
  lines.splice(801, 0, `2026-07-27T09:10:01Z relay ERROR digest mismatch, expected sha256:${hex(lcg(47), 16)}`);
  return { text: `${lines.join("\n")}\n`, reqId };
}

const { text: LOG, reqId } = corpus();
const tmp = mkdtempSync(path.join(os.tmpdir(), "tanuki-trace-"));
process.env.TANUKI_STASH = path.join(tmp, "stash");
const logFile = path.join(tmp, "service.log");
writeFileSync(logFile, LOG);
const stashMap = execFileSync("node", [CLI, "stash", logFile], { encoding: "utf8" }).trim();

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { withTanuki } = await import(path.join(ROOT, "dist", "agent.js"));

const q = "What is the request-id on the upstream 502 error line? Answer with the id only, verbatim.";
const prompt =
  `A service log was parked with tanuki_stash. Its map:\n\n${stashMap}\n\n` +
  `Use the tanuki tools (tanuki_fetch with a query or line range; estimate/render if useful) to read only what you need, then answer.\n${q}`;

console.log(`ground truth request-id: ${reqId}`);
console.log(`stash map is ${stashMap.length} chars\n--- trace ---`);

const opts = withTanuki({ maxTurns: Number(process.env.TURNS ?? 12), model: process.env.MODEL ?? "claude-sonnet-5", allowedTools: [] });
let turn = 0;
let usd = 0;
try {
  for await (const m of query({ prompt, options: opts })) {
    if (m.type === "assistant") {
      turn++;
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") {
          const args = JSON.stringify(b.input ?? {});
          console.log(`t${turn} CALL ${b.name} ${args.slice(0, 130)}`);
        } else if (b.type === "text" && b.text.trim()) {
          console.log(`t${turn} SAY  ${b.text.trim().slice(0, 130).replace(/\n/g, " ")}`);
        }
      }
    } else if (m.type === "user") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_result") {
          const c = b.content;
          const parts = Array.isArray(c) ? c : [{ type: "text", text: String(c) }];
          const shape = parts
            .map((p) => (p.type === "image" ? `image(${Math.round((p.source?.data?.length ?? 0) / 1024)}KB)` : `text(${(p.text ?? "").length}ch)`))
            .join("+");
          const firstText = parts.find((p) => p.type === "text")?.text ?? "";
          const hit = firstText.includes(reqId) ? "  <<< CONTAINS ANSWER" : "";
          console.log(`     -> ${shape}${hit}  ${firstText.slice(0, 110).replace(/\n/g, " ")}`);
        }
      }
    } else if (m.type === "result") {
      usd = m.total_cost_usd ?? 0;
      const u = m.usage ?? {};
      const inSide = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      console.log(`\n--- result: ${m.subtype} | $${usd.toFixed(4)} | input-side ${inSide} tokens`);
      console.log(`answer: ${(m.subtype === "success" ? m.result : "").slice(0, 200)}`);
      console.log(`correct: ${(m.subtype === "success" ? m.result : "").includes(reqId)}`);
    }
  }
} catch (e) {
  console.log(`\n--- threw: ${String(e.message ?? e).slice(0, 200)} | $${usd.toFixed(4)}`);
}
