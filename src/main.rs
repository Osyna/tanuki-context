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
//!      tanuki-context verify <id> <value>
//!      tanuki-context run [--query re] -- <command> [args...]
//!      tanuki-context proxy [--port N] [--upstream URL] [knobs]   (implicit mode)

mod atlas;
mod codebook;
mod cost;
mod distill;
mod fidelity;
mod ladder;
mod needles;
mod png;
mod proxy;
mod render;
mod sha256;
mod stash;
mod stats;
mod table;

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
    table: Option<(usize, usize)>, // (rows, cols) when the table codec applied
}

/// Stages 0 + 0.5 + 1: optional columnar table, optional distill, optional
/// codebook, then ladder level.
fn stage01(
    text: &str,
    level: u8,
    use_distill: bool,
    query: Option<&str>,
    use_codebook: bool,
    use_table: bool,
) -> PipelineOut {
    let mut working = std::borrow::Cow::Borrowed(text);
    let mut table = None;
    if use_table {
        if let Some(t) = table::table_encode(&working) {
            table = Some((t.rows, t.cols));
            working = std::borrow::Cow::Owned(t.text);
        }
    }
    let mut stage0 = None;
    if use_distill || query.is_some() {
        let d = distill::distill_log(&working, query, 2);
        working = std::borrow::Cow::Owned(d.distilled);
        stage0 = Some(d.stats);
    }
    let mut cb_entries = 0;
    if use_codebook {
        let cb = codebook::apply(&working);
        working = std::borrow::Cow::Owned(cb.text);
        cb_entries = cb.entries;
    }
    let c = ladder::compress_text(&working, level);
    PipelineOut {
        stage0,
        compressed: c.compressed,
        protected_lines: c.protected_lines,
        level: c.level,
        cb_entries,
        table,
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
    table: bool,
    verbatim: bool,
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
        table: args["table"].as_bool().unwrap_or(false),
        verbatim: args["verbatim"].as_bool().unwrap_or(true),
    }
}

/// Ladder walk, server-side: price the knob combos in one pass so the model
/// does not spend tool rounds probing. The headline fields walk only the
/// REVERSIBLE knobs (pack is byte-exact, codebook is legend-decodable, table
/// is value-lossless columnar for whole-JSON input); distill is
/// lossy-but-counted and built for logs, so its walk is reported separately
/// as `withDistill` - never labeled safe, because on source code collapsing
/// similar-looking lines is not safe. Strictly-less keeps the earliest
/// (fewest-knob) combo on ties. ponytail: ~7 extra estimates + 1 distill per
/// call; gate behind a flag if huge-input latency ever matters.
fn recommend_for(text: &str) -> Value {
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
    let tbl = table::table_encode(text);
    let (mut cb, mut est, mut winner) = walk(text);
    let mut table = false;
    if let Some(t) = &tbl {
        let (wcb, west, wwin) = walk(&t.text);
        if west.tokens < est.tokens {
            (cb, est, winner) = (wcb, west, wwin);
            table = true;
        }
    }
    let dis_base = if table { tbl.as_ref().unwrap().text.as_str() } else { text };
    let distilled = distill::distill_log(dis_base, None, 2).distilled;
    let (dcb, dest, _) = walk(&distilled);
    let tiny = render::estimate_text(&winner, true, true, render::Font::Tiny);
    // Stays-as-text route (no pxpipe): the wider router's answer for when imaging
    // loses - cached text, small inputs, or credential content that must not be
    // pixels. Lossless whitespace (ladder L1: trailing ws + blank-line runs, safe
    // for code) is the headline; distill is the lossy-but-error-preserving log
    // sibling, priced as text - the same distilled bytes withDistill counts as
    // pages. Tier 0/1 of the density note: delete waste before you reach to image.
    let raw_text_tok = text_tokens(text.chars().count());
    let ws_tok = text_tokens(ladder::compress_text(text, 1).compressed.chars().count());
    let ws_wins = ws_tok < raw_text_tok;
    let text_tok = if ws_wins { ws_tok } else { raw_text_tok };
    json!({
        "codebook": cb,
        "imageTokens": est.tokens,
        "pages": est.pages,
        "table": table,
        "tinyImageTokens": tiny.tokens,
        "withDistill": { "codebook": dcb, "imageTokens": dest.tokens },
        "text": {
            "transform": if ws_wins { "whitespace" } else { "none" },
            "tokens": text_tok,
            "savedPct": pct(raw_text_tok, text_tok),
            "withDistill": text_tokens(distilled.chars().count()),
        },
    })
}

