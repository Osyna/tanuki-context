//! Implicit mode: a local Anthropic middlebox, the pxpipe deployment shape
//! without pxpipe's structural flaw. Rules that keep it injection-shaped-free:
//!
//!   1. The system prompt and tool definitions are NEVER touched.
//!   2. Nothing moves between roles or positions: an oversized text block is
//!      replaced IN PLACE by a short overt marker + PNG page blocks, in the
//!      same user-role message (Anthropic allows image blocks in user content
//!      and inside tool_result content).
//!   3. The latest message is never imaged (the model may need to quote it).
//!   4. Blocks carrying cache_control are never touched (rewriting would
//!      defeat the cache they exist for).
//!   5. Imaging only happens when `estimate` says it wins by a clear margin;
//!      everything else passes through byte-for-byte.
//!
//! Responses stream through untouched; usage is scraped from the stream for
//! the ~/.pxpipe/events.jsonl savings log (same format tanuki_stats reads).
//!
//! Server: tiny_http (thread per request — SSE streams must not block the
//! next request). Client: ureq with rustls; plain http upstreams work too.

use crate::render::{self, Font};
use crate::stats;
use crate::{codebook, distill, ladder, needles, table};
use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};

pub struct ProxyCfg {
    pub port: u16,
    pub upstream: String, // e.g. https://api.anthropic.com
    pub level: u8,        // ladder level for imaged blocks (default 0: none)
    pub distill: bool,    // stage 0 on imaged blocks (off: lossy for logs, opt-in)
    pub table: bool,      // columnar-encode whole-JSON blocks before distill (keys stated once)
    pub codebook: bool,
    pub font: Font,
    pub min_chars: usize, // below this a block is never considered
    pub ratio: f64,       // image tokens must be <= ratio * text tokens
    pub min_save: i64,    // and save at least this many tokens
    pub max_pages: usize, // give up on absurdly large single blocks
    pub recency_window: usize, // trailing messages always kept as text (default 1)
}

impl Default for ProxyCfg {
    fn default() -> Self {
        ProxyCfg {
            port: 8484,
            upstream: "https://api.anthropic.com".to_string(),
            level: 0,
            distill: false,
            table: false,
            codebook: false,
            font: Font::Normal,
            min_chars: 4000,
            ratio: 0.75,
            min_save: 300,
            max_pages: 20,
            recency_window: 1,
        }
    }
}

struct ImagedBlock {
    blocks: Vec<Value>,
    orig_chars: usize,
    pages: usize,
    saved_tokens: i64,
    /// inputs for the cache-aware ledger: what the block would have cost as
    /// text and what the replacement costs, both in tokens.
    raw_tok: u64,
    cost_tok: u64,
}

/// Stage 0/0.5/1 + imaging for one text block, or None when text stays cheaper.
fn maybe_image(text: &str, cfg: &ProxyCfg) -> Option<ImagedBlock> {
    if !needles::scan_credentials(text).is_empty() {
        return None; // rule 6: never image secrets
    }
    let orig_chars = text.chars().count();
    if orig_chars < cfg.min_chars {
        return None;
    }
    let mut working = text.to_string();
    if cfg.table {
        if let Some(t) = table::table_encode(&working) {
            working = t.text;
        }
    }
    if cfg.distill {
        working = distill::distill_log(&working, None, 2).distilled;
    }
    let mut cb_entries = 0usize;
    if cfg.codebook {
        let cb = codebook::apply(&working);
        working = cb.text;
        cb_entries = cb.entries;
    }
    if cfg.level > 0 {
        working = ladder::compress_text(&working, cfg.level).compressed;
    }

    let raw_tok = ((orig_chars as f64) / 4.0).round() as u64;
    let r = render::render_text(&working, true, true, cfg.font);
    let side = crate::needles::scan_needles_sized(&working, orig_chars);
    let cost = r.tokens + side.tokens;
    if r.pages.len() > cfg.max_pages {
        return None;
    }
    let saved = raw_tok as i64 - cost as i64;
    if cost as f64 > raw_tok as f64 * cfg.ratio || saved < cfg.min_save {
        return None;
    }

    let mut marker = format!(
        "[tanuki-context: {orig_chars} chars imaged in place as {} PNG page(s), ~{cost} vs ~{raw_tok} text tokens. \u{21b5}=newline \u{2192}=tab \u{21e5}N=indent",
        r.pages.len(),
    );
    if cb_entries > 0 {
        marker.push_str(&format!("; \u{b7}legend\u{b7} line maps {cb_entries} sigils"));
    }
    if !side.needles.is_empty() {
        marker.push_str(&format!(
            "; \u{b7}verbatim\u{b7} below carries {} exact strings as text",
            side.needles.len() + side.more
        ));
    }
    marker.push(']');

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut blocks = Vec::with_capacity(1 + r.pages.len());
    blocks.push(json!({ "type": "text", "text": marker }));
    for p in &r.pages {
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": b64.encode(&p.png) },
        }));
    }
    if !side.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": side.text }));
    }
    Some(ImagedBlock {
        blocks,
        orig_chars,
        pages: r.pages.len(),
        saved_tokens: saved,
        raw_tok,
        cost_tok: cost,
    })
}

