//! Pi (pi-mono / oh-my-pi lineage) extension: registers the tanuki tools.
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
//!
//! It is also an I/O router (context-mode's shape, tanuki's `run` rules): a
//! `bash` result over RUN_INLINE_MAX chars from a build/test/install tool is
//! crushed + distilled in place and the text omp handed over stashed,
//! fetchable with `tanuki_fetch`. That path runs in-process (no server child);
//! the stash format is shared by both engines. `TANUKI_ROUTE=off` turns it off.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { RUN_INLINE_MAX, routeOutput } from "./crush.ts";
import { charCount } from "./serde.ts";
import { TOOLS, type Knob } from "./tools.ts";

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

/// Commands whose big output is build/test/install noise. Distill is lossy, so
/// anything else (cat, sed, git diff, jq, curl, rg, a pipeline) is content the
/// model may edit from and passes through untouched.
const ROUTED = new Set(["cargo", "npm", "pnpm", "yarn", "bun", "pytest", "py.test", "go", "tsc", "eslint", "make", "gradle", "gradlew", "mvn", "pip", "uv", "docker", "jest", "vitest"]);

/// The argv the `run` rules key on, or null when the line is not routed. A
/// shell line rarely is one command: `cd x && cargo test` routes on its last
/// `&&`/`;` step with `VAR=v` prefixes dropped; a pipeline's output is its last
/// stage's, so it is never routed.
function argvOf(command: string): string[] | null {
  const step = command.split(/&&|;|\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
  if (step.includes("|")) return null;
  const argv = step.split(/\s+/).filter((w) => w !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return ROUTED.has(argv[0]?.split("/").pop() ?? "") ? argv : null;
}

interface ToolResultEvent {
  toolName: string;
  input?: { command?: unknown };
  content?: McpContent[];
  details?: { exitCode?: number; meta?: { truncation?: { artifactId?: string } } };
  isError?: boolean;
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

/// typebox projection of the registry knobs (pi's parameter schema).
function tbShape(params: Knob[]): TSchema {
  const shape: Record<string, TSchema> = {};
  for (const p of params) {
    const opts: Record<string, unknown> = {};
    if (p.hint !== undefined) opts.description = p.hint;
    let t: TSchema;
    if (p.type === "boolean") {
      t = Type.Boolean(opts);
    } else if (p.type === "integer") {
      if (p.min !== undefined) opts.minimum = p.min;
      if (p.max !== undefined) opts.maximum = p.max;
      t = Type.Integer(opts);
    } else {
      if (p.values !== undefined) opts.enum = p.values;
      t = Type.String(opts);
    }
    shape[p.key] = p.required === true ? t : Type.Optional(t);
  }
  return Type.Object(shape);
}

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

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (event.toolName !== "bash" || process.env.TANUKI_ROUTE === "off") return;
    const argv = argvOf(String(event.input?.command ?? ""));
    const blocks = event.content ?? [];
    if (argv === null || blocks.length === 0 || blocks.some((b) => b.type !== "text")) return;
    const text = blocks.map((b) => b.text ?? "").join("\n");
    if (charCount(text) <= RUN_INLINE_MAX) return;
    const code = event.details?.exitCode ?? (event.isError ? 1 : 0);
    let out = routeOutput(argv, text, code, null, (id) => `stashed: tanuki_fetch {"id":"${id}","query":"<regex>"} or {"id":"${id}","lines":"a-b"}`);
    // omp truncates before this hook, so the stash holds its view, not every line.
    const artifact = event.details?.meta?.truncation?.artifactId;
    if (artifact !== undefined) out += `\ncomplete output: artifact://${artifact}`;
    if (charCount(out) >= charCount(text)) return;
    return { content: [{ type: "text" as const, text: out }] };
  });

  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.snippet,
      parameters: tbShape(t.params),
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