/// The hybrid pick: ONE recommended route over the candidates `recommend`
/// already prices, gated by real cost AND read-back fidelity - not just fewest
/// tokens. Imaging is chosen only when it clears the DeepSeek-OCR clean band
/// (high/good) AND is the genuine save; past the cliff, on cached content, or on
/// credentials it routes to the lossless text side. Every alternative stays
/// priced in `recommend` for the caller to override - the historic image/text
/// call widened to hybrid. Byte-identical decision with the TS engine.
fn route_for(raw_tok: u64, rec: &Value, side_tok: u64, creds: bool, cost_cheaper: Option<&str>, dense: bool) -> Value {
    let rec_img = rec["imageTokens"].as_u64().unwrap();
    let text_tok = rec["text"]["tokens"].as_u64().unwrap();
    let transform = rec["text"]["transform"].as_str().unwrap();
    let image_tok = rec_img + side_tok; // imaging always ships the verbatim sidecar
    let fid = fidelity::fidelity(raw_tok, rec_img, false);
    let level = fid["level"].as_str().unwrap();
    let image_clean = level == "high" || level == "good";
    let text_pick = if transform == "none" { "raw" } else { "text" };
    let (pick, tokens, fidelity_s, reason): (&str, u64, &str, &str) = if creds {
        (text_pick, text_tok, "exact", "credential content is never imaged - stay text")
    } else if dense {
        // The sidecar hit its budget, so some exact strings are NOT carried.
        // The cost math cannot catch this alone - a capped sidecar stays cheap
        // while dropping the very ids it exists to protect.
        (text_pick, text_tok, "exact", "needle-dense: more exact strings than the sidecar can carry, so imaging would drop some of them unverifiably - stay text")
    } else if cost_cheaper == Some("TEXT") {
        (text_pick, text_tok, "exact", "priced in dollars the text side wins (cached content loses as pixels)")
    } else if image_clean && image_tok < text_tok {
        ("image", image_tok, level, "imaging clears the read-back band and beats the text side on tokens")
    } else if !image_clean {
        (text_pick, text_tok, "exact", "imaging is past the read-back cliff; the lossless text route keeps fidelity (image only to comprehend the bulk)")
    } else {
        (text_pick, text_tok, "exact", "the text side is already the cheaper route; imaging adds no real save")
    };
    json!({ "pick": pick, "tokens": tokens, "savedPct": pct(raw_tok, tokens), "fidelity": fidelity_s, "reason": reason })
}

