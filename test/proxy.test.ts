// Implicit mode: proves the middlebox images oversized blocks IN PLACE and
// nothing else — system prompt/tools untouched, latest message untouched,
// cache_control untouched — and that the wire behaves (transform applied
// upstream-bound, response passthrough, count_tokens ignored).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
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

// Rule 7: a pretty-printed JSON tool result is minified, lossless, in every
// message - including the latest and one holding the client's breakpoint -
// because the same bytes from its first request on are what keeps the cache.
describe("lossless JSON tool results (rule 7)", () => {
  const DOC = { items: Array.from({ length: 20 }, (_, i) => ({ name: `row ${i}`, note: "keep  these\tspaces", n: "N" })) };
  const big = (s: string) => s.replaceAll('"N"', "12345678901234567890"); // past 2^53: a re-print would round it
  const PRETTY = big(JSON.stringify(DOC, null, 2));
  const toolResult = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "tool_result", tool_use_id: "t1", content, ...extra });

  test("minified in the latest message, strings and big numbers byte-exact", () => {
    const body = JSON.stringify({ messages: [msg("user", [toolResult(PRETTY, { cache_control: { type: "ephemeral" } })])] });
    const r = transformRequestBody(body, CFG)!;
    expect(r.changed).toBe(true);
    expect(r.minifiedBlocks).toBe(1);
    expect(r.imagedBlocks).toBe(0);
    const got = (parse(r).messages[0].content as Block[])[0];
    expect(got.cache_control).toEqual({ type: "ephemeral" }); // the client's breakpoint stays where it was
    expect(got.content).toBe(big(JSON.stringify(DOC)));
    expect(got.content as string).toContain('"keep  these\\tspaces"');
    expect(got.content as string).toContain("12345678901234567890");
    expect(r.savedTokens).toBeGreaterThan(0);
  });

  test("idempotent: the next request carries the same bytes, so the cache holds", () => {
    // the client knows nothing of the proxy: it re-sends the pretty original every turn
    const turn1 = { messages: [msg("user", [toolResult([{ type: "text", text: PRETTY }])])] };
    const first = transformRequestBody(JSON.stringify(turn1), CFG)!;
    const turn2 = { messages: [...turn1.messages, msg("assistant", "ok"), msg("user", "next question")] };
    const again = transformRequestBody(JSON.stringify(turn2), CFG)!;
    expect(again.minifiedBlocks).toBe(1);
    expect(parse(again).messages[0]).toEqual(parse(first).messages[0]);
    // and minifying an already-minified block is a no-op
    const settled = transformRequestBody(first.body, CFG)!;
    expect(settled.changed).toBe(false);
  });

  test("a number past 2^53 is rewritten around, never re-printed", () => {
    // JSON.parse would round the tool_use input to 12345678901234567000; splicing
    // never re-prints it, so the body is rewritten and the id survives verbatim
    const raw = `{"messages":[{"role":"user","content":${JSON.stringify(BIG)}},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"get","input":{"id":12345678901234567890}}]},{"role":"user","content":[${JSON.stringify(toolResult(PRETTY))}]}]}`;
    const r = transformRequestBody(raw, CFG)!;
    expect(r.changed && r.minifiedBlocks === 1 && r.imagedBlocks === 1).toBe(true);
    expect(r.body).toContain('"input":{"id":12345678901234567890}}]}');
  });

  test("not JSON, not a tool result, or too small: untouched", () => {
    for (const content of [`${PRETTY}\nprose after`, "[not json", JSON.stringify({ a: 1 }, null, 2)]) {
      expect(transformRequestBody(JSON.stringify({ messages: [msg("user", [toolResult(content)])] }), CFG)!.changed).toBe(false);
    }
    expect(transformRequestBody(JSON.stringify({ messages: [msg("user", PRETTY)] }), CFG)!.minifiedBlocks).toBe(0);
  });

  test("TANUKI_MINIFY=off forwards the pretty result byte-for-byte", () => {
    const body = JSON.stringify({ messages: [msg("user", [toolResult(PRETTY)])] });
    process.env.TANUKI_MINIFY = "off";
    try {
      const r = transformRequestBody(body, CFG)!;
      expect(r.changed).toBe(false);
      expect(r.body).toBe(body);
    } finally {
      delete process.env.TANUKI_MINIFY;
    }
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

// ------------------------------------------------ T1a byte-exact splicing
// The rewritten request is the client's own bytes with only the changed spans
// substituted: key order, spacing, escapes and number spellings elsewhere stay.
describe("byte splicing (T1a)", () => {
  const OPEN =
    '{"stream" : true,\n "max_tokens":1e2, "temperature": 1.0, "system" :[{"text":"caf\\u00e9 \\/ sys","type":"text"}],\n' +
    ' "tools":[{"name":"t","input_schema":{"z":12345678901234567890,"a":1.50}}],\n "messages" : [\n  ';
  const MID =
    ',\n  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"get","input":{"id":12345678901234567890,"f":1.50,"e":1e2}}]},\n  ';
  const LAST = '{"content":"latest","role":"user"}\n ]\n}';
  const M0 = `{"role":"user", "content":${JSON.stringify(BIG)}}`;

  test("the untouched prefix and suffix of an imaged request are byte-identical", () => {
    const raw = OPEN + M0 + MID + LAST;
    const r = transformRequestBody(raw, CFG)!;
    expect(r.changed && r.imagedBlocks === 1).toBe(true);
    expect(r.body.startsWith(`${OPEN}{"role":"user", "content":[`)).toBe(true);
    expect(r.body.endsWith(`}${MID}${LAST}`)).toBe(true);
    // 1e2, 1.0, 1.50, \u00e9 and the 20-digit ints all survived as spelled
    for (const lit of ["1e2", "1.0", "1.50", "caf\\u00e9 \\/ sys", "12345678901234567890"]) expect(r.body).toContain(lit);
    const c = (JSON.parse(r.body).messages[0].content as Block[]);
    expect(c[0].text).toStartWith("[tanuki-context:");
    expect(c.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("a minified tool_result replaces exactly its string literal", () => {
    const DOC = { items: Array.from({ length: 20 }, (_, i) => ({ name: `row ${i}`, n: "N" })) };
    const pretty = JSON.stringify(DOC, null, 2).replaceAll('"N"', "12345678901234567890");
    const min = JSON.stringify(DOC).replaceAll('"N"', "12345678901234567890");
    const tr = `{"content" : ${JSON.stringify(pretty)} ,"type": "tool_result","tool_use_id" :"t1"}`;
    const raw = `${OPEN}{"role":"user","content":[ ${tr} ]}${MID}${LAST}`;
    const r = transformRequestBody(raw, CFG)!;
    expect(r.minifiedBlocks).toBe(1);
    expect(r.body).toBe(raw.replace(JSON.stringify(pretty), JSON.stringify(min)));
  });

  test("the client's own tail block gains the breakpoint as one more member", () => {
    const raw = `{"messages":[{"role":"user","content":[ {"type":"text","text":${JSON.stringify(BIG)}} , {"type":"text","text":"tail" } ]},{"role":"user","content":"latest"}]}`;
    const r = transformRequestBody(raw, CFG)!;
    expect(r.cached).toBe(true);
    expect(r.body).toContain(', {"type":"text","text":"tail","cache_control":{"type":"ephemeral"} } ]}');
    expect(r.body.endsWith(',{"role":"user","content":"latest"}]}')).toBe(true);
  });

  test("duplicate keys, escaped keys and odd whitespace do not desynchronise the spans", () => {
    const tr = `{"type":"tool_result","tool_use_id":"t1","con\\u0074ent":"stale","content":${JSON.stringify(JSON.stringify({ a: Array.from({ length: 40 }, (_, i) => `v${i}`) }, null, 4))}}`;
    const raw = `{ "messages" :\n[\n{ "role":"user" , "content" : [ ${tr} ] } ,\n{"role":"user","content":"x"} ] , "messages":[{"role":"user","content":[ ${tr} ]},{"role":"user","content":"x"}] }`;
    const r = transformRequestBody(raw, CFG)!;
    expect(r.minifiedBlocks).toBe(1);
    expect(r.body.startsWith('{ "messages" :\n[\n{ "role":"user" , "content" : [ ')).toBe(true);
    expect(r.body.endsWith('{"role":"user","content":"x"}] }')).toBe(true);
    const got = JSON.parse(r.body).messages[0].content[0].content as string;
    expect(got).toBe(JSON.stringify({ a: Array.from({ length: 40 }, (_, i) => `v${i}`) }));
  });
});

// ------------------------------------------------ T1b memoised minify
describe("memoised minify (T1b)", () => {
  const doc = (n: number) =>
    JSON.stringify(
      { items: Array.from({ length: 350 }, (_, i) => ({ id: `n${n}-${i}`, name: `row ${i}`, note: "keep  these\tspaces", tags: ["a", "b"] })) },
      null,
      2,
    );

  test("200-message history of pretty-JSON tool results: the second call on the session scans nothing again", () => {
    const kb = Math.round(doc(0).length / 1024);
    const messages = Array.from({ length: 200 }, (_, n) => msg("user", [{ type: "tool_result", tool_use_id: `t${n}`, content: doc(n) }]));
    const raw = JSON.stringify({ model: "claude-sonnet-4", messages });
    // imaging and the auto breakpoint off: this is the minify + bookkeeping path (imaging has its own memo)
    const cfg = { ...CFG, minChars: 1e9, autoCache: false };
    const s = newSession();
    let t = performance.now();
    const first = transformRequestBody(raw, cfg, s)!;
    const t1 = performance.now() - t;
    const scanned = s.memoChars;
    t = performance.now();
    const second = transformRequestBody(raw, cfg, s)!;
    const t2 = performance.now() - t;
    // timing is informational (shared CI runners); the gate owns speed
    console.log(`memo timing: ${messages.length} messages x ${kb} KB pretty JSON (${(raw.length / 1e6).toFixed(1)} MB): first ${t1.toFixed(0)} ms, second ${t2.toFixed(0)} ms`);
    expect(first.minifiedBlocks).toBe(200);
    expect(second.minifiedBlocks).toBe(200);
    expect(second.body).toBe(first.body);
    expect(s.minifyMemo.size).toBe(200);
    expect(s.memoChars).toBe(scanned); // every block came from the memo: no text was scanned or parsed twice
  });

  test("already-compact JSON is never parsed (whitespace pre-check) and stays untouched", () => {
    const compact = JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => ({ id: i, name: `row ${i}` })) });
    const s = newSession();
    const r = transformRequestBody(JSON.stringify({ messages: [msg("user", [{ type: "tool_result", tool_use_id: "t", content: compact }])] }), CFG, s)!;
    expect(r.changed).toBe(false);
    expect([...s.minifyMemo.values()].map((m) => m.min)).toEqual([null]); // the verdict is remembered
  });

  test("the image memo is keyed by config: another font in the same session images afresh", () => {
    const raw = JSON.stringify({ messages: [msg("user", BIG), msg("user", "x")] });
    const tiny = { ...CFG, font: "tiny" as const };
    const s = newSession();
    const normal = transformRequestBody(raw, CFG, s)!;
    const other = transformRequestBody(raw, tiny, s)!;
    expect(other.body).toBe(transformRequestBody(raw, tiny)!.body); // == a cold session's answer
    expect(other.body).not.toBe(normal.body);
    expect(transformRequestBody(raw, CFG, s)!.body).toBe(normal.body); // and back again
    expect(s.imageMemo.size).toBe(2);
  });

  test("the memo never changes the bytes: warm and cold sessions agree", () => {
    const raw = JSON.stringify({ messages: [msg("user", [{ type: "tool_result", tool_use_id: "t", content: doc(1) }]), msg("assistant", "ok")] });
    const cold = transformRequestBody(raw, CFG)!;
    const s = newSession();
    transformRequestBody(raw, CFG, s);
    expect(transformRequestBody(raw, CFG, s)!.body).toBe(cold.body);
  });
});

// ------------------------------------------------ T8a automatic cache breakpoint
describe("automatic cache breakpoint (T8a)", () => {
  // the feature is opt-in (PROXY_DEFAULTS.autoCache is false): these tests turn it on
  const AUTO: ProxyCfg = { ...CFG, autoCache: true };
  const total = (body: string): number => body.split("cache_control").length - 1;
  const conv = (n: number, first: unknown = "q0", extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      model: "claude-sonnet-4",
      messages: [msg("user", first), msg("assistant", "a0"), msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2")].slice(0, n),
      ...extra,
    });

  const warm = (cfg: ProxyCfg): boolean => {
    const ss = newSession();
    transformRequestBody(conv(1), cfg, ss);
    transformRequestBody(conv(3), cfg, ss);
    return transformRequestBody(conv(5), cfg, ss)!.autoCache;
  };

  test("default cfg places none: the proxy stays a pass-through", () => {
    const s = newSession();
    for (const n of [1, 3, 5]) {
      const r = transformRequestBody(conv(n), CFG, s)!;
      expect(r.autoCache).toBe(false);
      expect(r.body).toBe(conv(n));
    }
  });

  test("first two requests untouched, the third gets exactly one breakpoint before the recency window", () => {
    const s = newSession();
    const r1 = transformRequestBody(conv(1), AUTO, s)!;
    const r2 = transformRequestBody(conv(3), AUTO, s)!;
    expect(r1.changed || r2.changed || r1.autoCache || r2.autoCache).toBe(false);
    const r3 = transformRequestBody(conv(5), AUTO, s)!;
    expect(r3.autoCache).toBe(true);
    // the same literal becomes the one text block that carries it; nothing else moves
    expect(r3.body).toBe(conv(5).replace('"content":"a1"', '"content":[{"type":"text","text":"a1","cache_control":{"type":"ephemeral"}}]'));
    expect(total(r3.body)).toBe(1);
  });

  test("a client breakpoint on any message block suppresses it", () => {
    const s = newSession();
    const client = [{ type: "text", text: "q0", cache_control: { type: "ephemeral" } }];
    for (const n of [1, 3, 5]) {
      const r = transformRequestBody(conv(n, client), AUTO, s)!;
      expect(r.autoCache).toBe(false);
      expect(r.changed).toBe(false);
    }
  });

  const ccBlock = { type: "text", text: "x", cache_control: { type: "ephemeral" } };
  const withSystem = (n: number) => (n > 0 ? { system: Array.from({ length: n }, () => ccBlock) } : {});
  // four tools, the first `n` of them carrying a breakpoint
  const withTools = (n: number) => ({ tools: [0, 1, 2, 3].map((i) => ({ name: `t${i}`, description: "d", input_schema: { type: "object" }, ...(i < n ? { cache_control: { type: "ephemeral" } } : {}) })) });

  test("client breakpoints in system, tools or both count toward the ceiling of 4", () => {
    // [system, tools, does auto place one?]
    for (const [sn, tn, expected] of [[4, 0, false], [3, 0, true], [0, 4, false], [0, 3, true], [2, 2, false], [1, 2, true], [1, 3, false], [3, 1, false], [2, 1, true]] as const) {
      const extra = { ...withSystem(sn), ...withTools(tn) };
      const s = newSession();
      transformRequestBody(conv(1, "q0", extra), AUTO, s);
      transformRequestBody(conv(3, "q0", extra), AUTO, s);
      const r = transformRequestBody(conv(5, "q0", extra), AUTO, s)!;
      expect(r.autoCache).toBe(expected);
      expect(total(r.body)).toBe(sn + tn + (expected ? 1 : 0));
    }
  });

  test("with imaging on, the imaged-prefix breakpoint and the automatic one never pass 4 in total", () => {
    const cfg = { ...AUTO, minChars: 1000 };
    for (let sn = 0; sn <= 4; sn++) {
      for (let tn = 0; sn + tn <= 4; tn++) {
        const k = sn + tn;
        const extra = { ...withSystem(sn), ...withTools(tn) };
        const s = newSession();
        // BIG opens the conversation, so it is imaged from the first request on
        for (const n of [3, 3]) expect(total(transformRequestBody(conv(n, BIG, extra), cfg, s)!.body)).toBeLessThanOrEqual(4);
        const r = transformRequestBody(conv(5, BIG, extra), cfg, s)!;
        expect(r.imagedBlocks).toBe(1);
        expect(r.cached).toBe(k < 4);
        expect(r.autoCache).toBe(k < 3);
        expect(total(r.body)).toBe(Math.min(4, k + 2));
      }
    }
  });

  test("breakpoints inside a tool_result's own content count too", () => {
    const nested = (n: number) => msg("user", [{ type: "tool_result", tool_use_id: "t", content: Array.from({ length: n }, () => ccBlock) }]);
    // four nested breakpoints leave no room for the imaged-prefix one
    const full = JSON.stringify({ model: "claude-sonnet-4", messages: [msg("user", BIG), msg("assistant", "a0"), nested(4), msg("assistant", "a1"), msg("user", "q2")] });
    const r = transformRequestBody(full, AUTO)!;
    expect(r.imagedBlocks).toBe(1);
    expect(r.cached).toBe(false);
    expect(total(r.body)).toBe(4);
    // and a nested one is a client breakpoint: the automatic one stays away
    const s = newSession();
    const turn = (n: number) => JSON.stringify({ model: "claude-sonnet-4", messages: [nested(1), msg("assistant", "a0"), msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2")].slice(0, n) });
    for (const n of [1, 3, 5]) expect(transformRequestBody(turn(n), AUTO, s)!.autoCache).toBe(false);
  });

  test("a prefix that keeps changing earns none; --no-cache and a missing session also opt out", () => {
    const s = newSession();
    for (const n of [1, 3, 5, 5]) {
      // message 0 differs on every request: the cache never held, so nothing to protect
      const r = transformRequestBody(conv(n, `q0-${Math.random()}`), AUTO, s)!;
      expect(r.autoCache).toBe(false);
    }
    expect(warm(AUTO)).toBe(true);
    expect(warm({ ...AUTO, cache: false })).toBe(false);
    expect(transformRequestBody(conv(5), AUTO)!.autoCache).toBe(false);
  });

  test("TANUKI_AUTO_CACHE=on opts in with the default cfg (but not past --no-cache); off means nothing special", () => {
    const prev = process.env.TANUKI_AUTO_CACHE;
    try {
      process.env.TANUKI_AUTO_CACHE = "on";
      expect(warm(CFG)).toBe(true);
      expect(warm({ ...CFG, cache: false })).toBe(false);
      process.env.TANUKI_AUTO_CACHE = "off";
      expect(warm(CFG)).toBe(false);
      expect(warm(AUTO)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TANUKI_AUTO_CACHE;
      else process.env.TANUKI_AUTO_CACHE = prev;
    }
  });

  test("a thinking tail and an empty string cannot carry one", () => {
    const thinking = (n: number) =>
      JSON.stringify({ messages: [msg("user", "q0"), msg("assistant", [{ type: "thinking", thinking: "hm", signature: "s" }]), msg("user", "q1"), msg("assistant", "a"), msg("user", "q2")].slice(0, n) });
    const s = newSession();
    // boundary message of the 5-message request is index 3 ("a"); make it the thinking one instead
    const body = (n: number) => thinking(n).replace('"content":"a"', '"content":[{"type":"thinking","thinking":"hm","signature":"s"}]');
    transformRequestBody(body(1), AUTO, s);
    transformRequestBody(body(3), AUTO, s);
    const r = transformRequestBody(body(5), AUTO, s)!;
    expect(r.autoCache).toBe(false);
    expect(r.changed).toBe(false);
  });

  test("the breakpoint lands on the client's own last block, as one more member", () => {
    const s = newSession();
    const head = '{"model":"m","messages":[{"role":"user","content":"q0"},{"role":"assistant","content":"a0"},{"role":"user","content":"q1"}';
    const short = `${head}]}`;
    const long = `${head},{"role":"assistant","content":[{"type":"text","text":"a1"},{"type":"text", "text":"a2" }]},{"role":"user","content":"q2"}]}`;
    transformRequestBody(short, AUTO, s);
    transformRequestBody(short, AUTO, s);
    const r = transformRequestBody(long, AUTO, s)!;
    expect(r.autoCache).toBe(true);
    expect(r.body).toBe(long.replace('"text":"a2" }', '"text":"a2","cache_control":{"type":"ephemeral"} }'));
  });

  test("the event log says so (wire)", async () => {
    const upstream = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    const log = `/tmp/tanuki-proxy-auto-${process.pid}.jsonl`;
    const prev = process.env.TANUKI_EVENTS;
    process.env.TANUKI_EVENTS = log;
    const proxy = startProxy({ ...AUTO, port: 0, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
    await new Promise<void>((ok) => proxy.on("listening", ok));
    const port = (proxy.address() as AddressInfo).port;
    try {
      for (const n of [1, 3, 5]) {
        await (await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: conv(n) })).text();
      }
      await Bun.sleep(50);
      const rows = (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => r.auto_cache)).toEqual([false, false, true]);
    } finally {
      proxy.close();
      upstream.close();
      rmSync(log, { force: true });
      if (prev === undefined) delete process.env.TANUKI_EVENTS;
      else process.env.TANUKI_EVENTS = prev;
    }
  });
});

// ------------------------------------------------ T8b client cache-break warning
describe("client cache-break warning (T8b)", () => {
  // the client rewrites message 1 on every turn (a volatile timestamp, say)
  const turn = (n: number, tool?: string): string =>
    JSON.stringify({
      model: "claude-sonnet-4",
      messages: [
        msg("user", tool === undefined ? "q0" : [{ type: "tool_result", tool_use_id: "t", content: tool }]),
        msg("assistant", `reply at ${n}`),
        msg("user", "q1"),
      ],
    });

  test("three consecutive modified breaks in an untouched message warn once, naming block and type", () => {
    const s = newSession();
    expect(transformRequestBody(turn(0), CFG, s)!.clientBreak).toBe(0);
    const streak: number[] = [];
    const warns: (string | null)[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const r = transformRequestBody(turn(n), CFG, s)!;
      streak.push(r.clientBreak);
      warns.push(r.warn);
    }
    expect(streak).toEqual([1, 2, 3, 4, 5]);
    expect(warns.slice(0, 2)).toEqual([null, null]);
    expect(warns[2]).toContain("message 1");
    expect(warns[2]).toContain("block 1");
    expect(warns[2]).toContain("text");
    expect(warns[2]).toContain("cache never holds");
    expect(warns.slice(3)).toEqual([null, null]); // once per session
  });

  test("a clean append resets the streak", () => {
    const s = newSession();
    transformRequestBody(turn(0), CFG, s);
    transformRequestBody(turn(1), CFG, s);
    expect(transformRequestBody(turn(2), CFG, s)!.clientBreak).toBe(2);
    // pure append of the same messages: cache intact
    const grown = JSON.stringify({ ...JSON.parse(turn(2)), messages: [...JSON.parse(turn(2)).messages, msg("assistant", "more")] });
    expect(transformRequestBody(grown, CFG, s)!.clientBreak).toBe(0);
    expect(transformRequestBody(turn(3), CFG, s)!.clientBreak).toBe(1);
  });

  test("a break inside a message the proxy rewrote is not the client's", () => {
    const s = newSession();
    const pretty = (n: number) => JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ id: `v${n}-${i}`, note: "keep  spaces" })) }, null, 2);
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const r = transformRequestBody(turn(0, pretty(n)), CFG, s)!;
      expect(r.minifiedBlocks).toBe(1);
      expect(r.clientBreak).toBe(0);
      expect(r.warn).toBeNull();
    }
  });

  test("the event row carries client_break and the estimate next to the bill (wire)", async () => {
    const upstream = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { input_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 } }));
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    const log = `/tmp/tanuki-proxy-cb-${process.pid}.jsonl`;
    const prev = process.env.TANUKI_EVENTS;
    process.env.TANUKI_EVENTS = log;
    const proxy = startProxy({ ...CFG, port: 0, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
    await new Promise<void>((ok) => proxy.on("listening", ok));
    const port = (proxy.address() as AddressInfo).port;
    try {
      for (const n of [0, 1, 2, 3]) await (await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: turn(n) })).text();
      await Bun.sleep(50);
      const rows = (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => r.client_break)).toEqual([undefined, 1, 2, 3]);
      for (const r of rows) {
        expect(r.billed_input_tokens).toBe(55);
        expect(r.est_input_tokens).toBeGreaterThan(0);
      }
    } finally {
      proxy.close();
      upstream.close();
      rmSync(log, { force: true });
      if (prev === undefined) delete process.env.TANUKI_EVENTS;
      else process.env.TANUKI_EVENTS = prev;
    }
  });
});

