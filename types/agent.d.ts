// Hand-maintained types for the `tanuki-context/agent` subpath (the built
// dist/agent.js is a minified bundle; keep this in sync with src/agent.ts).

export declare const TANUKI_TOOL_NAMES: readonly [
  "tanuki_render",
  "tanuki_estimate",
  "tanuki_distill",
  "tanuki_compress",
  "tanuki_stats",
];

/** Canned agent guidance: estimate first, render on a winning verdict,
 *  distill logs, and the page decode grammar. */
export declare const TANUKI_INSTRUCTIONS: string;

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** External stdio MCP server config for `options.mcpServers`. */
export declare function tanukiMcpServer(): StdioServerConfig;

/** `mcp__<key>__<tool>` names for `options.allowedTools`. */
export declare function tanukiAllowedTools(key?: string): string[];

export interface TanukiOptions {
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  [k: string]: unknown;
}

/** Merge tanuki (server + allowed tools) into an Agent SDK options object. */
export declare function withTanuki<T extends TanukiOptions>(
  options?: T,
  opts?: { key?: string; server?: unknown },
): T & TanukiOptions;

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

/** The five tools as SDK tool specs (schema factory + handlers). */
export declare function tanukiSdkToolSpecs(z: ZodNamespace): SdkToolSpec[];

/** In-process MCP server (no subprocess; shareable across a team of agents).
 *  Requires @anthropic-ai/claude-agent-sdk and zod in the host project.
 *  Returned value goes straight into `options.mcpServers`. */
export declare function tanukiSdkServer(): Promise<unknown>;
