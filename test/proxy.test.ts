// Implicit mode: proves the middlebox images oversized blocks IN PLACE and
// nothing else — system prompt/tools untouched, latest message untouched,
// cache_control untouched — and that the wire behaves (transform applied
// upstream-bound, response passthrough, count_tokens ignored).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PROXY_DEFAULTS, startProxy, transformRequestBody, type ProxyCfg } from "../src/proxy.ts";

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
    expect(transformRequestBody(body, CFG)).toBeNull();
  });

  test("cache_control blocks pass through untouched", () => {
    const body = JSON.stringify({
      messages: [
        msg("user", [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }]),
        msg("user", "latest"),
      ],
    });
    expect(transformRequestBody(body, CFG)).toBeNull(); // rule 4
  });

  test("small blocks and non-message bodies pass through", () => {
    expect(transformRequestBody(JSON.stringify({ messages: [msg("user", SMALL), msg("user", "x")] }), CFG)).toBeNull();
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
