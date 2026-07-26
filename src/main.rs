//! tanuki-context — token-cutting context pipeline, all Rust.
//!   pipeline: text -> distill (stage 0, logs) -> ladder level 0-4 (stage 1)
//!             -> pxpipe imaging (stage 2, name kept from the original mechanic)
//!
//! Default: MCP stdio server (newline-delimited JSON-RPC 2.0).
//! CLI: tanuki-context distill <file> [query]
//!      tanuki-context estimate <file> [level] [--distill]
//!      tanuki-context render <file> [level] [outdir]
//!      tanuki-context stash <file>
//!      tanuki-context fetch <id> [outdir] [--query re] [--lines a-b]
//!      tanuki-context run [--query re] -- <command> [args...]
//!      tanuki-context proxy [--port N] [--upstream URL] [knobs]   (implicit mode)

mod atlas;
mod codebook;
mod distill;
mod ladder;
mod png;
mod proxy;
mod render;
mod sha256;
mod stash;
mod stats;

use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_INLINE_PAGES: usize = 6;
const RUN_INLINE_MAX: usize = 8000; // chars (~2k tokens) the run wrapper prints inline

struct PipelineOut {
    stage0: Option<Value>,
    compressed: String,
    protected_lines: usize,
    level: u8,
    cb_entries: usize,
}

/// Stages 0 + 0.5 + 1: optional distill, optional codebook, then ladder level.
fn stage01(
    text: &str,
    level: u8,
    use_distill: bool,
    query: Option<&str>,
    use_codebook: bool,
) -> PipelineOut {
    let (mut working, stage0) = if use_distill || query.is_some() {
        let d = distill::distill_log(text, query, 2);
        (d.distilled, Some(d.stats))
    } else {
        (text.to_string(), None)
    };
    let mut cb_entries = 0;
    if use_codebook {
        let cb = codebook::apply(&working);
        working = cb.text;
        cb_entries = cb.entries;
    }
    let c = ladder::compress_text(&working, level);
    PipelineOut {
        stage0,
        compressed: c.compressed,
        protected_lines: c.protected_lines,
        level: c.level,
        cb_entries,
    }
}

fn text_tokens(chars: usize) -> u64 {
    ((chars as f64) / 4.0).round() as u64
}

fn pct(from: u64, to: u64) -> i64 {
    if from == 0 {
        return 0;
    }
    ((1.0 - to as f64 / from as f64) * 100.0).round() as i64
}

// ---------------------------------------------------------------- MCP tools

/// Shared arguments of the pipeline tools (render/estimate).
struct PipeArgs<'a> {
    text: &'a str,
    level: u8,
    distill: bool,
    query: Option<&'a str>,
    reflow: bool,
    pack: bool,
    font: &'a str,
    codebook: bool,
}

