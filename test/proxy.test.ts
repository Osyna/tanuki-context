// Implicit mode: proves the middlebox images oversized blocks IN PLACE and
// nothing else — system prompt/tools untouched, latest message untouched,
// cache_control untouched — and that the wire behaves (transform applied
// upstream-bound, response passthrough, count_tokens ignored).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PROXY_DEFAULTS, attributeBreak, newSession, startProxy, transformRequestBody, type ProxyCfg } from "../src/proxy.ts";

const CFG: ProxyCfg = { ...PROXY_DEFAULTS, port: 0, upstream: "http://127.0.0.1:1" };

const BIG = Array.from(
  { length: 300 },
  (_, i) =>
    `2026-07-26T02:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 5} copied /srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet ok`,
).join("\n");
const SMALL = "just a short note";

interface Block {
  type: string;
  text?: string;
  source?: { media_type: string; data: string };
  content?: unknown;
  cache_control?: unknown;
}

const msg = (role: string, content: unknown): { role: string; content: unknown } => ({ role, content });
const parse = (r: { body: string } | null): { system?: unknown; messages: { role: string; content: Block[] | string }[] } =>
  JSON.parse(r!.body);

describe("transform rules", () => {
  test("oversized user text block becomes marker + PNG pages, in place", () => {
    const body = JSON.stringify({
      system: "SYSTEM PROMPT",
      messages: [
        msg("user", [{ type: "text", text: "before" }, { type: "text", text: BIG }, { type: "text", text: "after" }]),
        msg("assistant", "ok"),
        msg("user", "latest question"),
      ],
    });
    const r = transformRequestBody(body, CFG);
    expect(r).not.toBeNull();
    const out = parse(r);

    expect(out.system).toBe("SYSTEM PROMPT"); // rule 1
    const c = out.messages[0].content as Block[];
    expect(c[0].text).toBe("before"); // position preserved
    expect(c[1].type).toBe("text");
    expect(c[1].text).toStartWith("[tanuki-context:"); // overt marker
    const imgs = c.filter((b) => b.type === "image");
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].source?.media_type).toBe("image/png");
    const png = Buffer.from(imgs[0].source!.data, "base64");
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(c[c.length - 1].text).toBe("after"); // trailing block still there

    expect(out.messages[1].content).toBe("ok"); // assistant untouched
    expect(out.messages[2].content).toBe("latest question"); // rule 3
    expect(r!.savedTokens).toBeGreaterThan(300);
  });

  test("latest message is never imaged even when oversized", () => {
    const body = JSON.stringify({ messages: [msg("user", BIG)] });
    expect(transformRequestBody(body, CFG)!.changed).toBe(false);
  });

  test("cache_control blocks pass through untouched", () => {
    const body = JSON.stringify({
      messages: [
        msg("user", [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }]),
        msg("user", "latest"),
      ],
    });
    expect(transformRequestBody(body, CFG)!.changed).toBe(false); // rule 4
  });

  test("small blocks and non-message bodies pass through", () => {
    expect(transformRequestBody(JSON.stringify({ messages: [msg("user", SMALL), msg("user", "x")] }), CFG)!.changed).toBe(false);
    expect(transformRequestBody(JSON.stringify({ model: "m" }), CFG)).toBeNull();
    expect(transformRequestBody("not json", CFG)).toBeNull();
  });

  test("tool_result text content is imaged inside the block", () => {
    const body = JSON.stringify({
      messages: [
        msg("user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: BIG }] }]),
        msg("user", "latest"),
      ],
    });
    const r = transformRequestBody(body, CFG);
    expect(r).not.toBeNull();
    const c = parse(r).messages[0].content as Block[];
    expect(c[0].type).toBe("tool_result");
    const inner = c[0].content as Block[];
    expect(inner[0].text).toStartWith("[tanuki-context:");
    expect(inner.some((b) => b.type === "image")).toBe(true);
  });

  test("string user content converts to marker + pages array", () => {
    const body = JSON.stringify({ messages: [msg("user", BIG), msg("user", "latest")] });
    const r = transformRequestBody(body, CFG);
    expect(r).not.toBeNull();
    const c = parse(r).messages[0].content as Block[];
    expect(Array.isArray(c)).toBe(true);
    expect(c[0].text).toStartWith("[tanuki-context:");
  });

  test("byte-identical repeat of an imaged block becomes a pointer, no images", () => {
    const body = JSON.stringify({ messages: [msg("user", BIG), msg("user", BIG), msg("user", "latest")] });
    const r = transformRequestBody(body, CFG);
    expect(r).not.toBeNull();
    const m = parse(r).messages;
    const first = m[0].content as Block[];
    const second = m[1].content as Block[];
    const firstImages = first.filter((b) => b.type === "image").length;
    expect(firstImages).toBeGreaterThan(0);
    expect(second.length).toBe(1);
    expect(second[0].type).toBe("text");
    expect(second[0].text).toContain("byte-identical to a block imaged above");
    expect(r!.imagedBlocks).toBe(2);
    expect(r!.imageCount).toBe(firstImages); // the repeat added zero images
    expect(r!.savedTokens).toBeGreaterThan(Math.round(BIG.length / 4)); // repeat saved ~its whole text cost
  });

  test("a one-byte difference is not a duplicate", () => {
    const body = JSON.stringify({ messages: [msg("user", BIG), msg("user", `${BIG}!`), msg("user", "latest")] });
    const r = transformRequestBody(body, CFG);
    expect(r).not.toBeNull();
    const m = parse(r).messages;
    expect((m[0].content as Block[]).some((b) => b.type === "image")).toBe(true);
    expect((m[1].content as Block[]).some((b) => b.type === "image")).toBe(true);
  });
});