pub struct TransformResult {
    pub body: String,
    #[allow(dead_code)] // part of the TS TransformResult shape; asserted in tests
    pub imaged_blocks: usize,
    pub orig_chars: u64,
    pub image_count: u64,
    pub saved_tokens: i64,
    /// saved_tokens with the session's cache state priced in (can be negative:
    /// the first text->pages flip of a cached block is a real cost).
    pub saved_tokens_cache_aware: i64,
}

/// Cross-request memory, LEDGER-ONLY by construction: it never changes the
/// emitted bytes (a cross-request rewrite would bust the client's prompt
/// cache). It exists so the savings log can price a replayed block at the
/// cache-read rate instead of pretending every avoided token was full-price
/// input — the counterfactual-accounting hole the rakuen post names.
pub struct ProxySession {
    /// sha256 of block texts imaged in EARLIER requests this session.
    pub seen_blocks: std::collections::HashSet<String>,
    /// a prior response showed cache traffic (cache_read/cache_creation > 0).
    pub caching_seen: bool,
}

impl ProxySession {
    pub fn new() -> Self {
        ProxySession { seen_blocks: std::collections::HashSet::new(), caching_seen: false }
    }
}

/// Cache-aware tokens saved by one replaced block. Rules, mirrored in the
/// TS engine byte-for-byte:
///   no cache traffic seen  -> the raw count (nothing to discount);
///   block replayed         -> both sides ride cache reads: saved × readMult;
///   first flip of a block  -> avoided text was a cache read, the new pages
///                             are a fresh cache WRITE: read-priced saving
///                             minus write-priced cost. Usually negative —
///                             that is the point.
fn cache_aware_saved(
    raw_tok: u64,
    cost_tok: u64,
    replayed: bool,
    caching_seen: bool,
    read_mult: f64,
    write_mult: f64,
) -> i64 {
    if !caching_seen {
        return raw_tok as i64 - cost_tok as i64;
    }
    if replayed {
        return crate::cost::rnd((raw_tok as f64 - cost_tok as f64) * read_mult);
    }
    crate::cost::rnd(raw_tok as f64 * read_mult) - crate::cost::rnd(cost_tok as f64 * write_mult)
}

