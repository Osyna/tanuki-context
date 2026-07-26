//! Pi (pi-mono / oh-my-pi lineage) extension: registers the five tanuki tools.
//!
//! Engine-agnostic by design: the extension is a thin stdio JSON-RPC client to
//! a `tanuki-context` MCP server it spawns itself, so the same file serves
//! - the npm/TS engine (default: `node <this package>/dist/cli.js`), and
//! - the Rust engine (`TANUKI_BIN=/path/to/tanuki-context`).
//! One child per pi session, spawned lazily on first tool call (pi docs forbid
//! starting processes in the factory), killed on session_shutdown.
//!
//! MCP tool-result content blocks ({type:"text"|"image"}) are pi's own
//! ToolResult content shape, so results pass through untouched.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface McpResult {
  content?: McpContent[];
  isError?: boolean;
}

function serverCommand(): { cmd: string; args: string[] } {
  const bin = process.env.TANUKI_BIN;
  if (bin) return { cmd: bin, args: [] };
  // dist/pi.js sits next to dist/cli.js; process.execPath = the node running pi
  return { cmd: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url))] };
}

class TanukiClient {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: McpResult) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<unknown>;

  constructor() {
    const { cmd, args } = serverCommand();
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) continue;
        this.pending.delete(msg.id!);
        if (msg.error) p.reject(new Error(msg.error.message ?? "tanuki-context error"));
        else p.resolve(msg.result as McpResult);
      }
    });
    this.proc.on("exit", (code) => {
      const err = new Error(`tanuki-context server exited (code ${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.ready = this.request("initialize", {});
  }

  private request(method: string, params: unknown): Promise<McpResult> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<McpResult>();
    if (!this.proc.stdin?.writable) {
      reject(new Error("tanuki-context server is gone"));
      return promise;
    }
    this.pending.set(id, { resolve, reject });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
    await this.ready;
    return this.request("tools/call", { name, arguments: args });
  }

  kill(): void {
    this.proc.kill();
  }

  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }
}

const textProp = Type.String({ description: "The text to process" });
const levelProp = Type.Optional(
  Type.Integer({ minimum: 0, maximum: 4, description: "0 raw · 1 whitespace · 2 prose · 3 dense · 4 caveman" }),
);
const pipelineParams = Type.Object({
  text: textProp,
  level: levelProp,
  distill: Type.Optional(Type.Boolean()),
  query: Type.Optional(Type.String()),
  reflow: Type.Optional(Type.Boolean()),
  pack: Type.Optional(Type.Boolean()),
  font: Type.Optional(Type.String({ enum: ["normal", "tiny"] })),
  codebook: Type.Optional(Type.Boolean()),
});

const TOOLS: { name: string; label: string; description: string; parameters: unknown; snippet: string }[] = [
  {
    name: "tanuki_render",
    label: "Tanuki Render",
    description:
      "Token-cut pipeline: optional log distillation (dedupe noise, keep errors verbatim, optional query filter), optional codebook (repeated long tokens/path prefixes -> 1-cell sigils + a ·legend· line), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. pack (default true) = lossless tight reflow. font 'tiny' = 4x6 cell, ~40% fewer image-tokens (opt-in). Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
    parameters: pipelineParams,
    snippet: "Render bulky text/logs as dense PNG pages that cost a fraction of the tokens",
  },
  {
    name: "tanuki_estimate",
    label: "Tanuki Estimate",
    description:
      "Estimate tokens for the pipeline (distill -> codebook -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/pack/font/codebook to pick a loss/size tradeoff. The result's 'recommend' field names the cheapest safe knob set (level 0), so one call replaces manual knob probing.",
    parameters: pipelineParams,
    snippet: "Instant token verdict: would imaging this text beat sending it as text?",
  },
  {
    name: "tanuki_distill",
    label: "Tanuki Distill",
    description:
      "Stage 0 alone: make noisy logs/output small and readable WITHOUT imaging. Strips ANSI, collapses runs of near-identical lines/blocks into '[×N similar]', suppresses global near-dupes with exact counts, always keeps error/warn/fail lines verbatim, optional query (regex) returns only the relevant slice. Deterministic, order-preserving.",
    parameters: Type.Object({ text: textProp, query: Type.Optional(Type.String()) }),
    snippet: "Deterministically dedupe noisy logs, keeping every error line verbatim",
  },
  {
    name: "tanuki_compress",
    label: "Tanuki Compress",
    description:
      "Stage 1 alone: graded text compression for content that stays TEXT. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths are preserved verbatim.",
    parameters: Type.Object({ text: textProp, level: levelProp }),
    snippet: "Graded text compression (lossless whitespace up to gist-only)",
  },
  {
    name: "tanuki_stats",
    label: "Tanuki Stats",
    description:
      "Summarize the pxpipe measurement log (~/.pxpipe/events.jsonl): requests, compression counts, honest input-token savings (input + cache reads + cache creates).",
    parameters: Type.Object({}),
    snippet: "Session savings summary from the tanuki/pxpipe event log",
  },
];

export default function (pi: ExtensionAPI) {
  let client: TanukiClient | null = null;
  const getClient = () => {
    if (!client || !client.alive) client = new TanukiClient();
    return client;
  };

  pi.on("session_shutdown", async () => {
    client?.kill();
    client = null;
  });

  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.snippet,
      // biome-ignore lint/suspicious/noExplicitAny: typebox schema is structurally a TSchema
      parameters: t.parameters as any,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const res = await getClient().call(t.name, params ?? {});
        const content = (res.content ?? []).map((c) =>
          c.type === "image"
            ? { type: "image" as const, data: c.data ?? "", mimeType: c.mimeType ?? "image/png" }
            : { type: "text" as const, text: c.text ?? "" },
        );
        if (res.isError) throw new Error(content.map((c) => ("text" in c ? c.text : "")).join("\n") || t.name + " failed");
        return { content, details: {} };
      },
    });
  }
}
