#!/usr/bin/env node
// Nightly read-back eval: does a vision model still read exact strings off the
// pages tanuki-context renders? Fidelity, not cost - the complement of the
// model-free gate. Seeded needles (uuid, semver, hex id, digest, file:line:col,
// base64, ms timestamp) are planted in a log, the log goes through the real
// `render` pipeline, the PAGES (never the verbatim sidecar) go to a model, and
// the answer is scored by exact byte match: a plausible wrong character is a
// miss, that silent failure is the whole point.
//
//   node reference/readback-nightly.mjs                     # auto: anthropic if ANTHROPIC_API_KEY, else ollama
//   node reference/readback-nightly.mjs --provider ollama [--model qwen3-vl:8b-instruct]
//   node reference/readback-nightly.mjs --provider anthropic [--model claude-haiku-4-5]
//   flags: --fonts normal,tiny   --out results.jsonl   --min 80 (exit 1 below N% exact)
//          --control text   positive control: the model gets the document TEXT instead of the
//                           page PNG (use a text model); must score ~14/14 or the harness is broken
//          --small          keep only the 14 needle lines (a page a few rows tall, not 80 lines)
//          --no-pack        render unpacked (one log line per row, pixels as the model would see a plain dump)
//
// Providers and their only credentials:
//   ollama     local daemon, OLLAMA_HOST (default http://127.0.0.1:11434); no key.
//              Needs a vision model; `ollama list` shows one or this skips.
//   anthropic  ANTHROPIC_API_KEY from the environment and nothing else - never
//              ~/.claude, never another tool's login. No key: prints "skipped"
//              and exits 0, which is what lets the scheduled workflow run
//              cleanly in a fork without the secret.
//
// Deterministic inputs (LCG seeds), so two nights differ only by the model.
// Each run appends one JSON line per font to --out (default
// readback-results.jsonl): { ts, provider, model, font, hits, total, by_kind, misses }.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { needleCorpus } from "./lib/corpus.mjs";
import { hex, lcg } from "./lib/rand.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CMD = (process.env.TANUKI_BIN || (existsSync(path.join(ROOT, "dist", "cli.js")) ? "node dist/cli.js" : "bun src/cli.ts")).split(" ");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const FONTS = { normal: { seed: 11, flags: [] }, tiny: { seed: 23, flags: ["--font", "tiny"] } };
const PROMPT_IMAGE = "This image is a rendered log.";
const PROMPT_TEXT = "This is a log.";
// The prompt names each needle's exact shape (prefix, suffix, length): the first
// version said "sha256:<hex>" and "HH:MM:SS.mmm", and a text-only control model
// answered with the bare hex and no trailing Z - right reads scored as misses.
// The positive control (--control text) is what caught that.
const PROMPT_TAIL =
  " Transcribe VERBATIM, copying each value exactly as written including any prefix or suffix, every value of these kinds:\n" +
  "UUIDs; semver versions with a pre-release tag (x.y.z-rc.n); 12-character hex ids; digests written sha256:<16 hex> (keep the sha256: prefix); " +
  "file paths with :line:col; 22-character base64-style tokens (mixed case, may include + or /); timestamps WITH milliseconds and a trailing Z (HH:MM:SS.mmmZ).\n" +
  "Ignore ordinary log timestamps that have no milliseconds.\n" +
  "Return them as a JSON array of strings, nothing else.\n";
const PROMPT = PROMPT_IMAGE + PROMPT_TAIL;

/** Same 14 needles, 7 kinds x 2, as needle-report.mjs; values differ per font
 *  so a reader cannot carry answers from one page to the next. */