/// Rewrite a /v1/messages body. Returns None when nothing changed (caller
/// forwards the original bytes untouched).
pub fn transform_request_body(
    raw: &str,
    cfg: &ProxyCfg,
    mut session: Option<&mut ProxySession>,
) -> Option<TransformResult> {
    let mut body: Value = serde_json::from_str(raw).ok()?;
    let msg_count = body.get("messages")?.as_array()?.len();

    let mut imaged_blocks = 0usize;
    let mut orig_chars = 0u64;
    let mut image_count = 0u64;
    let mut saved_tokens = 0i64;
    let mut saved_tokens_cache_aware = 0i64;
    // provider ratios for the cache-aware ledger, from the request's own model
    let rate = crate::cost::resolve_rate(body.get("model").and_then(|m| m.as_str())).1;
    // Exact-repeat dedupe: block text -> page count, recorded only when a
    // block is actually imaged in THIS request. A later byte-identical block
    // that reaches the funnel becomes one short marker, no repeated pages.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut funnel = |text: &str| -> Option<Vec<Value>> {
        let tok = |chars: usize| ((chars as f64) / 4.0).round() as i64;
        let done: ImagedBlock = if let Some(&pages) = seen.get(text) {
            let chars = text.chars().count();
            let marker = format!(
                "[tanuki-context: {chars} chars, byte-identical to a block imaged above ({pages} PNG page(s)); not repeated]"
            );
            ImagedBlock {
                blocks: vec![json!({ "type": "text", "text": marker })],
                orig_chars: chars,
                pages: 0,
                saved_tokens: tok(chars) - tok(marker.chars().count()),
                raw_tok: ((chars as f64) / 4.0).round() as u64,
                cost_tok: ((marker.chars().count() as f64) / 4.0).round() as u64,
            }
        } else {
            let done = maybe_image(text, cfg)?;
            seen.insert(text.to_string(), done.pages);
            done
        };
        imaged_blocks += 1;
        orig_chars += done.orig_chars as u64;
        image_count += done.pages as u64;
        saved_tokens += done.saved_tokens;
        // ledger only, never bytes: was this exact block imaged in an earlier
        // request of this session?
        let hash = crate::sha256::hex(&crate::sha256::digest(text.as_bytes()));
        let (replayed, caching_seen) = match session.as_deref_mut() {
            Some(s) => (s.seen_blocks.contains(&hash), s.caching_seen),
            None => (false, false),
        };
        saved_tokens_cache_aware += cache_aware_saved(
            done.raw_tok,
            done.cost_tok,
            replayed,
            caching_seen,
            rate.cache_read_mult,
            rate.cache_write_mult,
        );
        if let Some(s) = session.as_deref_mut() {
            if !replayed {
                // ponytail: bounded memory — at 1024 entries start a fresh window;
                // old blocks then re-count as first flips, which only UNDERSTATES
                // savings. Mirrored exactly in the TS engine.
                if s.seen_blocks.len() >= 1024 {
                    s.seen_blocks.clear();
                }
                s.seen_blocks.insert(hash);
            }
        }
        Some(done.blocks)
    };

    // rule 3: keep the latest recency_window message(s) as text (VIST slow-fast:
    // recent turns reasoned over precisely, distant bulk imaged). Default 1.
    let keep = cfg.recency_window.max(1);
    let messages = body["messages"].as_array_mut()?;
    for m in messages.iter_mut().take(msg_count.saturating_sub(keep)) {
        // Anthropic accepts image blocks only in user-role content.
        if m["role"].as_str() != Some("user") {
            continue;
        }

        if let Some(text) = m["content"].as_str() {
            let text = text.to_string();
            if let Some(blocks) = funnel(&text) {
                m["content"] = Value::Array(blocks);
            }
            continue;
        }
        let Some(content) = m["content"].as_array_mut() else {
            continue;
        };

        let mut out: Vec<Value> = Vec::with_capacity(content.len());
        for mut block in content.drain(..) {
            if !block.is_object() || block.get("cache_control").is_some() {
                out.push(block); // rule 4
                continue;
            }
            if block["type"] == "text" {
                if let Some(text) = block["text"].as_str() {
                    let text = text.to_string();
                    if let Some(blocks) = funnel(&text) {
                        out.extend(blocks);
                        continue;
                    }
                }
                out.push(block);
                continue;
            }
            if block["type"] == "tool_result" {
                if let Some(text) = block["content"].as_str() {
                    let text = text.to_string();
                    if let Some(blocks) = funnel(&text) {
                        block["content"] = Value::Array(blocks);
                    }
                } else if block["content"].is_array() {
                    let items = block["content"].as_array_mut().unwrap();
                    let mut inner: Vec<Value> = Vec::with_capacity(items.len());
                    for item in items.drain(..) {
                        if item["type"] == "text" && item.get("cache_control").is_none() {
                            if let Some(text) = item["text"].as_str() {
                                let text = text.to_string();
                                if let Some(blocks) = funnel(&text) {
                                    inner.extend(blocks);
                                    continue;
                                }
                            }
                        }
                        inner.push(item);
                    }
                    block["content"] = Value::Array(inner);
                }
            }
            out.push(block);
        }
        m["content"] = Value::Array(out);
    }
    drop(funnel);

    if imaged_blocks == 0 {
        return None;
    }
    Some(TransformResult {
        body: body.to_string(),
        imaged_blocks,
        orig_chars,
        image_count,
        saved_tokens,
        saved_tokens_cache_aware,
    })
}

