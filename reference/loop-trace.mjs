// Trace what the agent actually DOES in the tanuki-on arm of paired-report.
// Same corpus, same prompt, but every tool call and result is logged so the
// thrash in EVALS §6 is visible instead of inferred. Env-only key.
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { opsCorpus } from "./lib/corpus.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "dist", "cli.js");

const { text: LOG, answers: { reqId } } = opsCorpus();
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