describe("wire behaviour", () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let lastUpstreamBody = "";
  let lastUpstreamUrl = "";

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
        lastUpstreamUrl = req.url ?? "";
        res.writeHead(200, { "content-type": "application/json", "x-upstream": "mock" });
        res.end(JSON.stringify({ id: "msg_1", usage: { input_tokens: 111, cache_read_input_tokens: 22, cache_creation_input_tokens: 3 } }));
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    upstreamPort = (upstream.address() as AddressInfo).port;

    process.env.TANUKI_EVENTS = `/tmp/tanuki-proxy-test-${process.pid}.jsonl`;
    proxy = startProxy({ ...CFG, port: 0, upstream: `http://127.0.0.1:${upstreamPort}` });
    await new Promise<void>((ok) => proxy.on("listening", ok));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy.close();
    upstream.close();
  });

  test("messages request is transformed upstream-bound, response passes through", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test" },
      body: JSON.stringify({ model: "m", messages: [msg("user", BIG), msg("user", "latest")] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("mock");
    const reply = await res.json();
    expect(reply.id).toBe("msg_1"); // byte passthrough of the mock reply

    const fwd = JSON.parse(lastUpstreamBody);
    const c = fwd.messages[0].content;
    expect(c[0].text).toStartWith("[tanuki-context:");
    expect(c.some((b: Block) => b.type === "image")).toBe(true);
    expect(fwd.messages[1].content).toBe("latest");

    // savings row landed in the events log with the scraped usage
    const rows = (await Bun.file(process.env.TANUKI_EVENTS!).text()).trim().split("\n");
    const last = JSON.parse(rows[rows.length - 1]);
    expect(last.tool).toBe("proxy");
    expect(last.compressed).toBe(true);
    expect(last.input_tokens).toBe(111);
    expect(last.cache_read_tokens).toBe(22);
    expect(last.baseline_tokens).toBeGreaterThan(136); // actual + saved estimate
  });

  test("count_tokens passes through untransformed", async () => {
    const body = JSON.stringify({ model: "m", messages: [msg("user", BIG), msg("user", "x")] });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(lastUpstreamUrl).toBe("/v1/messages/count_tokens");
    expect(lastUpstreamBody).toBe(body); // byte-identical
  });

  test("unrelated routes pass through byte-identical", async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { method: "GET" });
    expect(lastUpstreamUrl).toBe("/v1/models");
  });
});