/// Best-effort usage scrape: works on both plain JSON responses and SSE
/// streams (message_start carries the same usage keys). First match wins for
/// input/cache figures; output_tokens takes the MAX across matches because
/// SSE emits a placeholder in message_start and the final count in
/// message_delta. Output is not a savings input — it is logged so stats can
/// report the share of the bill no input-side tool can touch.
fn scrape_usage(text: &str) -> (u64, u64, u64, u64) {
    static INPUT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""input_tokens"\s*:\s*(\d+)"#).unwrap());
    static READ: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""cache_read_input_tokens"\s*:\s*(\d+)"#).unwrap());
    static CREATE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""cache_creation_input_tokens"\s*:\s*(\d+)"#).unwrap());
    static OUTPUT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""output_tokens"\s*:\s*(\d+)"#).unwrap());
    let grab = |re: &Regex| -> u64 {
        re.captures(text)
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(0)
    };
    let output = OUTPUT
        .captures_iter(text)
        .filter_map(|c| c[1].parse().ok())
        .max()
        .unwrap_or(0);
    (grab(&INPUT), grab(&READ), grab(&CREATE), output)
}

fn log_event(row: &Value) {
    // stats are best-effort; never fail a request over them
    let p = stats::events_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write as _;
        let _ = writeln!(f, "{row}");
    }
}

/// Copies every streamed byte into a side buffer for the usage scrape.
struct Tee<R: Read> {
    inner: R,
    buf: Arc<Mutex<Vec<u8>>>,
}

impl<R: Read> Read for Tee<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(out)?;
        if n > 0 {
            self.buf.lock().unwrap().extend_from_slice(&out[..n]);
        }
        Ok(n)
    }
}

/// `scheme://host:port` of the upstream (any path suffix is ignored, like the
/// node proxy which forwards the client's own path onto the upstream origin).
fn upstream_origin(upstream: &str) -> &str {
    match upstream.find("://") {
        Some(i) => match upstream[i + 3..].find('/') {
            Some(j) => &upstream[..i + 3 + j],
            None => upstream,
        },
        None => upstream,
    }
}