fn pipe_args(args: &'_ Value) -> PipeArgs<'_> {
    PipeArgs {
        text: args["text"].as_str().unwrap_or(""),
        level: args["level"].as_u64().unwrap_or(0) as u8,
        distill: args["distill"].as_bool().unwrap_or(false),
        query: args["query"].as_str(),
        reflow: args["reflow"].as_bool().unwrap_or(true),
        pack: args["pack"].as_bool().unwrap_or(true),
        font: args["font"].as_str().unwrap_or("normal"),
        codebook: args["codebook"].as_bool().unwrap_or(false),
    }
}

/// Reversible-only headline walk at level 0, computed from the ORIGINAL text
/// and independent of the requested knobs. Candidates in fixed order: plain,
/// codebook; the first strict minimum of image tokens wins, so ties keep the
/// earlier (fewer-knob) combo. Distill is priced separately under
/// `withDistill` because it is lossy.
fn recommend(text: &str) -> Value {
    use std::borrow::Cow;
    fn walk(base: &str) -> (bool, render::Estimated, Cow<'_, str>) {
        let mut best: Option<(bool, render::Estimated, Cow<str>)> = None;
        for cb in [false, true] {
            let cand: Cow<str> = if cb {
                Cow::Owned(codebook::apply(base).text)
            } else {
                Cow::Borrowed(base)
            };
            let est = render::estimate_text(&cand, true, true, render::Font::Normal);
            if best.as_ref().map_or(true, |b| est.tokens < b.1.tokens) {
                best = Some((cb, est, cand));
            }
        }
        best.unwrap()
    }
    let (cb, est, winner) = walk(text);
    let tiny = render::estimate_text(&winner, true, true, render::Font::Tiny);
    let distilled = distill::distill_log(text, None, 2).distilled;
    let (dcb, dest, _) = walk(&distilled);
    json!({
        "codebook": cb,
        "imageTokens": est.tokens,
        "pages": est.pages,
        "tinyImageTokens": tiny.tokens,
        "withDistill": { "codebook": dcb, "imageTokens": dest.tokens },
    })
}

fn tool_estimate(args: &Value) -> Value {
    let a = pipe_args(args);
    let p = stage01(a.text, a.level, a.distill, a.query, a.codebook);
    let font = render::Font::parse(a.font);
    let est = render::estimate_text(&p.compressed, a.reflow, a.pack, font);
    let img_tok = est.tokens;
    let raw_tok = text_tokens(a.text.chars().count());
    let (name, loss, _) = ladder::LEVELS[p.level as usize];
    json!({
        "engine": "pxpipe",
        "level": format!("{} {}", p.level, name),
        "loss": loss,
        "distill": p.stage0,
        "origChars": a.text.chars().count(),
        "stage1Chars": p.compressed.chars().count(),
        "stage1SavedPct": pct(a.text.chars().count() as u64, p.compressed.chars().count() as u64),
        "pages": est.pages,
        "imageTokens": img_tok,
        "rawTextTokens": raw_tok,
        "totalSavedPct": pct(raw_tok, img_tok),
        "protectedLines": p.protected_lines,
        "recommend": recommend(a.text),
        "pack": a.pack,
        "font": if font == render::Font::Tiny { "tiny" } else { "normal" },
        "codebook": if a.codebook { json!(p.cb_entries) } else { json!(false) },
        "verdict": if img_tok < raw_tok { "PIPELINE cheaper" } else { "TEXT cheaper" },
    })
}

fn tool_render(args: &Value) -> Value {
    let a = pipe_args(args);
    let p = stage01(a.text, a.level, a.distill, a.query, a.codebook);
    let font = render::Font::parse(a.font);
    let r = render::render_text(&p.compressed, a.reflow, a.pack, font);
    let img_tok = r.tokens;
    let raw_tok = text_tokens(a.text.chars().count());
    let (name, loss, _) = ladder::LEVELS[p.level as usize];
    let mut summary = String::new();
    if let Some(s0) = &p.stage0 {
        summary.push_str(&format!(
            "distill: {} -> {} lines (-{}% chars, {} runs, {} exact + {} template suppressed, {} error/warn kept)\n",
            s0["origLines"], s0["outLines"], s0["savedPct"], s0["collapsedRuns"],
            s0["suppressedLines"], s0["templateSuppressed"], s0["importantKept"],
        ));
    }
    summary.push_str(&format!(
        "L{} {} ({}): {} chars -> {} chars (stage1 -{}%) -> {} page(s), ~{} image-tokens\nvs ~{} text-tokens raw = TOTAL -{}%",
        p.level, name, loss,
        a.text.chars().count(), p.compressed.chars().count(),
        pct(a.text.chars().count() as u64, p.compressed.chars().count() as u64),
        r.pages.len(), img_tok, raw_tok, pct(raw_tok, img_tok),
    ));
    if p.protected_lines > 0 {
        summary.push_str(&format!(" · {} lines kept verbatim", p.protected_lines));
    }
    if r.dropped > 0 {
        summary.push_str(&format!(" · {} unmapped glyphs -> ▯", r.dropped));
    }
    if p.cb_entries > 0 {
        summary.push_str(&format!(" · codebook: {} sigils (see ·legend·)", p.cb_entries));
    }
    if font == render::Font::Tiny {
        summary.push_str(" · font: tiny 4x6");
    }
    if a.pack {
        summary.push_str(" · packed (⇥N indent, → tab)");
    }
    if a.reflow {
        summary.push_str(" · ↵ = newline · engine: pxpipe");
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut content = vec![json!({ "type": "text", "text": summary })];
    for page in r.pages.iter().take(MAX_INLINE_PAGES) {
        content.push(
            json!({ "type": "image", "data": b64.encode(&page.png), "mimeType": "image/png" }),
        );
    }
    if r.pages.len() > MAX_INLINE_PAGES {
        content.push(json!({ "type": "text", "text": format!("(+{} more page(s))", r.pages.len() - MAX_INLINE_PAGES) }));
    }
    json!(content)
}

fn tool_distill(args: &Value) -> Value {
    let text = args["text"].as_str().unwrap_or("");
    let d = distill::distill_log(text, args["query"].as_str(), 2);
    json!([
        { "type": "text", "text": serde_json::to_string_pretty(&d.stats).unwrap() },
        { "type": "text", "text": d.distilled },
    ])
}

fn tool_compress(args: &Value) -> Value {
    let text = args["text"].as_str().unwrap_or("");
    let level = args["level"].as_u64().unwrap_or(1) as u8;
    let c = ladder::compress_text(text, level);
    let (name, loss, desc) = ladder::LEVELS[c.level as usize];
    let o_tok = text_tokens(text.chars().count());
    let n_tok = text_tokens(c.compressed.chars().count());
    let stats = json!({
        "level": format!("{} {}", c.level, name), "loss": loss, "note": desc,
        "origChars": text.chars().count(), "outChars": c.compressed.chars().count(),
        "approxOrigTokens": o_tok, "approxOutTokens": n_tok,
        "savedPct": pct(o_tok, n_tok), "protectedLines": c.protected_lines,
    });
    json!([
        { "type": "text", "text": serde_json::to_string_pretty(&stats).unwrap() },
        { "type": "text", "text": c.compressed },
    ])
}

/// Stash fetch gate: pages win only when they clearly beat raw text
/// (>=25% and >=300 tokens cheaper, and few enough pages to inline).
fn stash_pages_win(tokens: u64, pages: usize, raw_tok: u64) -> bool {
    tokens as f64 <= raw_tok as f64 * 0.75
        && raw_tok as i64 - tokens as i64 >= 300
        && pages <= MAX_INLINE_PAGES
}

fn tool_stash(args: &Value) -> Result<Value, String> {
    let text = args["text"].as_str().unwrap_or("");
    let (_, overview) = stash::stash_text(text).map_err(|e| format!("stash failed: {e}"))?;
    Ok(json!([{ "type": "text", "text": overview }]))
}

fn tool_fetch(args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().unwrap_or("");
    let slice = stash::fetch_slice(id, args["query"].as_str(), args["lines"].as_str())?;
    let r = render::render_text(&slice, true, true, render::Font::Normal);
    let chars = slice.chars().count();
    let raw_tok = text_tokens(chars);
    if !stash_pages_win(r.tokens, r.pages.len(), raw_tok) {
        return Ok(json!([{ "type": "text", "text": slice }]));
    }
    let marker = format!(
        "[tanuki-context stash {id}: slice of {chars} chars imaged as {} PNG page(s), ~{} vs ~{raw_tok} text tokens. ↵=newline →=tab ⇥N=indent]",
        r.pages.len(),
        r.tokens,
    );
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut content = vec![json!({ "type": "text", "text": marker })];
    for page in &r.pages {
        content.push(json!({ "type": "image", "data": b64.encode(&page.png), "mimeType": "image/png" }));
    }
    Ok(json!(content))
}

fn level_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": 4 })
}

fn tools_list() -> Value {
    let text_prop = json!({ "type": "string" });
    json!({ "tools": [
        {
            "name": "tanuki_render",
            "description": "Token-cut pipeline: optional log distillation (dedupe noise, keep errors verbatim, optional query filter), optional codebook (repeated long tokens/path prefixes -> 1-cell sigils + a ·legend· line), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. pack (default true) = lossless tight reflow (single-cell tabs, ⇥N indent runs, width-trimmed pages). font 'tiny' = 4x6 cell, ~40% fewer image-tokens (opt-in). Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" }, "pack": { "type": "boolean" }, "font": { "type": "string", "enum": ["normal", "tiny"] }, "codebook": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_estimate",
            "description": "Estimate tokens for the pipeline (distill -> codebook -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/pack/font/codebook to pick a loss/size tradeoff. The result's 'recommend' field prices the reversible knobs (pack/codebook, level 0) and, separately under 'withDistill', the lossy-but-counted log route - one call replaces manual knob probing.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" }, "pack": { "type": "boolean" }, "font": { "type": "string", "enum": ["normal", "tiny"] }, "codebook": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_distill",
            "description": "Stage 0 alone: make noisy logs/output small and readable WITHOUT imaging. Strips ANSI, collapses runs of near-identical lines/blocks into '[×N similar]', suppresses global near-dupes (exact + same-template) with exact counts, always keeps error/warn/fail lines verbatim, optional query (regex) returns only the relevant slice. Deterministic, order-preserving.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "query": { "type": "string" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_compress",
            "description": "Stage 1 alone: graded text compression for content that stays TEXT. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths are preserved verbatim.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema() }, "required": ["text"] }
        },
        {
            "name": "tanuki_stats",
            "description": "Summarize the pxpipe measurement log (~/.pxpipe/events.jsonl): requests, compression counts, honest input-token savings (input + cache reads + cache creates).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "tanuki_stash",
            "description": "Park bulky text outside the context window (content-addressed file under TANUKI_STASH or ~/.tanuki/stash) and get back a compact map: distill stats, top repeats, first/last lines, and the stash id. Pay a few hundred tokens now, fetch slices later - the retrieval pattern, with tanuki pricing on the way back.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop }, "required": ["text"] }
        },
        {
            "name": "tanuki_fetch",
            "description": "Pull a slice of stashed text by id: query (regex, distill-powered: matches + error/warn lines + context) or lines 'a-b'. Big slices come back as dense PNG pages automatically when they clearly win (>=25% and >=300 tokens cheaper, <=6 pages); small ones stay text.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "query": { "type": "string" }, "lines": { "type": "string" } }, "required": ["id"] }
        }
    ] })
}