fn tool_estimate(args: &Value) -> Value {
    let a = pipe_args(args);
    let p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
    let font = render::Font::parse(a.font);
    let est = render::estimate_text(&p.compressed, a.reflow, a.pack, font);
    let side = if a.verbatim { Some(needles::scan_needles_sized(&p.compressed, a.text.chars().count())) } else { None };
    let side_tok = side.as_ref().map_or(0, |s| s.tokens);
    let img_tok = est.tokens;
    let raw_tok = text_tokens(a.text.chars().count());
    let (name, loss, _) = ladder::LEVELS[p.level as usize];
    let model = args["model"].as_str();
    let cached = args["cached"].as_bool().unwrap_or(false);
    let creds = needles::scan_credentials(a.text);
    let has_creds = !creds.is_empty();
    let rec = recommend_for(a.text);
    let mut out = json!({
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
        "totalSavedPct": pct(raw_tok, img_tok + side_tok),
        "fidelity": fidelity::fidelity(raw_tok, img_tok, font == render::Font::Tiny),
        "protectedLines": p.protected_lines,
        "recommend": rec.clone(),
        "pack": a.pack,
        "font": if font == render::Font::Tiny { "tiny" } else { "normal" },
        "codebook": if a.codebook { json!(p.cb_entries) } else { json!(false) },
        "table": match p.table {
            Some((rows, cols)) => json!({ "rows": rows, "cols": cols }),
            None => json!(false),
        },
        "verbatim": match &side {
            Some(s) => json!({ "more": s.more, "dense": s.dense, "needles": s.needles.len() + s.more, "tokens": s.tokens }),
            None => json!(false),
        },
        "verdict": if has_creds { "TEXT cheaper (credentials)" } else if side.as_ref().is_some_and(|s| s.dense) { "TEXT cheaper (needle-dense)" } else if img_tok + side_tok < raw_tok { "PIPELINE cheaper" } else { "TEXT cheaper" },
        "credentials": if has_creds { json!(creds) } else { json!(false) },
    });
    // Situation-aware real cost: only when a model or cache state is supplied,
    // so the default result (and the parity harness) stay byte-identical.
    if model.is_some() || cached {
        out["cost"] = cost::cost_verdict(raw_tok, img_tok, model, cached, Some(&est.dims));
    }
    let cost_cheaper = out.get("cost").and_then(|c| c["cheaper"].as_str()).map(str::to_string);
    out["route"] = route_for(raw_tok, &rec, side_tok, has_creds, cost_cheaper.as_deref(), side.as_ref().is_some_and(|s| s.dense));
    out
}