fn handle(
    mut request: tiny_http::Request,
    cfg: &ProxyCfg,
    agent: &ureq::Agent,
    session: &Mutex<ProxySession>,
) {
    let mut body_buf: Vec<u8> = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body_buf);

    let method = request.method().to_string();
    let url = request.url().to_string();
    let has_content_encoding = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("content-encoding"));
    let is_messages = method == "POST"
        && url.starts_with("/v1/messages")
        && !url.contains("count_tokens")
        && !has_content_encoding;

    let mut tstats: Option<TransformResult> = None;
    if is_messages {
        if let Ok(text) = std::str::from_utf8(&body_buf) {
            let mut guard = session.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            tstats = transform_request_body(text, cfg, Some(&mut guard));
        }
        if let Some(s) = &tstats {
            body_buf = s.body.clone().into_bytes();
        }
    }

    let mut up = agent.request(&method, &format!("{}{url}", upstream_origin(&cfg.upstream)));
    for h in request.headers() {
        let name = h.field.as_str().as_str();
        let lower = name.to_ascii_lowercase();
        // content-length is recomputed by the client for the rewritten body.
        if matches!(lower.as_str(), "host" | "connection" | "content-length") {
            continue;
        }
        if is_messages && lower == "accept-encoding" {
            continue; // keep usage scrapable
        }
        up = up.set(name, h.value.as_str());
    }

    let up_resp = match up.send_bytes(&body_buf) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r, // 4xx/5xx pass through like any response
        Err(ureq::Error::Transport(t)) => {
            let body = json!({
                "type": "error",
                "error": { "type": "api_error", "message": format!("tanuki proxy: upstream unreachable ({t})") },
            })
            .to_string();
            let resp = tiny_http::Response::from_string(body)
                .with_status_code(502)
                .with_header(
                    tiny_http::Header::from_bytes(&b"content-type"[..], &b"application/json"[..])
                        .unwrap(),
                );
            let _ = request.respond(resp);
            return;
        }
    };

    let status = up_resp.status();
    let mut headers: Vec<tiny_http::Header> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in up_resp.headers_names() {
        let lower = name.to_ascii_lowercase();
        if !seen.insert(lower.clone()) {
            continue;
        }
        // hop-by-hop / framing headers: tiny_http re-frames the body itself.
        if matches!(
            lower.as_str(),
            "transfer-encoding" | "connection" | "content-length" | "keep-alive"
        ) {
            continue;
        }
        for v in up_resp.all(&name) {
            if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), v.as_bytes()) {
                headers.push(h);
            }
        }
    }

    let reader = up_resp.into_reader();
    if is_messages {
        // tee the stream: bytes go to the client untouched, a copy feeds
        // the usage scrape for the savings log.
        let buf = Arc::new(Mutex::new(Vec::new()));
        let tee = Tee {
            inner: reader,
            buf: Arc::clone(&buf),
        };
        let _ = request.respond(tiny_http::Response::new(
            tiny_http::StatusCode(status),
            headers,
            tee,
            None,
            None,
        ));
        let text = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
        let (input, cache_read, cache_create, output) = scrape_usage(&text);
        let actual = input + cache_read + cache_create;
        let caching_seen = {
            let mut guard = session.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if cache_read > 0 || cache_create > 0 {
                guard.caching_seen = true;
            }
            guard.caching_seen
        };
        log_event(&json!({
            "ts": now_ms(),
            "tool": "proxy",
            "compressed": tstats.is_some(),
            "orig_chars": tstats.as_ref().map_or(0, |s| s.orig_chars),
            "image_count": tstats.as_ref().map_or(0, |s| s.image_count),
            // baseline names its denominator: what Anthropic billed plus
            // what the imaged blocks would have added as text (estimate).
            "baseline_tokens": actual as i64 + tstats.as_ref().map_or(0, |s| s.saved_tokens),
            // the same estimate with the session's observed cache state
            // priced in (replays at the cache-read rate, first flips
            // charged the cache-write premium). Can be negative.
            "saved_tokens_cache_aware": tstats.as_ref().map_or(0, |s| s.saved_tokens_cache_aware),
            "caching_seen": caching_seen,
            "input_tokens": input,
            "cache_read_tokens": cache_read,
            "cache_create_tokens": cache_create,
            "output_tokens": output,
        }));
    } else {
        let _ = request.respond(tiny_http::Response::new(
            tiny_http::StatusCode(status),
            headers,
            reader,
            None,
            None,
        ));
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bind 127.0.0.1:port (0 = OS-assigned) and print the startup banner.
pub fn bind(cfg: &ProxyCfg) -> tiny_http::Server {
    let server = match tiny_http::Server::http(("127.0.0.1", cfg.port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tanuki proxy: bind failed ({e})");
            std::process::exit(1);
        }
    };
    let port = bound_port(&server);
    let knobs = format!(
        "level={} distill={} codebook={} font={} recency={} minChars={} ratio={} minSave={}",
        cfg.level,
        cfg.distill,
        cfg.codebook,
        if cfg.font == Font::Tiny { "tiny" } else { "normal" },
        cfg.recency_window,
        cfg.min_chars,
        cfg.ratio,
        cfg.min_save,
    );
    eprint!(
        "tanuki-context proxy on http://127.0.0.1:{port} -> {}\n  {knobs}\n  rules: system prompt & tools untouched \u{b7} in-place blocks only \u{b7} last {} message(s) kept as text \u{b7} secrets never imaged \u{b7} cache_control skipped \u{b7} identical blocks imaged once\n  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:{port}\n",
        cfg.upstream,
        cfg.recency_window.max(1),
    );
    server
}

pub fn bound_port(server: &tiny_http::Server) -> u16 {
    server.server_addr().to_ip().map_or(0, |a| a.port())
}

/// Accept loop; a thread per request so a long SSE stream never blocks others.
pub fn serve(server: tiny_http::Server, cfg: ProxyCfg) {
    let cfg = Arc::new(cfg);
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    // one ledger session per proxy process: replay detection + cache evidence
    let session = Arc::new(Mutex::new(ProxySession::new()));
    for request in server.incoming_requests() {
        let cfg = Arc::clone(&cfg);
        let agent = agent.clone();
        let session = Arc::clone(&session);
        std::thread::spawn(move || handle(request, &cfg, &agent, &session));
    }
}

pub fn run(cfg: ProxyCfg) {
    let server = bind(&cfg);
    serve(server, cfg);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big() -> String {
        (0..300)
            .map(|i| {
                format!(
                    "2026-07-26T02:{:02}:00Z INFO worker-{} copied /srv/data/prod/batch/segment_{:05}.parquet ok",
                    i % 60,
                    i % 5,
                    i
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn cfg() -> ProxyCfg {
        ProxyCfg {
            port: 0,
            upstream: "http://127.0.0.1:1".to_string(),
            ..ProxyCfg::default()
        }
    }

    fn msg(role: &str, content: Value) -> Value {
        json!({ "role": role, "content": content })
    }

    /// The exact marker the level-0/no-codebook pipeline must emit for `text`.
    fn expected_marker(text: &str) -> String {
        let r = render::render_text(text, true, true, Font::Normal);
        let chars = text.chars().count();
        let raw_tok = ((chars as f64) / 4.0).round() as u64;
        format!(
            "[tanuki-context: {chars} chars imaged in place as {} PNG page(s), ~{} vs ~{raw_tok} text tokens. \u{21b5}=newline \u{2192}=tab \u{21e5}N=indent]",
            r.pages.len(),
            r.tokens,
        )
    }

    #[test]
    fn oversized_user_text_block_imaged_in_place() {
        let b = big();
        let body = json!({
            "system": "SYSTEM PROMPT",
            "messages": [
                msg("user", json!([
                    { "type": "text", "text": "before" },
                    { "type": "text", "text": b },
                    { "type": "text", "text": "after" },
                ])),
                msg("assistant", json!("ok")),
                msg("user", json!("latest question")),
            ],
        })
        .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("oversized block must transform");
        let out: Value = serde_json::from_str(&r.body).unwrap();

        assert_eq!(out["system"], "SYSTEM PROMPT"); // rule 1
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(c[0]["text"], "before"); // position preserved
        assert_eq!(c[1]["type"], "text");
        assert_eq!(c[1]["text"], expected_marker(&b)); // overt marker, byte-exact
        let imgs: Vec<&Value> = c.iter().filter(|b| b["type"] == "image").collect();
        assert!(!imgs.is_empty());
        assert_eq!(imgs[0]["source"]["media_type"], "image/png");
        let png = base64::engine::general_purpose::STANDARD
            .decode(imgs[0]["source"]["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(c.last().unwrap()["text"], "after"); // trailing block still there

        assert_eq!(out["messages"][1]["content"], "ok"); // assistant untouched
        assert_eq!(out["messages"][2]["content"], "latest question"); // rule 3
        assert!(r.saved_tokens > 300);
    }

    #[test]
    fn latest_message_never_imaged() {
        let body = json!({ "messages": [msg("user", json!(big()))] }).to_string();
        assert!(transform_request_body(&body, &cfg(), None).is_none());
    }

    #[test]
    fn cache_control_blocks_untouched() {
        let body = json!({ "messages": [
            msg("user", json!([{ "type": "text", "text": big(), "cache_control": { "type": "ephemeral" } }])),
            msg("user", json!("latest")),
        ] })
        .to_string();
        assert!(transform_request_body(&body, &cfg(), None).is_none()); // rule 4
    }

    #[test]
    fn small_and_non_message_bodies_pass_through() {
        let small = json!({ "messages": [msg("user", json!("just a short note")), msg("user", json!("x"))] });
        assert!(transform_request_body(&small.to_string(), &cfg(), None).is_none());
        assert!(transform_request_body(r#"{"model":"m"}"#, &cfg(), None).is_none());
        assert!(transform_request_body("not json", &cfg(), None).is_none());
    }

    #[test]
    fn tool_result_text_imaged_inside_block() {
        let body = json!({ "messages": [
            msg("user", json!([{ "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": big() }] }])),
            msg("user", json!("latest")),
        ] })
        .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("tool_result must transform");
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(c[0]["type"], "tool_result");
        assert_eq!(c[0]["tool_use_id"], "t1");
        let inner = c[0]["content"].as_array().unwrap();
        assert!(inner[0]["text"].as_str().unwrap().starts_with("[tanuki-context:"));
        assert!(inner.iter().any(|b| b["type"] == "image"));
    }

    #[test]
    fn string_user_content_becomes_marker_plus_pages() {
        let b = big();
        let body = json!({ "messages": [msg("user", json!(b)), msg("user", json!("latest"))] })
            .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("string content must transform");
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(c[0]["text"], expected_marker(&b));
        assert_eq!(out["messages"][1]["content"], "latest");
    }

    /// The exact dedupe marker for a repeat of `text` first imaged as `pages` pages.
    fn expected_dupe_marker(text: &str, pages: usize) -> String {
        format!(
            "[tanuki-context: {} chars, byte-identical to a block imaged above ({pages} PNG page(s)); not repeated]",
            text.chars().count(),
        )
    }

    #[test]
    fn byte_identical_repeat_becomes_marker_without_images() {
        let b = big();
        let body = json!({ "messages": [
            msg("user", json!([{ "type": "text", "text": b }])),
            msg("assistant", json!("ok")),
            msg("user", json!(b)),
            msg("user", json!("latest")),
        ] })
        .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("dupe request must transform");
        let out: Value = serde_json::from_str(&r.body).unwrap();

        // first occurrence: normal marker + PNG pages
        let first = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(first[0]["text"], expected_marker(&b));
        let pages = first.iter().filter(|x| x["type"] == "image").count();
        assert!(pages > 0);

        // repeat: exactly one text block, byte-exact dupe marker, zero images
        let dupe = out["messages"][2]["content"].as_array().unwrap();
        assert_eq!(dupe.len(), 1);
        assert_eq!(dupe[0]["type"], "text");
        assert_eq!(dupe[0]["text"], expected_dupe_marker(&b, pages));
        assert!(dupe[0]["text"]
            .as_str()
            .unwrap()
            .contains("byte-identical to a block imaged above"));

        // accounting: dupe counts as a block + chars, adds no images, and
        // saves round(chars/4) - round(marker_chars/4)
        let chars = b.chars().count();
        let tok = |c: usize| ((c as f64) / 4.0).round() as i64;
        let imaged = render::render_text(&b, true, true, Font::Normal);
        assert_eq!(r.imaged_blocks, 2);
        assert_eq!(r.image_count, pages as u64);
        assert_eq!(r.orig_chars, 2 * chars as u64);
        let dupe_marker = expected_dupe_marker(&b, pages);
        assert_eq!(
            r.saved_tokens,
            (tok(chars) - imaged.tokens as i64) + (tok(chars) - tok(dupe_marker.chars().count()))
        );
    }

    #[test]
    fn one_byte_difference_defeats_dedupe() {
        let b = big();
        let b2 = b.replacen('2', "3", 1); // same length, one byte off
        assert_ne!(b, b2);
        let body = json!({ "messages": [
            msg("user", json!(b)),
            msg("user", json!(b2)),
            msg("user", json!("latest")),
        ] })
        .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("both blocks must transform");
        let out: Value = serde_json::from_str(&r.body).unwrap();
        for i in 0..2 {
            let c = out["messages"][i]["content"].as_array().unwrap();
            let head = c[0]["text"].as_str().unwrap();
            assert!(head.starts_with("[tanuki-context:"));
            assert!(!head.contains("byte-identical"));
            assert!(c.iter().any(|x| x["type"] == "image"));
        }
        let pages = |t: &str| render::render_text(t, true, true, Font::Normal).pages.len() as u64;
        assert_eq!(r.imaged_blocks, 2);
        assert_eq!(r.image_count, pages(&b) + pages(&b2));
    }

    #[test]
    fn wire_roundtrip_with_mock_upstream() {
        use std::io::{Read as _, Write as _};

        // one-shot mock upstream on an OS-assigned port
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = listener.local_addr().unwrap().port();
        let captured: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let cap = Arc::clone(&captured);
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            let body_start = loop {
                let n = sock.read(&mut tmp).unwrap();
                assert!(n > 0, "upstream socket closed early");
                buf.extend_from_slice(&tmp[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..body_start]).to_ascii_lowercase();
            let cl: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap();
            while buf.len() < body_start + cl {
                let n = sock.read(&mut tmp).unwrap();
                buf.extend_from_slice(&tmp[..n]);
            }
            *cap.lock().unwrap() =
                String::from_utf8_lossy(&buf[body_start..body_start + cl]).into_owned();
            let body = r#"{"id":"msg_1","usage":{"input_tokens":111,"cache_read_input_tokens":22,"cache_creation_input_tokens":3,"output_tokens":9}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-upstream: mock\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len(),
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let events = std::env::temp_dir().join(format!("tanuki-proxy-test-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&events);
        std::env::set_var("TANUKI_EVENTS", &events);

        let cfg = ProxyCfg {
            port: 0,
            upstream: format!("http://127.0.0.1:{up_port}"),
            ..ProxyCfg::default()
        };
        let server = bind(&cfg);
        let port = bound_port(&server);
        std::thread::spawn(move || serve(server, cfg));

        let b = big();
        let body = json!({ "model": "m", "messages": [msg("user", json!(b)), msg("user", json!("latest"))] })
            .to_string();
        let resp = ureq::AgentBuilder::new()
            .build()
            .post(&format!("http://127.0.0.1:{port}/v1/messages"))
            .set("content-type", "application/json")
            .set("x-api-key", "sk-test")
            .send_string(&body)
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.header("x-upstream"), Some("mock")); // response passthrough
        let mut reply = String::new();
        resp.into_reader().read_to_string(&mut reply).unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["id"], "msg_1");

        // upstream saw the transformed body, latest message untouched
        let fwd: Value = serde_json::from_str(&captured.lock().unwrap()).unwrap();
        let c = fwd["messages"][0]["content"].as_array().unwrap();
        assert!(c[0]["text"].as_str().unwrap().starts_with("[tanuki-context:"));
        assert!(c.iter().any(|b| b["type"] == "image"));
        assert_eq!(fwd["messages"][1]["content"], "latest");

        // savings row lands after the response is fully streamed; poll briefly.
        let last = (0..100)
            .find_map(|_| {
                std::thread::sleep(std::time::Duration::from_millis(20));
                let rows = std::fs::read_to_string(&events).ok()?;
                let line = rows.trim().lines().last()?.to_string();
                serde_json::from_str::<Value>(&line).ok()
            })
            .expect("events row written");
        assert_eq!(last["tool"], "proxy");
        assert_eq!(last["compressed"], true);
        assert_eq!(last["input_tokens"], 111);
        assert_eq!(last["cache_read_tokens"], 22);
        assert_eq!(last["cache_create_tokens"], 3);
        assert_eq!(last["output_tokens"], 9);
        assert!(last["baseline_tokens"].as_i64().unwrap() > 136); // actual + saved estimate
    }
}