function makeNeedles(r) {
  const uuid = () => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
  const semver = () => `${1 + ((r() * 20) | 0)}.${(r() * 30) | 0}.${(r() * 30) | 0}-rc.${1 + ((r() * 9) | 0)}`;
  const files = ["src/api/route.ts", "src/ingest/batch.ts", "lib/relay/frame.ts", "src/cache/lru.ts"];
  const frame = () => `${files[(r() * files.length) | 0]}:${100 + ((r() * 900) | 0)}:${1 + ((r() * 80) | 0)}`;
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64 = (n) => Array.from({ length: n }, () => B64[(r() * 64) | 0]).join("");
  const ms = () => `${String((r() * 24) | 0).padStart(2, "0")}:${String((r() * 60) | 0).padStart(2, "0")}:${String((r() * 60) | 0).padStart(2, "0")}.${String((r() * 1000) | 0).padStart(3, "0")}Z`;
  const two = (kind, f) => [{ kind, value: f() }, { kind, value: f() }];
  return [
    ...two("uuid", uuid),
    ...two("semver", semver),
    ...two("hex12 id", () => hex(r, 12)),
    ...two("sha256:16", () => `sha256:${hex(r, 16)}`),
    ...two("frame", frame),
    ...two("base64", () => b64(22)),
    ...two("ms", ms),
  ];
}

/** The seeded document for a font: needles planted in carrier lines. */
export function makeDoc(font, { small = false } = {}) {
  const { seed } = FONTS[font];
  const needles = makeNeedles(lcg(seed));
  // The base64 needles ride in `token=` / `bearer` carriers, which the render
  // credential guard (rightly) refuses to image. Rename the carriers, keep the
  // values: the read-back test is about glyphs, the guard has its own tests.
  let text = needleCorpus(lcg(seed + 1), needles).replace(/token=|bearer /g, "ref=");
  // needleCorpus plants every needle in a line starting with this timestamp; filler never does
  if (small) text = text.split("\n").filter((l) => l.startsWith("2026-07-27T09:30:00Z relay")).join("\n") + "\n";
  return { needles, text };
}

/** Render one seeded document through the real CLI; returns the page PNGs as base64. */
export function renderPages(font, { small = false, pack = true } = {}) {
  const { flags } = FONTS[font];
  const { needles, text } = makeDoc(font, { small });
  const dir = mkdtempSync(path.join(tmpdir(), "readback-"));
  try {
    const file = path.join(dir, "doc.log");
    writeFileSync(file, text);
    const out = execFileSync(CMD[0], [...CMD.slice(1), "render", file, "0", dir, ...flags, ...(pack ? [] : ["--no-pack"])], { cwd: ROOT, encoding: "utf8" });
    const info = JSON.parse(out.split("\n")[0]);
    if (info.refused) throw new Error(`render refused the document: ${out.trim()}`);
    const pages = readdirSync(dir).filter((p) => p.endsWith(".png")).sort();
    if (pages.length === 0) throw new Error(`render produced no pages: ${out.trim()}`);
    return { needles, pages: pages.map((p) => readFileSync(path.join(dir, p)).toString("base64")), imageTokens: info.imageTokens };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ollamaHost = () => (process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434");

/** Streamed: a non-streaming /api/chat sends no header until the whole answer
 *  exists, and undici gives up on a silent socket after 5 minutes - which a
 *  vision model sharing a GPU can exceed. */
async function askOllama(model, { pages, text }) {
  const res = await fetch(`${ollamaHost()}/api/chat`, {
    method: "POST",
    // num_predict bounds a degenerate repetition loop (seen live: qwen3-vl:8b repeated one timestamp for 8 minutes)
    body: JSON.stringify({ model, stream: true, think: false, options: { temperature: 0, num_ctx: 16384, num_predict: 1024 }, messages: [{ role: "user", ...(text === undefined ? { content: PROMPT, images: pages } : { content: `${PROMPT_TEXT}${PROMPT_TAIL}\n${text}` }) }] }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let answer = "";
  let buf = "";
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) if (l) answer += JSON.parse(l).message?.content ?? "";
  }
  return answer;
}

async function askAnthropic(model, { pages, text }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: "user", content: text === undefined ? [...pages.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })), { type: "text", text: PROMPT }] : [{ type: "text", text: `${PROMPT_TEXT}${PROMPT_TAIL}\n${text}` }] }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()).content ?? []).map((b) => b.text ?? "").join("");
}

/** Containment, not array equality: a model answers in prose, markdown or JSON.
 *  The `sha256:` label is literal page text a model often drops while copying the
 *  digest (seen with the text-only control, which reads it perfectly): that is
 *  instruction-following, not glyph reading, so a digest is scored on its hex. */
