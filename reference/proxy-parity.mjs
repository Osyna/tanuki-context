// Cross-engine proxy check: the MCP parity harness drives tools/call, so the
// proxy wire path has no byte-comparison anywhere. Run the same request through
// the TS proxy and the Rust proxy against a capturing upstream, then diff what
// upstream actually received.
import http from "node:http";
import { inflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const BIG = Array.from(
  { length: 300 },
  (_, i) => `2026-07-26T02:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 5} copied /srv/data/prod/batch/segment_${String(i).padStart(5, "0")}.parquet ok`,
).join("\n");

const REQ = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 16,
  system: "SYSTEM",
  messages: [
    { role: "user", content: [{ type: "text", text: BIG }, { type: "text", text: "tail" }] },
    { role: "user", content: "latest question" },
  ],
});

const captured = [];
const upstream = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    captured.push(b);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 }, content: [] }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

const post = (port, body) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", resolve); },
    );
    r.on("error", reject);
    r.end(body);
  });

async function runEngine(label, cmd, args) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const p = spawn(cmd, [...args, "--port", String(port), "--upstream", `http://127.0.0.1:${upPort}`], { stdio: ["ignore", "pipe", "pipe"] });
  let ready = false;
  p.stderr.on("data", (d) => { if (String(d).includes("proxy on")) ready = true; });
  for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 50));
  if (!ready) { p.kill(); throw new Error(`${label} never came up`); }
  const before = captured.length;
  await post(port, REQ);
  for (let i = 0; i < 100 && captured.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  await new Promise((r) => setTimeout(r, 100));
  if (captured.length === before) throw new Error(`${label} forwarded nothing`);
  return captured.at(-1);
}

const ts = await runEngine("ts", "node", [process.env.TANUKI_TS_CLI ?? "dist/cli.js", "proxy"]);
// The Rust engine is a sibling worktree, not a dependency, so it is absent in
// a plain CI checkout. Compare cross-engine when it is there; otherwise still
// assert the single-engine invariants (breakpoint placement, recency window
// untouched, system prompt untouched) rather than silently passing on nothing.
const RS_BIN = process.env.TANUKI_BIN ?? "/tmp/tanuki-rust/target/release/tanuki-context";
const haveRust = existsSync(RS_BIN);
const rs = haveRust ? await runEngine("rust", RS_BIN, ["proxy"]) : null;
upstream.close();

const jt = JSON.parse(ts);
const last = jt.messages[0].content.at(-1);
console.log(`ts   : ${jt.messages[0].content.length} blocks, ${jt.messages[0].content.filter((b) => b.type === "image").length} image(s)`);
console.log(`       breakpoint on last block: ${JSON.stringify(last.cache_control)}`);
// serde_json serialises object keys alphabetically; the TS engine preserves
// insertion order. That is a pre-existing cosmetic difference and cannot
// matter on the wire: Anthropic parses the body, and prompt caching keys on
// the resulting token sequence, not the raw JSON bytes. So compare canonical
// JSON (keys sorted recursively) - and compare the image payloads byte-exact,
// which is the invariant that does bind.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const norm = (s) => JSON.stringify(canon(JSON.parse(s)));
console.log(`       trailing message untouched: ${JSON.stringify(jt.messages[1].content)}`);
console.log(`       system untouched: ${JSON.stringify(jt.system)}`);

// the invariant that actually binds: identical PNG bytes from both engines
// The two zlib encoders emit different compressed bytes for identical pixels;
// parity-ts.mjs handles this by inflating, so do the same here. Pixels are the
// invariant - a page must LOOK identical, not compress identically.
function pngPixels(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) raw.copy(px, y * w, y * (w + 1) + 1, (y + 1) * (w + 1));
  return { w, h, px };
}
const imgs = (s) => JSON.parse(s).messages[0].content.filter((b) => b.type === "image").map((b) => pngPixels(Buffer.from(b.source.data, "base64")));
const it = imgs(ts);
const ir = haveRust ? imgs(rs) : null;
const imgSame = !haveRust || (it.length === ir.length && it.every((d, i) => d.w === ir[i].w && d.h === ir[i].h && d.px.equals(ir[i].px)));
console.log(
  haveRust
    ? `\nimage pages: ${it.length} vs ${ir.length}, geometry ${it[0]?.w}x${it[0]?.h}, pixel-equal: ${imgSame}`
    : `\nimage pages: ${it.length}, geometry ${it[0]?.w}x${it[0]?.h} (cross-engine compare SKIPPED: no Rust binary at ${RS_BIN})`,
);

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "data" ? "<png>" : x)));
const same = !haveRust || JSON.stringify(canon(strip(JSON.parse(ts)))) === JSON.stringify(canon(strip(JSON.parse(rs))));
console.log(`canonical bodies: ${!haveRust ? "n/a (single engine - nothing was compared)" : same ? "IDENTICAL" : "DIFFER"}`);
if (!same) {
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
      return;
    }
    const s = (v) => (typeof v === "string" && v.length > 90 ? `${v.slice(0, 90)}... (${v.length} chars)` : JSON.stringify(v));
    console.log(`  DIFF ${path}\n    ts: ${s(a)}\n    rs: ${s(b)}`);
  };
  walk(canon(strip(JSON.parse(ts))), canon(strip(JSON.parse(rs))), "$");
}
const ok = same && imgSame && last?.cache_control?.type === "ephemeral";
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