fn tools_call(params: &Value) -> Result<Value, String> {
    let name = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];
    let content = match name {
        "tanuki_render" => tool_render(args),
        "tanuki_estimate" => {
            json!([{ "type": "text", "text": serde_json::to_string_pretty(&tool_estimate(args)).unwrap() }])
        }
        "tanuki_distill" => tool_distill(args),
        "tanuki_compress" => tool_compress(args),
        "tanuki_stats" => {
            json!([{ "type": "text", "text": serde_json::to_string_pretty(&stats::px_stats()).unwrap() }])
        }
        "tanuki_stash" => tool_stash(args)?,
        "tanuki_fetch" => tool_fetch(args)?,
        other => return Err(format!("unknown tool: {other}")),
    };
    Ok(json!({ "content": content }))
}

// ---------------------------------------------------------------- MCP server

fn serve() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = msg.get("id").cloned();
        let reply =
            |result: Value| -> Value { json!({ "jsonrpc": "2.0", "id": id, "result": result }) };
        let out: Option<Value> = match msg["method"].as_str() {
            Some("initialize") => {
                let proto = msg["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or("2025-06-18");
                Some(reply(json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "tanuki-context", "version": VERSION },
                })))
            }
            Some("notifications/initialized") | Some("notifications/cancelled") => None,
            Some("ping") => Some(reply(json!({}))),
            Some("tools/list") => Some(reply(tools_list())),
            Some("tools/call") => Some(match tools_call(&msg["params"]) {
                Ok(r) => reply(r),
                Err(e) => {
                    json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32602, "message": e } })
                }
            }),
            _ if msg.get("id").is_some() => Some(json!({
                "jsonrpc": "2.0", "id": msg["id"],
                "error": { "code": -32601, "message": "method not found" },
            })),
            _ => None,
        };
        if let Some(v) = out {
            let mut lock = stdout.lock();
            let _ = writeln!(lock, "{v}");
            let _ = lock.flush();
        }
    }
}

