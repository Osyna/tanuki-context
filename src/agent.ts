//! Claude Agent SDK integration (`tanuki-context/agent`).
//!
//! Two flavours, both one-liners from an agent's point of view:
//!
//!   external (subprocess per session, works everywhere):
//!     import { query } from "@anthropic-ai/claude-agent-sdk";
//!     import { withTanuki } from "tanuki-context/agent";
//!     for await (const m of query({ prompt, options: withTanuki() })) { ... }
//!
//!   in-process (one process shared by a whole team of agents):
//!     import { tanukiSdkServer, tanukiAllowedTools, TANUKI_INSTRUCTIONS } from "tanuki-context/agent";
//!     const tanuki = await tanukiSdkServer();
//!     query({ prompt, options: { mcpServers: { tanuki }, allowedTools: tanukiAllowedTools() } })
//!
//! The core package stays zero-dependency: the SDK and zod are touched only
//! inside `tanukiSdkServer()` via dynamic import, and both are already present
//! in any Agent SDK project (zod is the SDK's own peer dependency).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jstring, toolCompress, toolDistill, toolEstimate, toolRender, VERSION } from "./main.ts";
import { pxStats } from "./stats.ts";

export const TANUKI_TOOL_NAMES = [
  "tanuki_render",
  "tanuki_estimate",
  "tanuki_distill",
  "tanuki_compress",
  "tanuki_stats",
] as const;

/// Canned guidance for agents. Used as the SDK server `instructions` block and
/// exported so teams can append it to a shared system prompt.
export const TANUKI_INSTRUCTIONS = `tanuki-context turns bulky text (logs, command output, docs) into dense PNG pages that cost a fraction of the text tokens.
Workflow: call tanuki_estimate first (instant, exact, never renders pixels). Its "recommend" field already names the cheapest safe knob set, priced - do not probe combos by hand. If the verdict says "PIPELINE cheaper", call tanuki_render with the recommended knobs and use the returned pages instead of pasting the text.
For logs, pass distill:true (repeats collapse, error/warn lines stay verbatim; add query:"regex" to slice). For prose you will not quote verbatim, level 2-3 shrinks it further. codebook:true helps path-heavy logs. Never image content you must quote byte-exact at level 4 or font tiny.
Pages decode as: \u21b5 = newline, \u2192 = tab, \u21e5N = N leading spaces, a trailing \u00b7legend\u00b7 line maps sigils back to full tokens.`;

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/// External stdio MCP server config for `options.mcpServers`. Resolves the
/// installed dist/cli.js next to this module (published layout); falls back to
/// npx when running from source.
export function tanukiMcpServer(): StdioServerConfig {
  const cli = new URL("./cli.js", import.meta.url);
  if (cli.protocol === "file:") {
    const p = fileURLToPath(cli);
    if (existsSync(p)) {
      return { type: "stdio", command: process.execPath, args: [p] };
    }
  }
  return { type: "stdio", command: "npx", args: ["-y", "tanuki-context"] };
}

/// The SDK names MCP tools `mcp__<serverKey>__<tool>`; pass the key you used
/// in `mcpServers` (default "tanuki").
export function tanukiAllowedTools(key = "tanuki"): string[] {
  return TANUKI_TOOL_NAMES.map((t) => `mcp__${key}__${t}`);
}

export interface TanukiOptions {
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  [k: string]: unknown;
}

/// Merge tanuki into an Agent SDK options object: registers the server under
/// `key` and appends the allowed-tool names. Pass `server` to use an
/// in-process instance from `tanukiSdkServer()` instead of the stdio default.
export function withTanuki<T extends TanukiOptions>(
  options?: T,
  opts: { key?: string; server?: unknown } = {},
): T & TanukiOptions {
  const base: TanukiOptions = options ?? {};
  const key = opts.key ?? "tanuki";
  return {
    ...(base as T),
    mcpServers: { ...(base.mcpServers ?? {}), [key]: opts.server ?? tanukiMcpServer() },
    allowedTools: [...(base.allowedTools ?? []), ...tanukiAllowedTools(key)],
  };
}

// ------------------------------------------------- in-process SDK server

/// Minimal structural view of the zod surface the schemas use; satisfied by
/// zod 3 and 4 (the Agent SDK accepts both).
export interface ZodChain {
  optional(): ZodChain;
  int(): ZodChain;
  min(n: number): ZodChain;
  max(n: number): ZodChain;
  describe(text: string): ZodChain;
}
export interface ZodNamespace {
  string(): ZodChain;
  boolean(): ZodChain;
  number(): ZodChain;
  enum(values: readonly [string, ...string[]]): ZodChain;
}

