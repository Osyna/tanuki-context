//! tanuki-context — token-cutting context pipeline, all Rust.
//!   pipeline: text -> distill (stage 0, logs) -> ladder level 0-4 (stage 1)
//!             -> pxpipe imaging (stage 2, name kept from the original mechanic)
//!
//! Default: MCP stdio server (newline-delimited JSON-RPC 2.0).
//! CLI: tanuki-context distill <file> [query]
//!      tanuki-context estimate <file> [level] [--distill]
//!      tanuki-context render <file> [level] [outdir]

mod atlas;
mod distill;
mod ladder;
mod png;
mod render;
mod stats;

use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_INLINE_PAGES: usize = 6;

struct PipelineOut {
    stage0: Option<Value>,
    compressed: String,
    protected_lines: usize,
    level: u8,
}

/// Stages 0+1: optional distill, then ladder level.
fn stage01(text: &str, level: u8, use_distill: bool, query: Option<&str>) -> PipelineOut {
    let (working, stage0) = if use_distill || query.is_some() {
        let d = distill::distill_log(text, query, 2);
        (d.distilled, Some(d.stats))
    } else {
        (text.to_string(), None)
    };
    let c = ladder::compress_text(&working, level);
    PipelineOut {
        stage0,
        compressed: c.compressed,
        protected_lines: c.protected_lines,
        level: c.level,
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
}

fn pipe_args(args: &'_ Value) -> PipeArgs<'_> {
    PipeArgs {
        text: args["text"].as_str().unwrap_or(""),
        level: args["level"].as_u64().unwrap_or(0) as u8,
        distill: args["distill"].as_bool().unwrap_or(false),
        query: args["query"].as_str(),
        reflow: args["reflow"].as_bool().unwrap_or(true),
    }
}

fn tool_estimate(args: &Value) -> Value {
    let a = pipe_args(args);
    let p = stage01(a.text, a.level, a.distill, a.query);
    let est = render::estimate_text(&p.compressed, a.reflow);
    let img_tok = render::image_tokens(est.pixels);
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
        "verdict": if img_tok < raw_tok { "PIPELINE cheaper" } else { "TEXT cheaper" },
    })
}

fn tool_render(args: &Value) -> Value {
    let a = pipe_args(args);
    let p = stage01(a.text, a.level, a.distill, a.query);
    let r = render::render_text(&p.compressed, a.reflow);
    let img_tok = render::image_tokens(r.pixels);
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
        summary.push_str(&format!(" · {} non-BMP glyphs -> ▯", r.dropped));
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

fn level_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": 4 })
}

fn tools_list() -> Value {
    let text_prop = json!({ "type": "string" });
    json!({ "tools": [
        {
            "name": "tanuki_render",
            "description": "Token-cut pipeline: optional log distillation (dedupe noise, keep errors verbatim, optional query filter), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_estimate",
            "description": "Estimate tokens for the pipeline (distill -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/flags to pick a loss/size tradeoff.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" } }, "required": ["text"] }
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
            let file = args
                .get(2)
                .expect("usage: tanuki-context estimate <file> [level] [--distill]");
            let text = std::fs::read_to_string(file).expect("read file");
            let level: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let use_distill = args.iter().any(|a| a == "--distill");
            let v = tool_estimate(&json!({ "text": text, "level": level, "distill": use_distill }));
            println!("{}", serde_json::to_string(&v).unwrap());
        }
        Some("render") => {
            let file = args
                .get(2)
                .expect("usage: tanuki-context render <file> [level] [outdir]");
            let text = std::fs::read_to_string(file).expect("read file");
            let level: u8 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let p = stage01(&text, level, false, None);
            let r = render::render_text(&p.compressed, true);
            let tok = render::image_tokens(r.pixels);
            println!(
                "{}",
                json!({ "pages": r.pages.len(), "imageTokens": tok, "dropped": r.dropped,
                        "rawTextTokens": text_tokens(text.chars().count()) })
            );
            if let Some(dir) = args.get(4) {
                std::fs::create_dir_all(dir).expect("mkdir");
                for (i, page) in r.pages.iter().enumerate() {
                    std::fs::write(format!("{dir}/page{i}.png"), &page.png).expect("write png");
                }
            }
        }
        Some("serve") | None => serve(),
        Some(other) => {
            eprintln!("unknown command: {other}\nusage: tanuki-context [serve|distill|estimate|render] ...");
            std::process::exit(1);
        }
    }
}