export function scoreReadback(needles, answer) {
  const by = {};
  let hits = 0;
  const misses = [];
  for (const n of needles) {
    const ok = answer.includes(n.value.replace(/^sha256:/, ""));
    by[n.kind] = (by[n.kind] ?? 0) + (ok ? 1 : 0);
    if (ok) hits++;
    else misses.push(n.value);
  }
  return { hits, total: needles.length, by_kind: by, misses };
}

async function pickProvider() {
  const want = arg("--provider", "auto");
  if (want === "anthropic" || (want === "auto" && process.env.ANTHROPIC_API_KEY)) {
    if (!process.env.ANTHROPIC_API_KEY) return { skip: "ANTHROPIC_API_KEY is not set" };
    return { name: "anthropic", model: arg("--model", process.env.READBACK_MODEL || "claude-haiku-4-5"), ask: askAnthropic };
  }
  if (want === "ollama" || want === "auto") {
    const model = arg("--model", process.env.READBACK_MODEL || "qwen3-vl:8b-instruct");
    const host = ollamaHost();
    let tags;
    try {
      tags = (await (await fetch(`${host}/api/tags`)).json()).models.map((m) => m.name);
    } catch {
      return { skip: `no ollama daemon at ${host}` };
    }
    if (!tags.includes(model)) return { skip: `ollama has no model ${model} (has: ${tags.join(", ") || "none"}); pass --model with a vision model` };
    return { name: "ollama", model, ask: askOllama };
  }
  throw new Error(`unknown --provider ${want} (ollama | anthropic | auto)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = await pickProvider();
  if (provider.skip) {
    console.log(`skipped: ${provider.skip}`);
    process.exit(0);
  }
  const fonts = arg("--fonts", "normal,tiny").split(",");
  const outFile = arg("--out", "readback-results.jsonl");
  const min = arg("--min", null);
  const control = arg("--control", null);
  if (control !== null && control !== "text") throw new Error(`unknown --control ${control} (text)`);
  const opts = { small: process.argv.includes("--small"), pack: !process.argv.includes("--no-pack") };
  const mode = control === "text" ? "TEXT control" : `pages${opts.small ? " small" : ""}${opts.pack ? "" : " unpacked"}`;
  console.log(`read-back eval · ${provider.name} · ${provider.model} · ${mode}`);
  console.log("| font | pages | image tokens | exact | " + ["uuid", "semver", "hex12 id", "sha256:16", "frame", "base64", "ms"].join(" | ") + " |");
  console.log("| --- | ---: | ---: | ---: | " + Array(7).fill("---:").join(" | ") + " |");
  let hits = 0;
  let total = 0;
  for (const font of fonts) {
    const { needles, pages, imageTokens } = control === "text" ? { ...makeDoc(font, opts), pages: [], imageTokens: 0 } : renderPages(font, opts);
    const t0 = Date.now();
    const answer = await provider.ask(provider.model, control === "text" ? { text: makeDoc(font, opts).text } : { pages });
    const s = scoreReadback(needles, answer);
    hits += s.hits;
    total += s.total;
    console.log(`| ${font} | ${pages.length} | ${imageTokens} | ${s.hits}/${s.total} | ${["uuid", "semver", "hex12 id", "sha256:16", "frame", "base64", "ms"].map((k) => `${s.by_kind[k] ?? 0}/2`).join(" | ")} |`);
    appendFileSync(outFile, JSON.stringify({ ts: new Date().toISOString(), provider: provider.name, model: provider.model, mode, font, pages: pages.length, image_tokens: imageTokens, ms: Date.now() - t0, ...s, answer_head: answer.slice(0, 400) }) + "\n");
  }
  const pct = total === 0 ? 0 : Math.round((hits / total) * 100);
  console.log(`\nexact ${hits}/${total} (${pct}%) · appended to ${outFile}`);
  if (min !== null && pct < Number(min)) {
    console.error(`FAIL: ${pct}% < --min ${min}%`);
    process.exit(1);
  }
}