export interface SdkToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, ZodChain>;
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
}

/// The five MCP tools as SDK tool specs. Handlers produce byte-identical
/// content to the stdio server's tools/call path.
export function tanukiSdkToolSpecs(z: ZodNamespace): SdkToolSpec[] {
  const text = z.string().describe("the bulky text to process");
  const level = z.number().int().min(0).max(4).optional().describe("ladder level 0-4 (default 0)");
  const pipe: Record<string, ZodChain> = {
    text,
    level,
    distill: z.boolean().optional().describe("stage 0 log distiller"),
    query: z.string().optional().describe("distill: keep matching lines +context"),
    reflow: z.boolean().optional().describe("pack short lines into full rows (default true)"),
    pack: z.boolean().optional().describe("indent RLE + width trim, lossless (default true)"),
    font: z.enum(["normal", "tiny"]).optional().describe("tiny = 4x6 cells, ~40% fewer tokens, gated"),
    codebook: z.boolean().optional().describe("repeated tokens/paths -> sigils + legend"),
  };
  const wrap = (blocks: unknown[]): { content: unknown[] } => ({ content: blocks });
  const guard = async (fn: () => unknown[]): Promise<{ content: unknown[]; isError?: boolean }> => {
    try {
      return wrap(fn());
    } catch (e) {
      return { content: [{ type: "text", text: `tanuki-context error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
  return [
    {
      name: "tanuki_render",
      description: "Render text through the pipeline (optional distill/level/codebook) into dense PNG pages. Call after tanuki_estimate says PIPELINE cheaper.",
      inputSchema: pipe,
      handler: (args) => guard(() => toolRender(args)),
    },
    {
      name: "tanuki_estimate",
      description: "Exact page/token math for the same arguments as tanuki_render, without touching pixels. Instant; call this first.",
      inputSchema: pipe,
      handler: (args) => guard(() => [{ type: "text", text: jstring(toolEstimate(args), true) }]),
    },
    {
      name: "tanuki_distill",
      description: "Stage 0 alone: collapse repeated log lines/blocks and template near-dupes; error/warn lines kept verbatim. Output stays greppable text.",
      inputSchema: { text, query: pipe.query },
      handler: (args) => guard(() => toolDistill(args)),
    },
    {
      name: "tanuki_compress",
      description: "Stage 1 alone: graded text compression, levels 0-4, code/paths/hashes protected from level 2 up.",
      inputSchema: { text, level },
      handler: (args) => guard(() => toolCompress(args)),
    },
    {
      name: "tanuki_stats",
      description: "Session savings summary from the events log (honest denominator: input + cache reads + cache creates).",
      inputSchema: {},
      handler: () => guard(() => [{ type: "text", text: jstring(pxStats(), true) }]),
    },
  ];
}

interface AgentSdkModule {
  tool(
    name: string,
    description: string,
    schema: Record<string, ZodChain>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ): unknown;
  createSdkMcpServer(opts: {
    name: string;
    version?: string;
    instructions?: string;
    tools: unknown[];
  }): unknown;
}

/// In-process MCP server for `options.mcpServers` — no subprocess, one
/// instance shareable across every agent in the process. Requires
/// @anthropic-ai/claude-agent-sdk (and its zod peer) in the host project.
export async function tanukiSdkServer(): Promise<unknown> {
  let sdk: AgentSdkModule;
  let z: ZodNamespace;
  try {
    // dynamic import by design: both are OPTIONAL peers that exist only in
    // host projects using the Agent SDK. A static import would make this
    // module (and withTanuki/tanukiMcpServer, which need neither) crash at
    // load for everyone else; the ts-no-dynamic-import platform exception.
    sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as AgentSdkModule;
    const zm = (await import("zod")) as unknown as { z?: ZodNamespace } & ZodNamespace;
    z = zm.z ?? zm;
  } catch (e) {
    throw new Error(
      "tanukiSdkServer() needs the host project's @anthropic-ai/claude-agent-sdk and zod " +
        `(npm i @anthropic-ai/claude-agent-sdk zod). Import failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const tools = tanukiSdkToolSpecs(z).map((s) =>
    sdk.tool(s.name, s.description, s.inputSchema, (args) => s.handler(args)),
  );
  return sdk.createSdkMcpServer({
    name: "tanuki-context",
    version: VERSION,
    instructions: TANUKI_INSTRUCTIONS,
    tools,
  });
}