// ---------------------------------------------------------------- CLI

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("distill") => {
            let file = args
                .get(2)
                .expect("usage: tanuki-context distill <file> [query]");
            let text = std::fs::read_to_string(file).expect("read file");
            let d = distill::distill_log(&text, args.get(3).map(String::as_str), 2);
            println!("{}", serde_json::to_string(&d.stats).unwrap());
        }
        Some("estimate") => {
            let file = args.get(2).expect(
                "usage: tanuki-context estimate <file> [level] [--distill] [--no-pack] [--font tiny] [--codebook]",
            );
            let text = std::fs::read_to_string(file).expect("read file");
            let pos: Vec<&String> = args[3..].iter().filter(|a| !a.starts_with("--")).collect();
            let level: u64 = pos.first().and_then(|s| s.parse().ok()).unwrap_or(0);
            let flag = |n: &str| args.iter().any(|a| a == n);
            let font = args
                .iter()
                .position(|a| a == "--font")
                .and_then(|i| args.get(i + 1))
                .map(String::as_str)
                .unwrap_or("normal");
            let v = tool_estimate(&json!({
                "text": text, "level": level,
                "distill": flag("--distill"),
                "pack": !flag("--no-pack"),
                "font": font,
                "codebook": flag("--codebook"),
            }));
            println!("{}", serde_json::to_string(&v).unwrap());
        }
        Some("render") => {
            let file = args.get(2).expect(
                "usage: tanuki-context render <file> [level] [outdir] [--distill] [--no-pack] [--font tiny] [--codebook]",
            );
            let text = std::fs::read_to_string(file).expect("read file");
            let pos: Vec<&String> = args[3..].iter().filter(|a| !a.starts_with("--")).collect();
            let level: u8 = pos.first().and_then(|s| s.parse().ok()).unwrap_or(0);
            let flag = |n: &str| args.iter().any(|a| a == n);
            let pack = !flag("--no-pack");
            let use_cb = flag("--codebook");
            let font = render::Font::parse(
                args.iter()
                    .position(|a| a == "--font")
                    .and_then(|i| args.get(i + 1))
                    .map(String::as_str)
                    .unwrap_or("normal"),
            );
            let p = stage01(&text, level, args.iter().any(|a| a == "--distill"), None, use_cb);
            let r = render::render_text(&p.compressed, true, pack, font);
            let tok = r.tokens;
            println!(
                "{}",
                json!({ "pages": r.pages.len(), "imageTokens": tok, "dropped": r.dropped,
                        "rawTextTokens": text_tokens(text.chars().count()) })
            );
            if let Some(dir) = pos.get(1).map(|s| s.as_str()) {
                std::fs::create_dir_all(dir).expect("mkdir");
                for (i, page) in r.pages.iter().enumerate() {
                    std::fs::write(format!("{dir}/page{i}.png"), &page.png).expect("write png");
                }
            }
        }
        Some("bench") => {
            // tanuki-context bench <file> <op:distill|pipeline> [level] [runs] [--distill]
            // In-process timing (median of `runs`, first run is a discarded warmup).
            // Imaging stays pxpipe-faithful (pack off) so node-vs-rust timing is comparable.
            let file = args
                .get(2)
                .expect("usage: tanuki-context bench <file> <op> [level] [runs] [--distill]");
            let op = args.get(3).map(String::as_str).unwrap_or("pipeline");
            let level: u8 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
            let runs: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(3);
            let use_distill = args.iter().any(|a| a == "--distill");
            let text = std::fs::read_to_string(file).expect("read file");
            let mut times: Vec<f64> = Vec::new();
            let mut result = json!(null);
            for i in 0..=runs {
                let t0 = std::time::Instant::now();
                match op {
                    "distill" => {
                        let d = distill::distill_log(&text, None, 2);
                        result = d.stats;
                    }
                    _ => {
                        let p = stage01(&text, level, use_distill, None, false);
                        let r = render::render_text(&p.compressed, true, false, render::Font::Normal);
                        result = json!({
                            "pages": r.pages.len(),
                            "imageTokens": r.tokens,
                            "stage1Chars": p.compressed.chars().count(),
                            "dropped": r.dropped,
                        });
                    }
                }
                if i > 0 {
                    times.push(t0.elapsed().as_secs_f64() * 1000.0);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "{}",
                json!({ "medianMs": times[times.len() / 2], "runs": runs, "result": result })
            );
        }
        Some("stash") => {
            let file = args.get(2).expect("usage: tanuki-context stash <file>");
            let text = std::fs::read_to_string(file).expect("read file");
            let (_id, overview) = stash::stash_text(&text).expect("write stash");
            println!("{overview}");
        }
        Some("fetch") => {
            // tanuki-context fetch <id> [outdir] [--query re] [--lines a-b]
            let id = args
                .get(2)
                .expect("usage: tanuki-context fetch <id> [outdir] [--query re] [--lines a-b]");
            let mut outdir: Option<&str> = None;
            let (mut query, mut lines) = (None, None);
            let mut i = 3;
            while i < args.len() {
                match args[i].as_str() {
                    "--query" => {
                        query = args.get(i + 1).map(String::as_str);
                        i += 2;
                    }
                    "--lines" => {
                        lines = args.get(i + 1).map(String::as_str);
                        i += 2;
                    }
                    other => {
                        outdir.get_or_insert(other);
                        i += 1;
                    }
                }
            }
            let slice = stash::fetch_slice(id, query, lines).unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1)
            });
            let r = render::render_text(&slice, true, true, render::Font::Normal);
            let raw_tok = text_tokens(slice.chars().count());
            if stash_pages_win(r.tokens, r.pages.len(), raw_tok) {
                println!(
                    "{}",
                    json!({ "mode": "pages", "pages": r.pages.len(),
                            "imageTokens": r.tokens, "rawTextTokens": raw_tok })
                );
                if let Some(dir) = outdir {
                    std::fs::create_dir_all(dir).expect("mkdir");
                    for (i, page) in r.pages.iter().enumerate() {
                        std::fs::write(format!("{dir}/page{i}.png"), &page.png).expect("write png");
                    }
                }
            } else {
                println!("{}", json!({ "mode": "text" }));
                println!("{slice}");
            }
        }
        Some("proxy") => {
            // tanuki-context proxy [--port N] [--upstream URL] [--level N] [--distill]
            //   [--codebook] [--font tiny] [--min-chars N] [--ratio X] [--min-save N] [--max-pages N]
            let num = |flag: &str, dflt: f64| -> f64 {
                args.iter()
                    .position(|a| a == flag)
                    .and_then(|i| args.get(i + 1))
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .unwrap_or(dflt)
            };
            let sval = |flag: &str| -> Option<&String> {
                args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1))
            };
            let flag = |n: &str| args.iter().any(|a| a == n);
            let d = proxy::ProxyCfg::default();
            proxy::run(proxy::ProxyCfg {
                port: num("--port", d.port as f64) as u16,
                upstream: sval("--upstream")
                    .cloned()
                    .or_else(|| std::env::var("TANUKI_UPSTREAM").ok())
                    .unwrap_or(d.upstream),
                level: num("--level", d.level as f64) as u8,
                distill: flag("--distill"),
                codebook: flag("--codebook"),
                font: render::Font::parse(sval("--font").map(String::as_str).unwrap_or("normal")),
                min_chars: num("--min-chars", d.min_chars as f64) as usize,
                ratio: num("--ratio", d.ratio),
                min_save: num("--min-save", d.min_save as f64) as i64,
                max_pages: num("--max-pages", d.max_pages as f64) as usize,
            });
        }
        Some("run") => {
            // rtk-style wrapper: run the command, hand the agent distilled output
            // instead of the firehose, keep the full capture fetchable. Exit code
            // passes through untouched.
            let sep = args.iter().position(|a| a == "--");
            let cmd = sep
                .map(|i| &args[i + 1..])
                .filter(|c| !c.is_empty())
                .expect("usage: tanuki-context run [--query re] -- <command> [args...]");
            let query = args
                .iter()
                .position(|a| a == "--query")
                .filter(|&qi| qi < sep.unwrap())
                .and_then(|qi| args.get(qi + 1))
                .map(String::as_str);
            let out = std::process::Command::new(&cmd[0])
                .args(&cmd[1..])
                .output()
                .unwrap_or_else(|e| panic!("spawn failed: {e}"));
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let captured = if stderr.is_empty() {
                stdout.into_owned()
            } else {
                format!("{stdout}\n--- stderr ---\n{stderr}")
            };
            let code = out.status.code().unwrap_or(0);
            let d = distill::distill_log(&captured, query, 2);
            let s = &d.stats;
            let mut lines = vec![format!(
                "[tanuki run] exit {code} · {} -> {} lines · {}% of chars removed",
                s["origLines"], s["outLines"], s["savedPct"]
            )];
            // ponytail: fixed 8000-char inline budget (~2k tokens); make it a knob
            // if real usage ever wants one.
            if d.distilled.chars().count() <= RUN_INLINE_MAX
                || captured.chars().count() <= RUN_INLINE_MAX
            {
                lines.push(d.distilled);
                if captured.chars().count() > RUN_INLINE_MAX {
                    let (id, _) = stash::stash_text(&captured).expect("write stash");
                    lines.push(format!(
                        "full output stashed: tanuki-context fetch {id} [--query re] [--lines a-b]"
                    ));
                }
            } else {
                let (_id, overview) = stash::stash_text(&captured).expect("write stash");
                lines.push(overview);
            }
            print!("{}\n", lines.join("\n"));
            std::process::exit(code);
        }
        Some("serve") | None => serve(),
        Some(other) => {
            eprintln!("unknown command: {other}\nusage: tanuki-context [serve|proxy|distill|estimate|render|bench|stash|fetch|run] ...");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Log-shaped and heavily repetitive: distill collapses the heartbeat
    /// lines, so a distilled candidate costs strictly fewer image tokens.
    fn log_corpus() -> String {
        let mut s = String::new();
        for i in 0..400 {
            s.push_str("2026-07-26T02:00:00Z INFO pool-1 heartbeat ok latency=3ms shard=7\n");
            if i % 97 == 0 {
                s.push_str(&format!(
                    "2026-07-26T02:00:00Z ERROR pool-1 dropped conn attempt={i}\n"
                ));
            }
        }
        s
    }

    // Rationale: distill collapses similar-looking lines, which is honest on
    // logs and unsafe on source code, so it is never labeled as the safe
    // headline; it is priced separately under `withDistill`.
    #[test]
    fn recommend_prices_distill_separately_for_repetitive_logs() {
        let text = log_corpus();
        let v = tool_estimate(&json!({ "text": text }));
        let r = &v["recommend"];
        let mut keys: Vec<_> = r.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["codebook", "imageTokens", "pages", "tinyImageTokens", "withDistill"]
        );
        // distill collapses the heartbeat lines, so the lossy route is cheaper
        assert!(
            r["withDistill"]["imageTokens"].as_u64().unwrap()
                < r["imageTokens"].as_u64().unwrap()
        );
        assert!(r["pages"].as_u64().unwrap() >= 1);
        assert!(
            r["tinyImageTokens"].as_u64().unwrap() <= r["imageTokens"].as_u64().unwrap()
        );
    }

    #[test]
    fn recommend_ties_break_to_fewest_knobs_on_tiny_text() {
        let text = "hello tanuki, nothing log-shaped here";
        // premise: codebook doesn't change the cost for this string
        let plain = render::estimate_text(text, true, true, render::Font::Normal).tokens;
        assert_eq!(
            render::estimate_text(&codebook::apply(text).text, true, true, render::Font::Normal)
                .tokens,
            plain,
            "tie premise broken",
        );
        // ...so the strict-minimum scan must keep the earliest combo: no knobs
        let v = tool_estimate(&json!({ "text": text }));
        assert_eq!(v["recommend"]["codebook"], false);
        assert_eq!(v["recommend"]["withDistill"]["codebook"], false);
        assert_eq!(v["recommend"]["imageTokens"].as_u64().unwrap(), plain);
    }

    #[test]
    fn recommend_ignores_requested_knobs() {
        let text = log_corpus();
        let plain = tool_estimate(&json!({ "text": text }));
        let knobbed = tool_estimate(&json!({
            "text": text, "level": 3, "distill": true, "codebook": true, "font": "tiny",
        }));
        assert_eq!(plain["recommend"], knobbed["recommend"]);
    }

    #[test]
    fn stash_fetch_small_slice_stays_text() {
        stash::with_test_dir("gate-text", || {
            let (id, _) = stash::stash_text("tiny one\ntiny two\ntiny three").unwrap();
            let content = tool_fetch(&json!({ "id": id, "lines": "1-2" })).unwrap();
            assert_eq!(content, json!([{ "type": "text", "text": "tiny one\ntiny two" }]));
        })
    }

    #[test]
    fn stash_fetch_big_slice_returns_pages_with_marker() {
        stash::with_test_dir("gate-pages", || {
            let big: String = (0..400)
                .map(|i| format!("row {i:04} the quick brown tanuki jumps over the lazy log line payload\n"))
                .collect();
            let (id, _) = stash::stash_text(&big).unwrap();
            let content = tool_fetch(&json!({ "id": id, "lines": "1-400" })).unwrap();
            let arr = content.as_array().unwrap();

            // recompute the gate inputs independently
            let slice = stash::fetch_slice(&id, None, Some("1-400")).unwrap();
            let r = render::render_text(&slice, true, true, render::Font::Normal);
            let chars = slice.chars().count();
            let raw = text_tokens(chars);
            assert!(stash_pages_win(r.tokens, r.pages.len(), raw), "premise: gate must fire");

            let marker = format!(
                "[tanuki-context stash {id}: slice of {chars} chars imaged as {} PNG page(s), ~{} vs ~{raw} text tokens. ↵=newline →=tab ⇥N=indent]",
                r.pages.len(),
                r.tokens,
            );
            assert_eq!(arr[0], json!({ "type": "text", "text": marker }));
            assert_eq!(arr.len(), 1 + r.pages.len());
            for img in &arr[1..] {
                assert_eq!(img["type"], "image");
                assert_eq!(img["mimeType"], "image/png");
                assert!(img["data"].as_str().unwrap().len() > 100);
            }
        })
    }

    #[test]
    fn stash_tool_errors_route_through_jsonrpc_error_path() {
        stash::with_test_dir("gate-errs", || {
            // neither arg
            let e = tools_call(&json!({ "name": "tanuki_fetch", "arguments": { "id": "x" } }));
            assert_eq!(e.unwrap_err(), "give exactly one of query or lines");
            // unknown id
            let e = tools_call(&json!({
                "name": "tanuki_fetch", "arguments": { "id": "000000000000", "lines": "1-2" },
            }));
            assert_eq!(e.unwrap_err(), "unknown stash id: 000000000000");
            // stash overview comes back as a single text block
            let v = tools_call(&json!({ "name": "tanuki_stash", "arguments": { "text": "a\nb" } })).unwrap();
            let text = v["content"][0]["text"].as_str().unwrap();
            assert!(text.starts_with("stashed "), "{text}");
            assert!(!text.ends_with('\n'));
        })
    }
}