// ------------------------------------------------ cache-aware savings ledger
// The rakuen critique, answered in numbers: the optimistic counterfactual
// stays (comparable to every other tool), and a second figure prices replays
// at the cache-read rate and charges the first text->pages flip the
// cache-write premium. Bytes on the wire NEVER depend on the session.
describe("cache-aware ledger", () => {
  const body = JSON.stringify({
    model: "claude-opus-4",
    messages: [msg("user", BIG), msg("user", "latest")],
  });

  test("no cache traffic seen: both figures agree", () => {
    const s = newSession();
    const r = transformRequestBody(body, CFG, s);
    expect(r).not.toBeNull();
    expect(r?.savedTokensCacheAware).toBe(r?.savedTokens);
    expect(s.seenBlocks.size).toBe(1);
  });

  test("first flip of a cached block is charged, replays are discounted", () => {
    const s = newSession();
    s.cachingSeen = true;
    const first = transformRequestBody(body, CFG, s);
    // avoided a 0.1x cache read, paid a 1.25x cache write: net negative
    expect(first!.savedTokensCacheAware).toBeLessThan(0);
    const replay = transformRequestBody(body, CFG, s);
    // both sides ride cache reads now: small positive, ~saved x 0.1
    expect(replay!.savedTokensCacheAware).toBeGreaterThan(0);
    expect(replay!.savedTokensCacheAware).toBeLessThan(replay!.savedTokens);
  });

  test("session never changes the emitted bytes", () => {
    // The guard on a plausible-looking optimisation that is really a
    // pessimisation: swapping a block seen in an EARLIER request for a short
    // pointer changes the prefix and invalidates the cache entry the
    // cache_control breakpoint exists to keep stable. So EVERY sequential call
    // of a warm session must emit the same bytes as a session-less call, not
    // just the first.
    const cold = transformRequestBody(body, CFG);
    const s = newSession();
    s.cachingSeen = true;
    const first = transformRequestBody(body, CFG, s);
    const second = transformRequestBody(body, CFG, s);
    const third = transformRequestBody(body, CFG, s);
    expect(first!.body).toBe(cold!.body);
    expect(second!.body).toBe(cold!.body);
    expect(third!.body).toBe(cold!.body);
    // and the session really was warm, so the equalities above are not passing
    // on a session that never recorded anything: the block is remembered and
    // the ledger moved from first-flip pricing to replay pricing.
    expect(s.seenBlocks.size).toBe(1);
    expect(second!.savedTokensCacheAware).not.toBe(first!.savedTokensCacheAware);
  });
});
// The proxy has always PRICED caching but never CREATED it. Imaged pages are
// the ideal cache payload: byte-stable and re-sent every turn. Measured at
// Sonnet rates on a 7530-token page set: 2.1x cheaper over 3 turns, 4.7x
// over 10.
describe("cache breakpoint on the imaged prefix", () => {
  const bodyWith = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      messages: [msg("user", [{ type: "text", text: BIG }, { type: "text", text: "tail" }]), msg("user", "latest")],
      ...extra,
    });

  test("marks the last block of the last imaged message", () => {
    const r = transformRequestBody(bodyWith({}), CFG);
    expect(r!.cached).toBe(true);
    const c = parse(r).messages[0].content as Block[];
    // breakpoint sits at the END of the imaged message, so the whole prefix
    // (system, tools, pages) is covered by one boundary
    expect(c.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(c.filter((b) => b.cache_control !== undefined).length).toBe(1);
    // and the volatile trailing message is NOT part of the cached prefix
    expect(parse(r).messages[1].content).toBe("latest");
  });

  test("never exceeds Anthropic's 4-breakpoint ceiling", () => {
    // client already spent all four; a fifth is a 400, so we must decline
    const four = [0, 1, 2, 3].map(() => ({ type: "text", text: "x", cache_control: { type: "ephemeral" } }));
    const r = transformRequestBody(bodyWith({ system: four }), CFG);
    expect(r).not.toBeNull(); // still images - only the breakpoint is skipped
    expect(r!.cached).toBe(false);
    const c = parse(r).messages[0].content as Block[];
    expect(c.some((b) => b.cache_control !== undefined)).toBe(false);
  });

  test("opt-out leaves the body free of breakpoints", () => {
    const r = transformRequestBody(bodyWith({}), { ...CFG, cache: false });
    expect(r!.cached).toBe(false);
    const c = parse(r).messages[0].content as Block[];
    expect(c.some((b) => b.cache_control !== undefined)).toBe(false);
  });
});

