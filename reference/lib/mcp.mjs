// One MCP client for every harness. parity-ts.mjs had the only real
// implementation; proxy-parity.mjs, the estimator equality check and several
// throwaway probes each re-derived the same handshake, which is how two of them
// ended up comparing nothing at all and reporting a pass.
//
// The handshake is the part worth centralising: `initialize` then the
// `notifications/initialized` notification, then calls. Forget the
// notification and a server may answer anyway, so the mistake is silent.

import { spawn } from "node:child_process";

const HANDSHAKE = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

/**
 * Drive one stdio MCP server to completion and return every parsed reply.
 * `requests` are sent after the handshake; ids below 10 are reserved for it.
 */
export function mcpSession(cmd, args, requests, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () =>
      resolve(
        out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      ),
    );
    p.stdin.write([...HANDSHAKE, ...requests].map((l) => JSON.stringify(l)).join("\n") + "\n");
    p.stdin.end();
  });
}

/**
 * Call several tools in one session. `calls` is `[{ name, arguments }]`;
 * returns one entry per call, in order, with the content blocks already split.
 *
 * Returning `blocks`, `text` AND `images` separately is deliberate: a caller
 * that greps a whole JSON dump for a substring cannot tell whether a value
 * arrived as readable text or as pixels, and that distinction is the entire
 * point of most measurements here.
 */
export async function callTools(cmd, args, calls, opts = {}) {
  const requests = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: 100 + i,
    method: "tools/call",
    params: { name: c.name, arguments: c.arguments ?? {} },
  }));
  const msgs = await mcpSession(cmd, args, requests, opts);
  return calls.map((c, i) => {
    const m = msgs.find((x) => x.id === 100 + i);
    const blocks = m?.result?.content ?? [];
    return {
      name: c.name,
      error: m?.error ?? (m?.result === undefined ? { message: "no reply" } : null),
      blocks,
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      images: blocks.filter((b) => b.type === "image").map((b) => b.data),
      /** parsed first text block, for tools that return a JSON document */
      json: (() => {
        const t = blocks.find((b) => b.type === "text")?.text;
        if (t === undefined) return null;
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      })(),
    };
  });
}

/** Convenience for the common single-call case. */
export async function callTool(cmd, args, name, argsObj, opts = {}) {
  return (await callTools(cmd, args, [{ name, arguments: argsObj }], opts))[0];
}