// ------------------------------------------------ T2b estimated vs billed
describe("estimated vs billed (T2b)", () => {
  test("the estimate covers system, tools, text, tool traffic and our own pages", () => {
    const tool = { name: "get", description: "fetch a thing", input_schema: { type: "object" } };
    const base = { model: "m", system: "You are terse.", tools: [tool], messages: [msg("user", "hello there"), msg("assistant", [{ type: "tool_use", id: "t1", name: "get", input: { k: "v" } }]), msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "done" }])] };
    const r = transformRequestBody(JSON.stringify(base), CFG)!;
    expect(r.estTokens).toBeGreaterThan(20);
    // more text -> larger estimate, monotonically
    const more = transformRequestBody(JSON.stringify({ ...base, system: `${base.system} ${"Be careful and precise. ".repeat(40)}` }), CFG)!;
    expect(more.estTokens).toBeGreaterThan(r.estTokens + 100);
    // an imaged block is priced at its pages, not at the text it replaced
    const imaged = transformRequestBody(JSON.stringify({ messages: [msg("user", BIG), msg("user", "latest")] }), CFG)!;
    const asText = transformRequestBody(JSON.stringify({ messages: [msg("user", BIG), msg("user", "latest")] }), { ...CFG, minChars: 1e9 })!;
    expect(imaged.imagedBlocks).toBe(1);
    expect(imaged.estTokens).toBeLessThan(asText.estTokens);
    expect(imaged.estTokens).toBeGreaterThan(200); // pages are not free
  });

  test("tanuki_stats reports estimated and billed totals and their ratio", async () => {
    const log = `/tmp/tanuki-stats-est-${process.pid}.jsonl`;
    const row = (est: number, input: number, read: number, create: number) => JSON.stringify({ tool: "proxy", est_input_tokens: est, input_tokens: input, cache_read_tokens: read, cache_create_tokens: create });
    await Bun.write(log, [row(100, 60, 30, 10), row(300, 200, 100, 0), row(50, 0, 0, 0), JSON.stringify({ tool: "proxy", input_tokens: 5 })].join("\n") + "\n");
    const prev = process.env.TANUKI_EVENTS;
    process.env.TANUKI_EVENTS = log;
    try {
      const { pxStats } = await import("../src/stats.ts");
      const { jstring } = await import("../src/serde.ts");
      const st = pxStats() as Record<string, unknown>;
      // the zero-billed row (an error response) and the row without an estimate are excluded
      expect(st.estimatedInputTokens).toBe(400);
      expect(st.billedInputTokens).toBe(400);
      expect(jstring(st.estimatorRatioPct, false)).toBe("100.0");
      expect(st.actualInputTokens).toBe(405);
    } finally {
      rmSync(log, { force: true });
      if (prev === undefined) delete process.env.TANUKI_EVENTS;
      else process.env.TANUKI_EVENTS = prev;
    }
  });
});