// ------------------------------------------------ F4 diagnostics

describe("attributeBreak classifier", () => {
  test("pure append returns null (cache intact)", () => {
    const prev = ["a", "b", "c"];
    const cur = ["a", "b", "c", "d", "e"];
    expect(attributeBreak(prev, cur)).toBeNull();
  });

  test("pure append non-vacuity: naive first-divergence would fail", () => {
    // Guard: a naive "first difference" check would wrongly classify pure append
    const prev = ["a", "b"];
    const cur = ["a", "b", "c"];
    const result = attributeBreak(prev, cur);
    // Pure append MUST be null, not { index: 2, kind: <anything> }
    expect(result).toBeNull();
    // The naive approach would set index=2 (first index where lengths differ)
    // and try to classify, failing the prefix-check contract.
  });
  test("identical lists are not a break", () => {
    // Regression for the `>=` in the prefix short-circuit: identical lists
    // used to fall through both prefix checks and come back as a bogus
    // "modified" at index len (the Rust engine panicked on the same case).
    const a = ["aaa", "bbb", "ccc"];
    expect(attributeBreak(a, [...a])).toBeNull();
  });


  test("modified: neither block found in opposite tail", () => {
    const prev = ["a", "b", "OLD"];
    const cur = ["a", "b", "NEW"];
    expect(attributeBreak(prev, cur)).toEqual({ index: 2, kind: "modified" });
  });

  test("added: current block appears later in previous", () => {
    const prev = ["a", "c", "d"];
    const cur = ["a", "b", "c", "d"];
    expect(attributeBreak(prev, cur)).toEqual({ index: 1, kind: "added" });
  });

  test("evicted: previous block appears later in current", () => {
    const prev = ["a", "b", "c", "d"];
    const cur = ["a", "c", "d"];
    expect(attributeBreak(prev, cur)).toEqual({ index: 1, kind: "evicted" });
  });

  test("evicted: current is proper prefix of previous", () => {
    const prev = ["a", "b", "c", "d"];
    const cur = ["a", "b"];
    expect(attributeBreak(prev, cur)).toEqual({ index: 2, kind: "evicted" });
  });

  test("reordered: both blocks found in opposite tails", () => {
    const prev = ["a", "b", "c"];
    const cur = ["a", "c", "b"];
    expect(attributeBreak(prev, cur)).toEqual({ index: 1, kind: "reordered" });
  });
});

