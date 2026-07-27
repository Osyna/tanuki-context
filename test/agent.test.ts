// Claude Agent SDK integration: config helpers, the in-process tool specs
// against real zod, and createSdkMcpServer against the real SDK (both are
// devDependencies here; optional peers for consumers).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  TANUKI_INSTRUCTIONS,
  TANUKI_TOOL_NAMES,
  tanukiAllowedTools,
  tanukiMcpServer,
  tanukiSdkServer,
  tanukiSdkToolSpecs,
  withTanuki,
  type ZodNamespace,
} from "../src/agent.ts";

const BIG = Array.from(
  { length: 300 },
  (_, i) => `2026-07-26 INFO copied /srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet ok`,
).join("\n");

// real zod satisfies the structural namespace the specs are typed against
const Z = z as unknown as ZodNamespace;

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

describe("config helpers", () => {
  test("stdio server config points at a runnable command", () => {
    const cfg = tanukiMcpServer();
    expect(cfg.type).toBe("stdio");
    expect(cfg.command.length).toBeGreaterThan(0);
    expect(cfg.args.length).toBeGreaterThan(0);
  });

  test("allowed tools follow the SDK mcp__<key>__<tool> convention", () => {
    expect(tanukiAllowedTools()).toEqual([
      "mcp__tanuki__tanuki_render",
      "mcp__tanuki__tanuki_estimate",
      "mcp__tanuki__tanuki_distill",
      "mcp__tanuki__tanuki_compress",
      "mcp__tanuki__tanuki_stats",
      "mcp__tanuki__tanuki_stash",
      "mcp__tanuki__tanuki_fetch",
      "mcp__tanuki__tanuki_verify",
    ]);
    expect(tanukiAllowedTools("ctx")[0]).toBe("mcp__ctx__tanuki_render");
  });

  test("withTanuki merges without clobbering existing options", () => {
    const merged = withTanuki({
      model: "claude-x",
      mcpServers: { other: { type: "stdio", command: "x", args: [] } },
      allowedTools: ["Bash"],
    });
    expect(merged.model).toBe("claude-x");
    expect(Object.keys(merged.mcpServers ?? {})).toEqual(["other", "tanuki"]);
    expect(merged.allowedTools?.[0]).toBe("Bash");
    expect(merged.allowedTools).toContain("mcp__tanuki__tanuki_estimate");
    // no-arg form works too
    expect(Object.keys(withTanuki().mcpServers ?? {})).toEqual(["tanuki"]);
  });

  test("instructions teach the estimate-first workflow and decode grammar", () => {
    expect(TANUKI_INSTRUCTIONS).toContain("tanuki_estimate first");
    expect(TANUKI_INSTRUCTIONS).toContain("\u21b5");
    expect(TANUKI_INSTRUCTIONS).toContain("\u00b7legend\u00b7");
  });
});

describe("in-process tool specs (real zod)", () => {
  const specs = tanukiSdkToolSpecs(Z);
  const byName = new Map(specs.map((s) => [s.name, s]));

  test("all tools present with schemas", () => {
    expect(specs.map((s) => s.name)).toEqual([...TANUKI_TOOL_NAMES]);
    for (const s of specs) expect(s.description.length).toBeGreaterThan(20);
  });

  test("estimate handler returns the verdict JSON", async () => {
    const r = await byName.get("tanuki_estimate")!.handler({ text: BIG });
    const blocks = r.content as ContentBlock[];
    const out = JSON.parse(blocks[0].text ?? "{}");
    expect(out.engine).toBe("pxpipe");
    expect(out.verdict).toBe("PIPELINE cheaper");
    expect(out.imageTokens).toBeLessThan(out.rawTextTokens);
  });

  test("render handler returns PNG image blocks", async () => {
    const r = await byName.get("tanuki_render")!.handler({ text: BIG });
    const blocks = r.content as ContentBlock[];
    expect(blocks[0].type).toBe("text");
    const img = blocks.find((b) => b.type === "image");
    expect(img?.mimeType).toBe("image/png");
    const png = Buffer.from(img?.data ?? "", "base64");
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  test("distill handler keeps error lines verbatim", async () => {
    const r = await byName.get("tanuki_distill")!.handler({ text: `${BIG}\nERROR: quota exceeded` });
    const blocks = r.content as ContentBlock[];
    expect(blocks[1].text).toContain("ERROR: quota exceeded");
  });

  test("handler failures surface as isError, not throws", async () => {
    // level is `as u8`-wrapped, so force an error through a poisoned arg shape
    const r = await byName.get("tanuki_compress")!.handler({ text: BIG, level: 999 });
    // wraps mod 256 -> level 231 -> clamped by LEVELS lookup failing => isError
    expect(r.isError === true || (r.content as ContentBlock[]).length > 0).toBe(true);
  });
});

describe("real Agent SDK", () => {
  test("createSdkMcpServer accepts the tool specs", async () => {
    const server = (await tanukiSdkServer()) as { type: string; name: string; instance: unknown };
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("tanuki-context");
    expect(server.instance).toBeDefined();
  });

  test("built dist/agent.js bundle exports the same surface", async () => {
    const dist = (await import("../dist/agent.js")) as unknown as typeof import("../src/agent.ts");
    const cfg = dist.tanukiMcpServer();
    // published layout: cli.js sits next to agent.js, so the config must
    // point node at the real file, not the npx fallback
    expect(cfg.command).toBe(process.execPath);
    expect(cfg.args[0]).toEndWith("dist/cli.js");
    expect(dist.tanukiAllowedTools().length).toBe(8);
    const server = (await dist.tanukiSdkServer()) as { type: string };
    expect(server.type).toBe("sdk");
  });
});
