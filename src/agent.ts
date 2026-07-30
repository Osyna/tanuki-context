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
import { toolCompress, toolDistill, toolEstimate, toolFetch, toolRender, toolStash, toolVerify, VERSION } from "./main.ts";
import { jstring } from "./serde.ts";
import { pxStats } from "./stats.ts";
import { TOOLS, type Knob } from "./tools.ts";

export const TANUKI_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/// Canned guidance for agents. Used as the SDK server `instructions` block and
/// exported so teams can append it to a shared system prompt.
export const TANUKI_INSTRUCTIONS = `tanuki-context turns bulky text (logs, command output, docs) into dense PNG pages that cost a fraction of the text tokens.
Workflow: call tanuki_estimate first (instant, exact, never renders pixels). Its "recommend" field prices the reversible route (including table for whole-JSON input); for logs, recommend.withDistill prices the distill route - do not probe combos by hand. If the verdict says "PIPELINE cheaper", call tanuki_render with the recommended knobs and use the returned pages instead of pasting the text. Pass model:"<your model>" and cached:true when the text is already in the prompt cache - the returned "cost" field prices it in real dollars with provider-correct image counting (Anthropic/OpenAI/Gemini), and cached content usually should NOT be imaged (a cache-read token is ~0.1x a fresh one).
For logs, pass distill:true (repeats collapse, error/warn lines stay verbatim; add query:"regex" to slice). For whole-JSON input (arrays of objects, NDJSON), table:true states keys once - value-lossless, and identical rows then collapse harder under distill. For prose you will not quote verbatim, level 2-3 shrinks it further. codebook:true helps path-heavy logs. Never image content you must quote byte-exact at level 4 or font tiny.
For huge references you will only consult occasionally: tanuki_stash parks the text outside context for a few hundred tokens of map; tanuki_fetch pulls slices later, auto-imaged when pages win; tanuki_verify checks a value you read off a page against the stashed original (exact/corrected/ambiguous/absent, no model).
Never transcribe an id, hash, version, path or numeric constant from a rendered page as fact: quote it from the verbatim sidecar, or confirm it with tanuki_verify/tanuki_fetch. If a value is not recoverable, say so - never emit a plausible-looking guess.
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
///
/// `env` names the variables the spawned server gets. It exists because the
/// alternative — mutating `process.env` and hoping the SDK spawns a fresh
/// server per call — silently couples measurement arms: an eval that varies
/// TANUKI_VERBATIM between arms cannot prove a later arm did not read the
/// earlier arm's value, so the comparison is unpublishable. Naming the
/// variables here makes the experiment reproducible.
///
/// Additive, never replacing: the MCP stdio transport spawns with
/// `{ ...getDefaultEnvironment(), ...env }` (@modelcontextprotocol/sdk
/// client/stdio.js), so these land on top of the inherited safe set.
/// Omitted when absent, so the zero-arg config is byte-identical to before.
export function tanukiMcpServer(env?: Record<string, string>): StdioServerConfig {
  const cli = new URL("./cli.js", import.meta.url);
  const base: StdioServerConfig =
    cli.protocol === "file:" && existsSync(fileURLToPath(cli))
      ? { type: "stdio", command: process.execPath, args: [fileURLToPath(cli)] }
      : { type: "stdio", command: "npx", args: ["-y", "tanuki-context"] };
  return env ? { ...base, env } : base;
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
/// in-process instance from `tanukiSdkServer()` instead of the stdio default;
/// `env` then has no effect, since there is no subprocess to hand it to.
export function withTanuki<T extends TanukiOptions>(
  options?: T,
  opts: { key?: string; server?: unknown; env?: Record<string, string> } = {},
): T & TanukiOptions {
  const base: TanukiOptions = options ?? {};
  const key = opts.key ?? "tanuki";
  return {
    ...(base as T),
    mcpServers: { ...(base.mcpServers ?? {}), [key]: opts.server ?? tanukiMcpServer(opts.env) },
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
  union(options: ZodChain[]): ZodChain;
}

export interface SdkToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, ZodChain>;
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
}

/// zod projection of the registry knobs (the SDK's inputSchema shape).
function zodShape(z: ZodNamespace, params: Knob[]): Record<string, ZodChain> {
  const shape: Record<string, ZodChain> = {};
  for (const p of params) {
    let c: ZodChain;
    if (p.type === "boolean") {
      c = z.boolean();
    } else if (p.type === "integer") {
      c = z.number().int();
      if (p.min !== undefined) c = c.min(p.min);
      if (p.max !== undefined) c = c.max(p.max);
    } else if (p.values !== undefined) {
      c = z.enum(p.values as readonly [string, ...string[]]);
    } else {
      c = z.string();
    }
    if (p.required !== true) c = c.optional();
    if (p.hint !== undefined) c = c.describe(p.hint);
    shape[p.key] = c;
  }
  return shape;
}

/// The MCP tools as SDK tool specs, projected from the registry. Handlers
/// produce byte-identical content to the stdio server's tools/call path.
export function tanukiSdkToolSpecs(z: ZodNamespace): SdkToolSpec[] {
  const run: Record<string, (args: unknown) => unknown[]> = {
    tanuki_render: toolRender,
    tanuki_estimate: (a) => [{ type: "text", text: jstring(toolEstimate(a), true) }],
    tanuki_distill: toolDistill,
    tanuki_compress: toolCompress,
    tanuki_stats: () => [{ type: "text", text: jstring(pxStats(), true) }],
    tanuki_stash: toolStash,
    tanuki_fetch: toolFetch,
    tanuki_verify: toolVerify,
  };
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.brief,
    inputSchema: zodShape(z, t.params),
    handler: async (args: Record<string, unknown>) => {
      try {
        return { content: run[t.name](args) };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `tanuki-context error: ${e instanceof Error ? e.message : String(e)}` },
          ],
          isError: true,
        };
      }
    },
  }));
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