describe("F4 proxy diagnostics", () => {
  test("block hashes computed correctly", () => {
    const body = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      ],
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(2);
    // Hashes should be 12-char hex strings
    expect(result!.blocks[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(result!.blocks[1]).toMatch(/^[0-9a-f]{12}$/);
  });

  test("cacheBreak detected on modified block", () => {
    const session = newSession();
    const body1 = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "original message" }],
    };
    transformRequestBody(JSON.stringify(body1), CFG, session);
    
    const body2 = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "modified message" }],
    };
    const result = transformRequestBody(JSON.stringify(body2), CFG, session);
    expect(result).not.toBeNull();
    expect(result!.cacheBreak).not.toBeNull();
    expect(result!.cacheBreak!.kind).toBe("modified");
    expect(result!.cacheBreak!.index).toBe(0);
    expect(result!.cacheBreak!.rebilled).toBeGreaterThan(0);
  });

  test("cacheBreak null on pure append", () => {
    const session = newSession();
    const body1 = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "first" }],
    };
    transformRequestBody(JSON.stringify(body1), CFG, session);
    
    const body2 = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "response" },
      ],
    };
    const result = transformRequestBody(JSON.stringify(body2), CFG, session);
    expect(result).not.toBeNull();
    expect(result!.cacheBreak).toBeNull();
  });

  test("cacheBreak evicted kind", () => {
    const session = newSession();
    const body1 = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "user", content: "c" },
      ],
    };
    transformRequestBody(JSON.stringify(body1), CFG, session);
    
    const body2 = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "c" },
      ],
    };
    const result = transformRequestBody(JSON.stringify(body2), CFG, session);
    expect(result).not.toBeNull();
    expect(result!.cacheBreak).not.toBeNull();
    expect(result!.cacheBreak!.kind).toBe("evicted");
  });

  test("toolTax only when tools advertised AND tool_use exists", () => {
    // No tools advertised -> no toolTax
    const body1 = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    };
    let result = transformRequestBody(JSON.stringify(body1), CFG);
    expect(result).not.toBeNull();
    expect(result!.toolTax).toBeNull();
    
    // Tools advertised but no tool_use -> no toolTax
    const body2 = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { name: "search", input_schema: { type: "object" } },
        { name: "calculate", input_schema: { type: "object" } },
      ],
    };
    result = transformRequestBody(JSON.stringify(body2), CFG);
    expect(result).not.toBeNull();
    expect(result!.toolTax).toBeNull();
    
    // Tools advertised AND tool_use exists -> toolTax computed
    const body3 = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "1", name: "search", input: {} }],
        },
      ],
      tools: [
        { name: "search", description: "search the web", input_schema: { type: "object" } },
        { name: "calculate", description: "calculate math", input_schema: { type: "object" } },
        { name: "unused", description: "never called", input_schema: { type: "object" } },
      ],
    };
    result = transformRequestBody(JSON.stringify(body3), CFG);
    expect(result).not.toBeNull();
    expect(result!.toolTax).not.toBeNull();
    expect(result!.toolTax!.unused).toContain("calculate");
    expect(result!.toolTax!.unused).toContain("unused");
    expect(result!.toolTax!.unused).not.toContain("search");
    expect(result!.toolTax!.tokens).toBeGreaterThan(0);
  });

  test("toolTax first 8 unused tools", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      name: `tool${i}`,
      input_schema: { type: "object" },
    }));
    const body = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "1", name: "tool0", input: {} }],
        },
      ],
      tools,
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.toolTax).not.toBeNull();
    expect(result!.toolTax!.unused.length).toBe(8); // capped at 8
  });

  test("volatileSystem detects UUID", () => {
    const body = {
      model: "claude-sonnet-4",
      system: "Request ID: a1b2c3d4-e5f6-4789-abcd-ef0123456789",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.volatileSystem).toBe(true);
  });

  test("volatileSystem detects timestamp", () => {
    const body = {
      model: "claude-sonnet-4",
      system: "Current time: 2026-07-31T12:34:56Z",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.volatileSystem).toBe(true);
  });

  test("volatileSystem detects JWT", () => {
    const body = {
      model: "claude-sonnet-4",
      system: [
        {
          type: "text",
          text: "Auth token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.volatileSystem).toBe(true);
  });

  test("volatileSystem false on normal system prompt", () => {
    const body = {
      model: "claude-sonnet-4",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = transformRequestBody(JSON.stringify(body), CFG);
    expect(result).not.toBeNull();
    expect(result!.volatileSystem).toBe(false);
  });
});