fn tool_render(args: &Value) -> Value {
    let a = pipe_args(args);
    let creds = needles::scan_credentials(a.text);
    if !creds.is_empty() {
        return json!([{ "type": "text", "text": format!("[tanuki-context: refused to render — {} credential-shaped secret(s) detected ({}); kept as text so a secret is never silently misread from pixels]", creds.len(), creds.join(", ")) }]);
    }
    let p = stage01(a.text, a.level, a.distill, a.query, a.codebook, a.table);
    let font = render::Font::parse(a.font);
    let r = render::render_text(&p.compressed, a.reflow, a.pack, font);
    let side = if a.verbatim { Some(needles::scan_needles_sized(&p.compressed, a.text.chars().count())) } else { None };
    if let Some(s) = &side {
        if s.dense {
            // Same contract as the credential gate: exactness must never ride
            // on pixels silently.
            return json!([{ "type": "text", "text": format!("[tanuki-context: refused to render — {} of {} exact strings do not fit the verbatim sidecar and would ride as unverifiable pixels; keep this block as text, split it smaller, or pass verbatim:false to opt out knowingly]", s.more, s.needles.len() + s.more) }]);
        }
    }
    let img_tok = r.tokens;
    let raw_tok = text_tokens(a.text.chars().count());
    let (name, loss, _) = ladder::LEVELS[p.level as usize];
    let mut summary = String::new();
    if let Some((rows, cols)) = p.table {
        summary.push_str(&format!("table: {rows} rows x {cols} cols, keys stated once\n"));
    }
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
    if let Some(s) = &side {
        if !s.needles.is_empty() {
            summary.push_str(&format!(" · verbatim: {} exact strings ride below as text", s.needles.len()));
        }
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
    if let Some(s) = &side {
        if !s.text.is_empty() {
            content.push(json!({ "type": "text", "text": s.text }));
        }
    }
    json!(content)
}

fn tool_distill(args: &Value) -> Value {
    let text = args["text"].as_str().unwrap_or("");
    let mut working = std::borrow::Cow::Borrowed(text);
    let mut table = None;
    if args["table"].as_bool().unwrap_or(false) {
        if let Some(t) = table::table_encode(text) {
            table = Some((t.rows, t.cols));
            working = std::borrow::Cow::Owned(t.text);
        }
    }
    let mut d = distill::distill_log(&working, args["query"].as_str(), 2);
    if let Some((rows, cols)) = table {
        d.stats
            .as_object_mut()
            .unwrap()
            .insert("table".to_string(), json!({ "rows": rows, "cols": cols }));
    }
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

/// The slice ships its verbatim sidecar exactly like render does. Imaging a
/// fetched slice without one left every id in it unprotected, on the path the
/// manual recommends for large references. Sidecar tokens count against the
/// win, and a needle-dense slice stays text.
fn tool_fetch(args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().unwrap_or("");
    let slice = stash::fetch_slice(id, args["query"].as_str(), args["lines"].as_str())?;
    let r = render::render_text(&slice, true, true, render::Font::Normal);
    let chars = slice.chars().count();
    let raw_tok = text_tokens(chars);
    let side = needles::scan_needles_sized(&slice, chars);
    let cost = r.tokens + side.tokens;
    if !stash_pages_win(cost, r.pages.len(), raw_tok)
        || !needles::scan_credentials(&slice).is_empty()
        || side.dense
    {
        return Ok(json!([{ "type": "text", "text": slice }]));
    }
    let mut marker = format!(
        "[tanuki-context stash {id}: slice of {chars} chars imaged as {} PNG page(s), ~{cost} vs ~{raw_tok} text tokens. ↵=newline →=tab ⇥N=indent",
        r.pages.len(),
    );
    if !side.needles.is_empty() {
        marker.push_str(&format!(
            "; \u{b7}verbatim\u{b7} below carries {} exact strings as text",
            side.needles.len()
        ));
    }
    marker.push(']');
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut content = vec![json!({ "type": "text", "text": marker })];
    for page in &r.pages {
        content.push(json!({ "type": "image", "data": b64.encode(&page.png), "mimeType": "image/png" }));
    }
    if !side.text.is_empty() {
        content.push(json!({ "type": "text", "text": side.text }));
    }
    Ok(json!(content))
}

fn tool_verify(args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().unwrap_or("");
    let value = args["value"].as_str().unwrap_or("");
    let r = stash::verify_value(id, value)?;
    Ok(json!([{ "type": "text", "text": serde_json::to_string_pretty(&r).unwrap() }]))
}

fn level_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": 4 })
}

fn tools_list() -> Value {
    let text_prop = json!({ "type": "string" });
    let mut v = json!({ "tools": [
        {
            "name": "tanuki_render",
            "description": "Token-cut pipeline: optional columnar table (whole-JSON input: keys stated once in a ·cols· header, rows as tab-separated JSON cells — value-lossless), optional log distillation (dedupe noise, keep errors verbatim, optional query filter), optional codebook (repeated long tokens/path prefixes -> 1-cell sigils + a ·legend· line), then a ladder level, then dense PNG page(s) via the pxpipe imaging engine. level 0 raw · 1 whitespace (lossless) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths stay verbatim. pack (default true) = lossless tight reflow (single-cell tabs, ⇥N indent runs, width-trimmed pages). font 'tiny' = 4x6 cell, ~40% fewer image-tokens (opt-in). Image tokens are pixel-priced, so every earlier cut compounds. Returns image blocks + a breakdown.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" }, "pack": { "type": "boolean" }, "font": { "type": "string", "enum": ["normal", "tiny"] }, "codebook": { "type": "boolean" }, "table": { "type": "boolean" }, "verbatim": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_estimate",
            "description": "Estimate tokens for the pipeline (table -> distill -> codebook -> level -> pxpipe imaging) vs sending the raw text as text. Exact page geometry, no image data returned. Compare levels/pack/font/codebook to pick a loss/size tradeoff. The result's 'recommend' field prices the reversible knobs (pack/codebook, and table for whole-JSON input — keys stated once, value-lossless) and, separately under 'withDistill', the lossy-but-counted log route; its 'text' sub-field prices the best stays-as-text cut (lossless whitespace, plus a distill sibling) for when imaging loses — cached, small, or credential content. Pass 'model' (e.g. claude-opus-4, gpt-5, gemini-2.5) and/or cached:true to add a 'cost' field that prices the decision in real dollars with provider-correct image counting (Anthropic 28px patches, OpenAI 512px tiles, Gemini 768px tiles) and cache-read rates (a cached text token costs ~0.1x a fresh one on Anthropic), so imaging already-cached content usually loses even when it has fewer tokens. The 'fidelity' field maps the imaged density ratio to expected read-back accuracy (DeepSeek-OCR's cliff: ~98% under 8x text/vision tokens, ~60% by 20x; the 4x6 tiny font is capped lower), a signal to keep exact-recall in the verbatim sidecar and reserve lossy tiers for comprehension. The top-level 'route' field then makes the hybrid call for you — one recommended pick (image / text / raw) weighing real cost AND the read-back fidelity band, not just token count: image only when it clears the clean band and genuinely saves, else the lossless text side (cached, credential, or past-the-cliff content). One call replaces manual knob probing.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema(), "distill": { "type": "boolean" }, "query": { "type": "string" }, "reflow": { "type": "boolean" }, "pack": { "type": "boolean" }, "font": { "type": "string", "enum": ["normal", "tiny"] }, "codebook": { "type": "boolean" }, "table": { "type": "boolean" }, "verbatim": { "type": "boolean" }, "model": { "type": "string" }, "cached": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_distill",
            "description": "Stage 0 alone: make noisy logs/output small and readable WITHOUT imaging. Strips ANSI, collapses runs of near-identical lines/blocks into '[×N similar]', suppresses global near-dupes (exact + same-template) with exact counts, always keeps error/warn/fail lines verbatim, optional query (regex) returns only the relevant slice. table:true first columnar-encodes whole-JSON input (keys stated once) so identical rows collapse harder. Deterministic, order-preserving.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "query": { "type": "string" }, "table": { "type": "boolean" } }, "required": ["text"] }
        },
        {
            "name": "tanuki_compress",
            "description": "Stage 1 alone: graded text compression for content that stays TEXT. level 0 none · 1 whitespace (lossless, safe for code) · 2 prose · 3 dense · 4 caveman (gist only). From level 2 up code/IDs/hashes/paths are preserved verbatim.",
            "inputSchema": { "type": "object", "properties": { "text": text_prop, "level": level_schema() }, "required": ["text"] }
        },
        {
            "name": "tanuki_stats",
            "description": "Summarize the pxpipe measurement log (~/.pxpipe/events.jsonl): requests, compression counts, honest input-token savings (input + cache reads + cache creates), and the output-token share of the bill — the part no input-side tool can cut.",
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
        },
        {
            "name": "tanuki_verify",
            "description": "Disk-grounded exact check for a value you read off a rendered page (an id/hash/version/path). No model: it compares your candidate against the stashed original bytes and returns status 'exact' (found verbatim, with line), 'corrected' (a unique near-miss exists - one substituted or transposed character; use `found`), 'ambiguous' (several near-matches in `candidates` - disambiguate with tanuki_fetch), or 'absent' (no match - do not invent one). Turns the silent misread (README Table D) into an exact match or an explicit flag. Call before acting on any value transcribed from pixels.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "value": { "type": "string" } }, "required": ["id", "value"] }
        }
    ] });
    // Brief one-line descriptions by default (~4x smaller furniture the model
    // pays for on every request); TANUKI_TOOL_VERBOSE=1 restores the full
    // contracts. The slim default surface is applied below too.
    if std::env::var("TANUKI_TOOL_VERBOSE").as_deref() != Ok("1") {
        let briefs: [(&str, &str); 8] = [
            ("tanuki_render", "Render text through the pipeline (optional distill/level/codebook) into dense PNG pages. Call after tanuki_estimate says PIPELINE cheaper."),
            ("tanuki_estimate", "Exact page/token math for the same arguments as tanuki_render, without touching pixels. Pass model and/or cached:true for a real-dollar 'cost' verdict (cached content usually should not be imaged). Instant; call this first."),
            ("tanuki_distill", "Stage 0 alone: collapse repeated log lines/blocks and template near-dupes; error/warn lines kept verbatim. Output stays greppable text."),
            ("tanuki_compress", "Stage 1 alone: graded text compression, levels 0-4, code/paths/hashes protected from level 2 up."),
            ("tanuki_stats", "Session savings summary from the events log (honest denominator: input + cache reads + cache creates)."),
            ("tanuki_stash", "Park bulky text outside the context window; returns a compact map (distill stats, top repeats, id). Retrieval pattern, tanuki pricing on the way back."),
            ("tanuki_fetch", "Pull a slice of stashed text by id + query regex or lines 'a-b'. Big slices return as dense PNG pages automatically."),
            ("tanuki_verify", "Disk-grounded check of a value read off a page vs the stashed original: exact/corrected/ambiguous/absent + line. No model. Use before trusting a transcribed id/hash/version."),
        ];
        if let Some(tools) = v["tools"].as_array_mut() {
            for t in tools {
                if let Some((_, b)) = briefs.iter().find(|(n, _)| Some(*n) == t["name"].as_str()) {
                    t["description"] = json!(b);
                }
            }
        }
    }
    // Slim default surface: advertise only the 4 workflow tools unless
    // TANUKI_ALL_TOOLS=1. The other four stay callable by name.
    if std::env::var("TANUKI_ALL_TOOLS").as_deref() != Ok("1") {
        let keep = ["tanuki_render", "tanuki_estimate", "tanuki_stash", "tanuki_verify"];
        if let Some(tools) = v["tools"].as_array_mut() {
            tools.retain(|t| keep.contains(&t["name"].as_str().unwrap_or("")));
        }
    }
    v
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
            // Self-cost, counted against ourselves: the tool schemas every request
            // carries (they ride the prompt cache after the first write, but they
            // are never free). No other tool in this category reports its own furniture.
            let mut s = stats::px_stats();
            let furniture = serde_json::to_string(&tools_list()).unwrap().chars().count();
            s["toolFurnitureTokens"] = json!(((furniture as f64) / 4.0).round() as u64);
            json!([{ "type": "text", "text": serde_json::to_string_pretty(&s).unwrap() }])
        }
        "tanuki_stash" => tool_stash(args)?,
        "tanuki_fetch" => tool_fetch(args)?,
        "tanuki_verify" => tool_verify(args)?,
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
                .expect("usage: tanuki-context distill <file> [query] [--table]");
            let text = std::fs::read_to_string(file).expect("read file");
            let mut working = text;
            if args.iter().any(|a| a == "--table") {
                if let Some(t) = table::table_encode(&working) {
                    working = t.text;
                }
            }
            let pos: Vec<&String> = args[3..].iter().filter(|a| !a.starts_with("--")).collect();
            let d = distill::distill_log(&working, pos.first().map(|s| s.as_str()), 2);
            println!("{}", serde_json::to_string(&d.stats).unwrap());
        }
        Some("estimate") => {
            let file = args.get(2).expect(
                "usage: tanuki-context estimate <file> [level] [--distill] [--table] [--no-pack] [--no-verbatim] [--font tiny] [--codebook] [--model <id>] [--cached]",
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
            let model = args
                .iter()
                .position(|a| a == "--model")
                .and_then(|i| args.get(i + 1))
                .map(String::as_str);
            let mut req = json!({
                "text": text, "level": level,
                "distill": flag("--distill"),
                "pack": !flag("--no-pack"),
                "font": font,
                "codebook": flag("--codebook"),
                "table": flag("--table"),
                "verbatim": !flag("--no-verbatim"),
                "cached": flag("--cached"),
            });
            if let Some(m) = model { req["model"] = json!(m); }
            let v = tool_estimate(&req);
            println!("{}", serde_json::to_string(&v).unwrap());
        }
        Some("render") => {
            let file = args.get(2).expect(
                "usage: tanuki-context render <file> [level] [outdir] [--distill] [--table] [--no-pack] [--no-verbatim] [--font tiny] [--codebook]",
            );
            let text = std::fs::read_to_string(file).expect("read file");
            let creds = needles::scan_credentials(&text);
            if !creds.is_empty() {
                println!("{}", json!({ "refused": true, "credentials": creds }));
                return;
            }
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
            let p = stage01(
                &text,
                level,
                args.iter().any(|a| a == "--distill"),
                None,
                use_cb,
                args.iter().any(|a| a == "--table"),
            );
            let r = render::render_text(&p.compressed, true, pack, font);
            let side = if flag("--no-verbatim") { None } else { Some(needles::scan_needles_sized(&p.compressed, text.chars().count())) };
            let tok = r.tokens;
            println!(
                "{}",
                json!({ "pages": r.pages.len(), "imageTokens": tok, "dropped": r.dropped,
                        "rawTextTokens": text_tokens(text.chars().count()),
                        "verbatimTokens": side.as_ref().map_or(0, |s| s.tokens) })
            );
            if let Some(dir) = pos.get(1).map(|s| s.as_str()) {
                std::fs::create_dir_all(dir).expect("mkdir");
                for (i, page) in r.pages.iter().enumerate() {
                    std::fs::write(format!("{dir}/page{i}.png"), &page.png).expect("write png");
                }
                if let Some(s) = &side {
                    if !s.text.is_empty() {
                        std::fs::write(format!("{dir}/verbatim.txt"), format!("{}\n", s.text)).expect("write verbatim");
                    }
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
                        let p = stage01(&text, level, use_distill, None, false, false);
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
            // Same gate as tool_fetch: sidecar cost counts against the win and
            // a needle-dense slice stays text.
            let side = needles::scan_needles_sized(&slice, slice.chars().count());
            if stash_pages_win(r.tokens + side.tokens, r.pages.len(), raw_tok)
                && needles::scan_credentials(&slice).is_empty()
                && !side.dense
            {
                println!(
                    "{}",
                    json!({ "mode": "pages", "pages": r.pages.len(),
                            "imageTokens": r.tokens, "rawTextTokens": raw_tok })
                );
                // The sidecar rides with the pages here too, or scripting the
                // CLI loses every exact string the slice carried.
                if !side.text.is_empty() {
                    println!("{}", side.text);
                }
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
        Some("verify") => {
            let id = args.get(2).expect("usage: tanuki-context verify <id> <value>");
            let value = args.get(3).expect("usage: tanuki-context verify <id> <value>");
            match stash::verify_value(id, value) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        Some("proxy") => {
            // tanuki-context proxy [--port N] [--upstream URL] [--level N] [--distill] [--table]
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
            let env_recency = std::env::var("TANUKI_RECENCY")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(d.recency_window as f64);
            proxy::run(proxy::ProxyCfg {
                port: num("--port", d.port as f64) as u16,
                upstream: sval("--upstream")
                    .cloned()
                    .or_else(|| std::env::var("TANUKI_UPSTREAM").ok())
                    .unwrap_or(d.upstream),
                level: num("--level", d.level as f64) as u8,
                distill: flag("--distill"),
                table: flag("--table"),
                codebook: flag("--codebook"),
                font: render::Font::parse(sval("--font").map(String::as_str).unwrap_or("normal")),
                min_chars: num("--min-chars", d.min_chars as f64) as usize,
                ratio: num("--ratio", d.ratio),
                min_save: num("--min-save", d.min_save as f64) as i64,
                max_pages: num("--max-pages", d.max_pages as f64) as usize,
                recency_window: num("--recency", env_recency) as usize,
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
            eprintln!("unknown command: {other}\nusage: tanuki-context [serve|proxy|distill|estimate|render|bench|stash|fetch|verify|run] ...");
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
            ["codebook", "imageTokens", "pages", "table", "text", "tinyImageTokens", "withDistill"]
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
        // stays-as-text route (no pxpipe): distill de-noise beats raw text as text
        let tf = r["text"]["transform"].as_str().unwrap();
        assert!(tf == "whitespace" || tf == "none");
        assert!(r["text"]["tokens"].as_u64().unwrap() <= v["rawTextTokens"].as_u64().unwrap());
        assert!(r["text"]["savedPct"].as_i64().unwrap() >= 0);
        assert!(
            r["text"]["withDistill"].as_u64().unwrap() < r["text"]["tokens"].as_u64().unwrap()
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
        // no trailing ws / blank runs and not a log -> nothing safe to cut, stays raw
        assert_eq!(v["recommend"]["text"]["transform"], "none");
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
    fn route_is_a_hybrid_pick_over_cost_and_fidelity() {
        let mut logx = String::new();
        for i in 0..300 {
            logx.push_str(&format!(
                "2026-07-27T09:{:02}:00Z worker INFO poll ok latency={}ms\n",
                i % 60,
                i % 40
            ));
        }
        // clean band + cheaper imaging -> image
        let v = tool_estimate(&json!({ "text": logx.clone() }));
        let r = &v["route"];
        assert_eq!(r["pick"], "image");
        let fid = r["fidelity"].as_str().unwrap();
        assert!(fid == "high" || fid == "good");
        assert!(r["savedPct"].as_i64().unwrap() > 0);
        // credentials -> never imaged, text-side and exact
        let c = tool_estimate(&json!({
            "text": "api_key=\"sk-ant-api03-SECRETSECRETSECRETSECRETdeadbeef\"\nsurrounding config line for padding and context here\n"
        }));
        let cr = &c["route"];
        let cp = cr["pick"].as_str().unwrap();
        assert!(cp == "text" || cp == "raw");
        assert_eq!(cr["fidelity"], "exact");
        assert!(cr["reason"].as_str().unwrap().contains("credential"));
        // cached -> real dollars flip the pick to the text side
        let ch = tool_estimate(&json!({ "text": logx, "model": "claude-opus-4", "cached": true }));
        let chr = &ch["route"];
        let chp = chr["pick"].as_str().unwrap();
        assert!(chp == "text" || chp == "raw");
        assert!(chr["reason"].as_str().unwrap().contains("cached"));
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

    fn table_corpus() -> String {
        (0..200)
            .map(|i| {
                serde_json::to_string(&json!({
                    "ts": format!("2026-07-26T03:{:02}:00Z", i % 60),
                    "level": if i % 7 == 0 { "error" } else { "info" },
                    "unit": format!("worker-{}.service", i % 4),
                    "message": format!("copied segment_{:05}.parquet ok", i % 9),
                    "pid": 1000 + (i % 32),
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn estimate_table_knob_reports_rows_cols_and_recommend_probes_table() {
        let ndjson = table_corpus();
        let plain = tool_estimate(&json!({ "text": ndjson, "level": 0 }));
        let tabled = tool_estimate(&json!({ "text": ndjson, "level": 0, "table": true }));
        assert_eq!(tabled["table"], json!({ "rows": 200, "cols": 5 }));
        assert_eq!(plain["table"], json!(false));
        assert!(
            tabled["imageTokens"].as_u64().unwrap() <= plain["imageTokens"].as_u64().unwrap()
        );
        // recommend probes table on its own - no knob required
        assert_eq!(plain["recommend"]["table"], json!(true));
    }

    #[test]
    fn table_and_distill_compose_identical_rows_collapse_harder() {
        let dup: String = (0..300)
            .map(|i| {
                serde_json::to_string(&json!({
                    "ts": format!("2026-07-26T03:00:{:02}Z", i % 3),
                    "level": "info",
                    "message": "heartbeat ok",
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let tabled_only = tool_estimate(&json!({ "text": dup, "level": 0, "table": true }));
        let tabled_distilled =
            tool_estimate(&json!({ "text": dup, "level": 0, "distill": true, "table": true }));
        // composition claim: identical rows collapse harder AFTER tabling, so
        // the stack strictly beats table alone.
        assert!(
            tabled_distilled["imageTokens"].as_u64().unwrap()
                < tabled_only["imageTokens"].as_u64().unwrap()
        );
    }
}
