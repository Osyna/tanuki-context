//! Implicit mode: a local Anthropic middlebox, the pxpipe deployment shape
//! without pxpipe's structural flaw. Rules that keep it injection-shaped-free:
//!
//!   1. The system prompt and tool definitions are NEVER touched.
//!   2. Nothing moves between roles or positions: an oversized text block is
//!      replaced IN PLACE by a short overt marker + PNG page blocks, in the
//!      same user-role message (Anthropic allows image blocks in user content
//!      and inside tool_result content).
//!   3. The latest message is never imaged (the model may need to quote it).
//!   4. Blocks carrying cache_control are never imaged (rewriting would
//!      defeat the cache they exist for).
//!   5. Imaging only happens when `estimate` says it wins by a clear margin;
//!      everything else passes through byte-for-byte.
//!   7. Lossless first: a pretty-printed JSON tool result loses the
//!      whitespace between its tokens (strings byte-exact) in EVERY message,
//!      recent or not, breakpoint or not - deterministic and idempotent, so
//!      the API cache never sees the block change (mirror of proxy.ts).
//!   8. Byte splicing, not re-serialising: the request is scanned once for the
//!      spans of the values that change (a minified string, an imaged block's
//!      replacement, an added `cache_control`) and only those spans are
//!      substituted. Key order, whitespace, number spellings, system and tools
//!      stay the client's own bytes, so no number is ever re-printed.
//!   9. Automatic cache breakpoint (opt-in: `--auto-cache` / TANUKI_AUTO_CACHE=on,
//!      never with `--no-cache`; not measured against the live API, so off by
//!      default): once a session has sent two requests in a row whose earlier
//!      messages matched the previous request, and the client placed no
//!      `cache_control` on any message, one ephemeral breakpoint goes on the
//!      last block before the recency window (never a 5th: Anthropic 400s on it).
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
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};

/// Below this a pretty-printed JSON block is not worth a rewrite.
const JSON_MIN_CHARS: usize = 200;

/// Whitespace-only JSON minify (mirror of serde.ts minifyJson): the trimmed
/// text must parse as one JSON object or array; ASCII whitespace between
/// tokens goes, every byte inside a string stays. None when it is not JSON,
/// shorter than JSON_MIN_CHARS, or saves under 10 % of the chars.
pub(crate) fn minify_json(text: &str) -> Option<String> {
    let t = text.trim();
    if !(t.starts_with('{') || t.starts_with('[')) || text.chars().count() < JSON_MIN_CHARS {
        return None;
    }
    serde_json::from_str::<Value>(t).ok()?;
    let b = t.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let (mut in_str, mut esc) = (false, false);
    for &c in b {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if matches!(c, b' ' | b'\t' | b'\n' | b'\r') {
            continue;
        }
        out.push(c);
    }
    let out = String::from_utf8(out).ok()?;
    if out.chars().count() * 10 > text.chars().count() * 9 {
        return None;
    }
    Some(out)
}

/// F4: classify cache break kind. Exported for unit tests. Pure append -> None (cache intact).
pub(crate) fn attribute_break(
    prev: &[String],
    cur: &[String],
) -> Option<(usize, String)> {
    // Pure append OR identical: previous is a (possibly complete) prefix of
    // current, so the cached prefix is intact. `>=` matters: two identical
    // consecutive requests fell through both prefix checks and came back as a
    // bogus "modified" at index len (the TS engine lied, this one panicked).
    if cur.len() >= prev.len() && prev.iter().zip(cur.iter()).all(|(p, c)| p == c) {
        return None;
    }
    // Find first divergence
    let min_len = prev.len().min(cur.len());
    let mut i = 0;
    while i < min_len && prev[i] == cur[i] {
        i += 1;
    }
    // Current is proper prefix of previous -> evicted
    if i == cur.len() && cur.len() < prev.len() {
        return Some((i, "evicted".to_string()));
    }
    // Classify at divergence point
    let p_block = &prev[i];
    let c_block = &cur[i];
    let p_in_c = cur[i..].contains(p_block);
    let c_in_p = prev[i..].contains(c_block);
    
    if p_in_c && c_in_p {
        Some((i, "reordered".to_string()))
    } else if p_in_c {
        Some((i, "added".to_string()))
    } else if c_in_p {
        Some((i, "evicted".to_string()))
    } else {
        Some((i, "modified".to_string()))
    }
}
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
    pub cache: bool, // place a cache breakpoint on the last imaged message (default on)
    pub auto_cache: bool, // add one breakpoint before the recency window once the prefix holds (default off)
    pub verbatim: needles::Verbatim, // sidecar next to the pages: full · lazy pointer · off
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
            cache: true,
            auto_cache: false,
            verbatim: needles::Verbatim::Full,
        }
    }
}

struct ImagedBlock {
    blocks: Vec<Value>,
    /// the same blocks as compact JSON, exactly the bytes spliced into the request.
    json: Vec<String>,
    /// image tokens of the pages alone (0 for a pointer): the estimator's view of them.
    page_tok: u64,
    /// ledger key sha256(text); filled by the session memo, empty otherwise.
    text_hash: String,
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
    if text.len() < cfg.min_chars {
        return None; // cheap floor first: chars <= bytes
    }
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

    let raw_tok = crate::text_tokens(text);
    let r = render::render_text(&working, true, true, cfg.font);
    let side = crate::needles::scan_needles_sized(&working, orig_chars);
    // What the sidecar costs is what it ships. There is no stash on this path,
    // so a lazy pointer names no id: the caller sees the count and the tools,
    // not a fabricated sha.
    let side_tok = match cfg.verbatim {
        needles::Verbatim::Off => 0,
        needles::Verbatim::Lazy => crate::text_tokens(&needles::lazy_pointer(&side, None)),
        needles::Verbatim::Full => side.tokens,
    };
    let cost = r.tokens + side_tok;
    if r.pages.len() > cfg.max_pages {
        return None;
    }
    // Needle-dense: the sidecar cannot carry every exact string, and this is
    // the automatic path - leaving it as text is the only honest option.
    if side.dense && cfg.verbatim != needles::Verbatim::Off {
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
    if cfg.verbatim == needles::Verbatim::Full && !side.needles.is_empty() {
        marker.push_str(&format!(
            "; the \u{b7}verbatim\u{b7} block next carries {} exact strings as text - read ids from there, not from the pages",
            side.needles.len()
        ));
    }
    marker.push(']');

    let b64 = base64::engine::general_purpose::STANDARD;
    // Sidecar BEFORE the pages: exact strings first, bulk second.
    let mut blocks = Vec::with_capacity(2 + r.pages.len());
    let mut jsons = Vec::with_capacity(2 + r.pages.len());
    jsons.push(text_block_json(&marker));
    blocks.push(json!({ "type": "text", "text": marker }));
    if cfg.verbatim != needles::Verbatim::Off && !side.text.is_empty() {
        let block = if cfg.verbatim == needles::Verbatim::Lazy {
            needles::lazy_pointer(&side, None)
        } else {
            side.text.clone()
        };
        jsons.push(text_block_json(&block));
        blocks.push(json!({ "type": "text", "text": block }));
    }
    for p in &r.pages {
        let data = b64.encode(&p.png);
        jsons.push(image_block_json(&data));
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": data },
        }));
    }
    Some(ImagedBlock {
        blocks,
        json: jsons,
        page_tok: r.tokens,
        text_hash: String::new(),
        orig_chars,
        pages: r.pages.len(),
        saved_tokens: saved,
        raw_tok,
        cost_tok: cost,
    })
}

/// Volatile prompt shapes, same patterns as distill.rs's masks (F4). The
/// headroom CacheAligner insight: a uuid/timestamp/jwt in the SYSTEM prompt
/// means the client busts its own prefix cache on every new session.
static M_UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static M_TS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?").unwrap()
});
static M_JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.").unwrap()
});

pub struct CacheBreak {
    pub index: usize,
    pub kind: String,
    pub rebilled: u64,
}

pub struct ToolTax {
    pub unused: Vec<String>,
    pub tokens: u64,
}

pub struct TransformResult {
    /// the original bytes with only the changed spans substituted when `changed`,
    /// else the caller must forward the original bytes.
    pub body: String,
    /// false = no block was imaged; result exists only for the diagnostics.
    pub changed: bool,
    #[allow(dead_code)] // part of the TS TransformResult shape; asserted in tests
    pub imaged_blocks: usize,
    /// tool_result texts whose JSON whitespace was dropped (rule 7).
    pub minified_blocks: usize,
    pub orig_chars: u64,
    pub image_count: u64,
    pub saved_tokens: i64,
    /// saved_tokens with the session's cache state priced in (can be negative:
    /// the first text->pages flip of a cached block is a real cost).
    pub saved_tokens_cache_aware: i64,
    /// whether a cache_control breakpoint was placed on the imaged prefix.
    pub cached: bool,
    /// whether the automatic breakpoint before the recency window was added.
    pub auto_cache: bool,
    /// the estimator's input tokens for the request as FORWARDED (T2b): text via
    /// text_tokens, tool definitions and tool inputs canonical, our pages at their
    /// render cost. Client-sent images and other opaque blocks count 0.
    pub est_tokens: u64,
    /// consecutive requests whose cache break sits in a message the proxy did not
    /// touch (0 = none); the caller logs it.
    pub client_break: usize,
    /// one-shot stderr warning text, set on the request that crosses the threshold.
    pub warn: Option<String>,
    // F4 diagnostics
    pub blocks: Vec<String>,
    pub cache_break: Option<CacheBreak>,
    pub tool_tax: Option<ToolTax>,
    pub volatile_system: bool,
}

/// Cross-request memory, LEDGER-ONLY by construction: it never changes the
/// emitted bytes (a cross-request rewrite would bust the client's prompt
/// cache). It exists so the savings log can price a replayed block at the
/// cache-read rate instead of pretending every avoided token was full-price
/// input — the counterfactual-accounting hole the rakuen post names.
pub struct ProxySession {
    /// sha256 of block texts imaged in EARLIER requests this session.
    ///
    /// Ledger-only is a decision, not an oversight. Swapping a block seen in an
    /// earlier request for a short pointer — the way an in-request repeat is
    /// swapped — looks like it would avoid re-imaging and re-caching those pages.
    /// It does the opposite. The same block sits at the same position in every
    /// later request of the conversation, so a pointer CHANGES THE PREFIX and
    /// invalidates the cache entry for everything from that block onward: the
    /// exact prefix the cache_control breakpoint exists to hold stable.
    /// Cross-request substitution does not avoid cache writes, it causes them.
    /// In-request dedupe is safe only because the pointer replaces a SECOND
    /// occurrence while the first still carries the pages. Guarded by the proxy
    /// test "session never changes the emitted bytes".
    pub seen_blocks: std::collections::HashSet<String>,
    /// a prior response showed cache traffic (cache_read/cache_creation > 0).
    pub caching_seen: bool,
    /// F4: the previous request's block hashes. Single-conversation assumption:
    /// Anthropic exposes no conversation id, so the proxy compares consecutive
    /// requests as-is; typical clients run one proxy per conversation.
    pub prev_blocks: Vec<String>,
    /// consecutive requests whose earlier messages matched the previous request
    /// (cache intact): the auto breakpoint waits for two.
    pub stable: usize,
    /// consecutive requests that broke the cache at a `modified` message the
    /// proxy did not touch, and whether the one-per-session warning was printed.
    pub client_breaks: usize,
    pub warned: bool,
    /// block text hash -> minify verdict, bounded like seen_blocks: a block is
    /// scanned and parsed once per session, not once per request (T1b).
    pub minify_memo: HashMap<String, Arc<MinifyMemo>>, // keyed by the block text itself
    pub memo_chars: usize,
    /// imaging is a pure function of (block text, config): the verdict is
    /// memoised per session like the minify one. Holds only immutable data.
    image_memo: HashMap<String, (String, Option<Arc<ImagedBlock>>)>, // text -> (config key, verdict)
    image_chars: usize,
}

impl ProxySession {
    pub fn new() -> Self {
        ProxySession {
            seen_blocks: std::collections::HashSet::new(),
            caching_seen: false,
            prev_blocks: Vec::new(),
            stable: 0,
            client_breaks: 0,
            warned: false,
            minify_memo: HashMap::new(),
            memo_chars: 0,
            image_memo: HashMap::new(),
            image_chars: 0,
        }
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

// ---------------------------------------------------------------- splicing
/// Where one JSON value sits in the ORIGINAL request text, plus the few
/// children the rewriter addresses (mirror of proxy.ts `Span`: byte offsets
/// here, UTF-16 indices there - the spliced text is the same either way).
struct Span {
    s: usize,
    e: usize,
    items: Option<Vec<Span>>,   // array elements
    content: Option<Box<Span>>, // member "content" (the root's "messages")
    text: Option<(usize, usize)>, // member "text"
    last: Option<usize>,        // end of the last member/element value
}

impl Span {
    fn at(s: usize) -> Span {
        Span { s, e: 0, items: None, content: None, text: None, last: None }
    }
}

fn ws_end(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\n' | b'\r' | b'\t') {
        i += 1;
    }
    i
}

/// End of the string literal opening at `i`.
fn str_end(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' => return Some(j + 1),
            _ => j += 1,
        }
    }
    None
}

/// End of any value starting at `i` (no allocation: system and tools go by here).
fn val_end(b: &[u8], mut i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => str_end(b, i),
        b'{' | b'[' => {
            let mut d = 0usize;
            loop {
                match *b.get(i)? {
                    b'"' => {
                        i = str_end(b, i)?;
                        continue;
                    }
                    b'{' | b'[' => d += 1,
                    b'}' | b']' => {
                        d -= 1;
                        if d == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
        }
        _ => {
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t') {
                i += 1;
            }
            Some(i)
        }
    }
}

fn key_at(b: &[u8], s: usize, e: usize) -> Option<std::borrow::Cow<'_, str>> {
    let raw = &b[s..e];
    if raw.contains(&b'\\') {
        serde_json::from_slice::<String>(raw).ok().map(std::borrow::Cow::Owned)
    } else {
        Some(String::from_utf8_lossy(&raw[1..raw.len() - 1]))
    }
}

/// Duplicate keys: the last one wins, exactly like serde_json and JSON.parse.
fn obj_span(b: &[u8], s: usize, root: bool) -> Option<Span> {
    let mut sp = Span::at(s);
    let mut i = ws_end(b, s + 1);
    if *b.get(i)? == b'}' {
        sp.e = i + 1;
        return Some(sp);
    }
    loop {
        let ke = str_end(b, i)?;
        let key = key_at(b, i, ke)?;
        i = ws_end(b, ws_end(b, ke) + 1);
        let end;
        if (root && key == "messages") || (!root && key == "content") {
            let v = val_span(b, i)?;
            end = v.e;
            sp.content = Some(Box::new(v));
        } else {
            end = val_end(b, i)?;
            if !root && key == "text" {
                sp.text = Some((i, end));
            }
        }
        sp.last = Some(end);
        i = ws_end(b, end);
        if *b.get(i)? == b',' {
            i = ws_end(b, i + 1);
            continue;
        }
        sp.e = i + 1;
        return Some(sp);
    }
}

fn arr_span(b: &[u8], s: usize) -> Option<Span> {
    let mut sp = Span::at(s);
    let mut items: Vec<Span> = Vec::new();
    let mut i = ws_end(b, s + 1);
    if *b.get(i)? == b']' {
        sp.e = i + 1;
        sp.items = Some(items);
        return Some(sp);
    }
    loop {
        let v = val_span(b, i)?;
        sp.last = Some(v.e);
        i = ws_end(b, v.e);
        items.push(v);
        if *b.get(i)? == b',' {
            i = ws_end(b, i + 1);
            continue;
        }
        sp.e = i + 1;
        sp.items = Some(items);
        return Some(sp);
    }
}

fn val_span(b: &[u8], i: usize) -> Option<Span> {
    match *b.get(i)? {
        b'{' => obj_span(b, i, false),
        b'[' => arr_span(b, i),
        _ => {
            let mut sp = Span::at(i);
            sp.e = val_end(b, i)?;
            Some(sp)
        }
    }
}

/// One span per element of the top-level "messages" array.
fn scan_messages(raw: &str) -> Option<Vec<Span>> {
    let b = raw.as_bytes();
    let at = ws_end(b, 0);
    if *b.get(at)? != b'{' {
        return None;
    }
    obj_span(b, at, true)?.content?.items
}

/// The array elements of a span that must be an array.
fn kids(sp: Option<&Span>) -> Option<&Vec<Span>> {
    sp?.items.as_ref()
}

/// A replacement of raw[s, e): `parts` joined by commas, wrapped in [] when a
/// string value becomes a block array. A zero-length one is an insertion.
struct Rep {
    e: usize,
    parts: Vec<String>,
    wrap: bool,
}

type Reps = BTreeMap<usize, Rep>;

fn put(reps: &mut Reps, s: usize, e: usize, parts: Vec<String>, wrap: bool) {
    reps.insert(s, Rep { e, parts, wrap });
}

const CC: &str = r#""cache_control":{"type":"ephemeral"}"#;

/// a generated `{...}` block gains the breakpoint as its last member.
fn with_cc(json: &str) -> String {
    format!("{},{CC}}}", &json[..json.len() - 1])
}

fn text_block_json(t: &str) -> String {
    format!(r#"{{"type":"text","text":{}}}"#, serde_json::to_string(t).unwrap_or_default())
}

fn image_block_json(b64: &str) -> String {
    format!(r#"{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{b64}"}}}}"#)
}

fn splice(raw: &str, reps: &Reps) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pos = 0usize;
    for (&s, r) in reps {
        if s < pos {
            continue; // nested inside a replacement already made
        }
        out.push_str(&raw[pos..s]);
        if r.wrap {
            out.push('[');
        }
        out.push_str(&r.parts.join(","));
        if r.wrap {
            out.push(']');
        }
        pos = r.e;
    }
    out.push_str(&raw[pos..]);
    out
}

/// Anthropic accepts at most 4 `cache_control` breakpoints per request and
/// 400s on a 5th, so count the ones the client already placed (system, tools,
/// message blocks and the text blocks inside a tool_result) before adding
/// ours. Fail-open: a request that worked without the proxy must still work
/// through it.
const MAX_BREAKPOINTS: usize = 4;

/// Opt-in (`--auto-cache` -> cfg.auto_cache, or TANUKI_AUTO_CACHE=on) and never
/// with `--no-cache`, which clears cfg.cache. Same rule as the proxy.ts transform.
fn auto_cache_on(cfg: &ProxyCfg) -> bool {
    cfg.cache && (cfg.auto_cache || std::env::var("TANUKI_AUTO_CACHE").as_deref() == Ok("on"))
}

/// `cache_control` members in a block array, a tool_result's own content included.
fn scan_breakpoints(v: &Value) -> usize {
    v.as_array().map_or(0, |a| {
        a.iter()
            .map(|b| {
                usize::from(b.get("cache_control").is_some())
                    + if b["type"] == "tool_result" { scan_breakpoints(&b["content"]) } else { 0 }
            })
            .sum()
    })
}

fn count_breakpoints(body: &Value) -> usize {
    let mut n = scan_breakpoints(&body["system"]) + scan_breakpoints(&body["tools"]);
    if let Some(ms) = body["messages"].as_array() {
        for m in ms {
            n += scan_breakpoints(&m["content"]);
        }
    }
    n
}

/// The client caches on its own: any message block already carries a breakpoint.
fn client_caches(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .is_some_and(|ms| ms.iter().any(|m| scan_breakpoints(&m["content"]) > 0))
}

/// Cheap upper bound before the parse in minify_json: one pass counting the
/// whitespace outside strings (plus what trim would take off the ends) and
/// skipping a document that cannot reach the 10 % saving. Conservative on
/// purpose (never skips what minify_json would rewrite); mirror of
/// proxy.ts couldMinify.
fn could_minify(text: &str) -> bool {
    let (mut in_str, mut esc, mut ws) = (false, false, 0usize);
    for &c in text.as_bytes() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
            ws += 1;
        }
    }
    let removed = ws + (text.len() - text.trim().len());
    removed * 10 >= text.chars().count()
}

/// The estimator's input tokens for a request body (T2b), see
/// TransformResult::est_tokens. `pre_tok` holds the token counts of minified
/// tool_result texts already known, keyed (message, block, item) with
/// usize::MAX for a string `content`.
fn estimate_tokens(body: &Value, pre_tok: &HashMap<(usize, usize, usize), u64>) -> u64 {
    let txt = |v: &Value| v.as_str().map_or(0, crate::text_tokens);
    let mut n = 0u64;
    match &body["system"] {
        Value::String(s) => n += crate::text_tokens(s),
        Value::Array(a) => {
            for b in a {
                n += txt(&b["text"]);
            }
        }
        _ => {}
    }
    if let Some(tools) = body["tools"].as_array() {
        for t in tools {
            n += crate::text_tokens(&table::canon_string(t));
        }
    }
    let Some(ms) = body["messages"].as_array() else {
        return n;
    };
    for (i, m) in ms.iter().enumerate() {
        if let Some(s) = m["content"].as_str() {
            n += crate::text_tokens(s);
            continue;
        }
        let Some(blocks) = m["content"].as_array() else {
            continue;
        };
        for (j, b) in blocks.iter().enumerate() {
            if !b.is_object() {
                continue;
            }
            match b["type"].as_str() {
                Some("text") => n += txt(&b["text"]),
                Some("thinking") => n += txt(&b["thinking"]),
                Some("tool_use") => {
                    n += txt(&b["name"]);
                    if let Some(input) = b.get("input") {
                        n += crate::text_tokens(&table::canon_string(input));
                    }
                }
                Some("tool_result") => {
                    if let Some(s) = b["content"].as_str() {
                        n += pre_tok.get(&(i, j, usize::MAX)).copied().unwrap_or_else(|| crate::text_tokens(s));
                    } else if let Some(items) = b["content"].as_array() {
                        for (k, it) in items.iter().enumerate() {
                            if it["type"].as_str() != Some("text") {
                                continue;
                            }
                            n += match pre_tok.get(&(i, j, k)) {
                                Some(&t) => t,
                                None => txt(&it["text"]),
                            };
                        }
                    }
                }
                _ => {}
            }
        }
    }
    n
}

/// One minify verdict, memoised per session by block hash (T1b). `min` None =
/// "leave it alone" (not JSON, too small, or under the 10 % saving).
pub struct MinifyMemo {
    min: Option<String>,
    enc: String, // JSON string literal of `min`: the bytes spliced in
    saved: i64,  // text_tokens(original) - text_tokens(min)
    min_tok: u64,
    /// ledger key sha256("json\0" + text), computed once per session, not per request.
    hash: String,
}

/// Everything one request's rewrite counts, threaded through the passes.
struct Ctx<'a> {
    cfg: &'a ProxyCfg,
    session: Option<&'a mut ProxySession>,
    rate: crate::cost::Rate,
    cfg_key: String,
    minify_off: bool,
    /// exact block text -> page count, for the in-request dedupe below.
    seen: HashMap<String, usize>,
    imaged_blocks: usize,
    orig_chars: u64,
    image_count: u64,
    page_tok: u64,
    saved_tokens: i64,
    saved_ca: i64,
    minified_blocks: usize,
}

impl Ctx<'_> {
    /// rule 7: lossless JSON minify of a tool result text, with the session memo.
    /// Ledger: the block was never sent pretty, so there is no flip - with cache
    /// traffic seen, the saving rides a cache write the first time and reads after.
    fn minify(&mut self, text: &str) -> Option<Arc<MinifyMemo>> {
        // O(1) rejects first: below the size floor, or not an object/array once trimmed.
        if self.minify_off || text.len() < JSON_MIN_CHARS {
            return None;
        }
        let t = text.trim();
        if !(t.starts_with('{') || t.starts_with('[')) {
            return None;
        }
        // keyed by the text itself: an exact match, and a hash-table probe is far
        // cheaper than a sha256 of every block on every request
        let cached = self.session.as_deref().and_then(|s| s.minify_memo.get(text).cloned());
        let memo = match cached {
            Some(m) => m,
            None => {
                let m = if could_minify(text) { minify_json(text) } else { None };
                let hash = crate::sha256::hex(format!("json\u{0}{text}").as_bytes());
                let memo = Arc::new(match m {
                    None => MinifyMemo { min: None, enc: String::new(), saved: 0, min_tok: 0, hash },
                    Some(m) => {
                        let min_tok = crate::text_tokens(&m);
                        MinifyMemo {
                            saved: crate::text_tokens(text) as i64 - min_tok as i64,
                            enc: serde_json::to_string(&m).unwrap_or_default(),
                            min: Some(m),
                            min_tok,
                            hash,
                        }
                    }
                });
                if let Some(s) = self.session.as_deref_mut() {
                    // ponytail: bounded like seen_blocks; a full memo restarts
                    // empty (pure cache, never changes the bytes), 32M chars
                    // caps the memory.
                    if s.minify_memo.len() >= 1024 || s.memo_chars > 32_000_000 {
                        s.minify_memo.clear();
                        s.memo_chars = 0;
                    }
                    s.minify_memo.insert(text.to_string(), Arc::clone(&memo));
                    s.memo_chars += text.len();
                }
                memo
            }
        };
        memo.min.as_ref()?;
        let hash = &memo.hash;
        self.minified_blocks += 1;
        self.saved_tokens += memo.saved;
        let (replayed, caching_seen) = match self.session.as_deref() {
            Some(s) => (s.seen_blocks.contains(hash), s.caching_seen),
            None => (false, false),
        };
        self.saved_ca += if !caching_seen {
            memo.saved
        } else {
            crate::cost::rnd(
                memo.saved as f64 * if replayed { self.rate.cache_read_mult } else { self.rate.cache_write_mult },
            )
        };
        if let Some(s) = self.session.as_deref_mut() {
            if !replayed {
                if s.seen_blocks.len() >= 1024 {
                    s.seen_blocks.clear();
                }
                s.seen_blocks.insert(hash.clone());
            }
        }
        Some(memo)
    }

    /// Imaging is a pure function of (block text, config) and rendering pages is
    /// the expensive step: the verdict (None = "text stays cheaper" included) is
    /// memoised per session like the minify one.
    fn memo_image(&mut self, text: &str) -> Option<Arc<ImagedBlock>> {
        let cfg = self.cfg;
        if text.len() < cfg.min_chars || self.session.is_none() {
            return maybe_image(text, cfg).map(Arc::new);
        }
        if let Some((_, hit)) = self
            .session
            .as_deref()
            .and_then(|s| s.image_memo.get(text))
            .filter(|(k, _)| *k == self.cfg_key)
        {
            return hit.clone();
        }
        let done = maybe_image(text, cfg).map(|mut d| {
            d.text_hash = crate::sha256::hex(text.as_bytes());
            Arc::new(d)
        });
        if let Some(s) = self.session.as_deref_mut() {
            // ponytail: bounded like the minify memo; a full one restarts empty
            if s.image_memo.len() >= 512 || s.image_chars > 64_000_000 {
                s.image_memo.clear();
                s.image_chars = 0;
            }
            s.image_chars += text.len() + done.as_ref().map_or(0, |d| d.json.iter().map(String::len).sum::<usize>());
            s.image_memo.insert(text.to_string(), (self.cfg_key.clone(), done.clone()));
        }
        done
    }

    /// Exact-repeat dedupe + imaging + ledger for one text block. A byte-identical
    /// block already imaged in THIS request becomes one short marker, no repeated
    /// pages. Deliberately in-request only - see the ProxySession comment for why
    /// the cross-request version is a cache pessimisation, not an optimisation.
    fn image_block(&mut self, text: &str) -> Option<Arc<ImagedBlock>> {
        let done: Arc<ImagedBlock> = if let Some(&pages) = self.seen.get(text) {
            let chars = text.chars().count();
            let marker = format!(
                "[tanuki-context: {chars} chars, byte-identical to a block imaged above ({pages} PNG page(s)); not repeated]"
            );
            let raw_tok = crate::text_tokens(text);
            let cost_tok = crate::text_tokens(&marker);
            Arc::new(ImagedBlock {
                json: vec![text_block_json(&marker)],
                blocks: vec![json!({ "type": "text", "text": marker })],
                page_tok: 0,
                text_hash: String::new(),
                orig_chars: chars,
                pages: 0,
                saved_tokens: raw_tok as i64 - cost_tok as i64,
                raw_tok,
                cost_tok,
            })
        } else {
            let done = self.memo_image(text)?;
            self.seen.insert(text.to_string(), done.pages);
            done
        };
        self.imaged_blocks += 1;
        self.orig_chars += done.orig_chars as u64;
        self.image_count += done.pages as u64;
        self.page_tok += done.page_tok;
        self.saved_tokens += done.saved_tokens;
        // ledger only, never bytes: was this exact block imaged in an earlier
        // request of this session?
        let hash = if done.text_hash.is_empty() {
            crate::sha256::hex(text.as_bytes())
        } else {
            done.text_hash.clone()
        };
        let (replayed, caching_seen) = match self.session.as_deref() {
            Some(s) => (s.seen_blocks.contains(&hash), s.caching_seen),
            None => (false, false),
        };
        self.saved_ca += cache_aware_saved(
            done.raw_tok,
            done.cost_tok,
            replayed,
            caching_seen,
            self.rate.cache_read_mult,
            self.rate.cache_write_mult,
        );
        if let Some(s) = self.session.as_deref_mut() {
            if !replayed {
                // ponytail: bounded memory - at 1024 entries start a fresh window;
                // old blocks then re-count as first flips, which only UNDERSTATES
                // savings. Mirrored exactly in the TS engine.
                if s.seen_blocks.len() >= 1024 {
                    s.seen_blocks.clear();
                }
                s.seen_blocks.insert(hash);
            }
        }
        Some(done)
    }
}

/// Breakpoint on message `idx`: the last block of its content. The bytes go in
/// as a splice: onto a generated block's JSON, or as one more member of the
/// client's own block. The tree is not touched (generated blocks are shared with
/// the image memo); `placed` counts what we added. Mirror of proxy.ts `place`.
fn place(
    idx: usize,
    auto: bool,
    raw: &str,
    body: &Value,
    spans: &[Span],
    reps: &mut Reps,
    placed: &mut HashSet<usize>,
) -> Option<bool> {
    let m = &body["messages"][idx];
    if !m.is_object() {
        return Some(false);
    }
    let cs = spans[idx].content.as_deref()?;
    if let Some(s) = m["content"].as_str() {
        // only the automatic breakpoint reaches a plain string: the same literal
        // becomes the one text block that can carry it
        if !auto || s.is_empty() {
            return Some(false);
        }
        put(reps, cs.s, cs.e, vec![format!(r#"{{"type":"text","text":{},{CC}}}"#, &raw[cs.s..cs.e])], true);
        placed.insert(idx);
        return Some(true);
    }
    let arr = m["content"].as_array()?;
    let Some(tail) = arr.last() else {
        return Some(false);
    };
    if !tail.is_object() || tail.get("cache_control").is_some() || placed.contains(&idx) {
        return Some(false);
    }
    // thinking blocks and empty text cannot carry one; Anthropic 400s on it
    let ty = tail["type"].as_str();
    if auto
        && (ty == Some("thinking")
            || ty == Some("redacted_thinking")
            || (ty == Some("text") && tail["text"].as_str() == Some("")))
    {
        return Some(false);
    }
    match &cs.items {
        None => {
            // a string imaged into an array: the breakpoint rides its last block
            let r = reps.get_mut(&cs.s)?;
            let last = r.parts.last_mut()?;
            *last = with_cc(last);
        }
        Some(items) => {
            let orig = items.last()?;
            if reps.get(&orig.s).is_some_and(|r| r.e == orig.e) {
                let r = reps.get_mut(&orig.s)?;
                let last = r.parts.last_mut()?;
                *last = with_cc(last);
            } else {
                match orig.last {
                    None => put(reps, orig.s + 1, orig.s + 1, vec![CC.to_string()], false),
                    Some(l) => put(reps, l, l, vec![format!(",{CC}")], false),
                }
            }
        }
    }
    placed.insert(idx);
    Some(true)
}

/// Rewrite a /v1/messages body. None = not a messages request (the caller
/// forwards the original bytes untouched, and so on any internal failure).
pub fn transform_request_body(
    raw: &str,
    cfg: &ProxyCfg,
    session: Option<&mut ProxySession>,
) -> Option<TransformResult> {
    let mut body: Value = serde_json::from_str(raw).ok()?;
    let msg_count = body.get("messages")?.as_array()?.len();
    // Spans of the values the rewrite may replace, in the ORIGINAL bytes. The
    // parsed tree below is still edited in step (diagnostics hash what the API
    // will see), but it is never printed: the output is `raw` with `reps` applied.
    let spans = scan_messages(raw)?;
    if spans.len() != msg_count {
        return None;
    }
    let client_cc = client_caches(&body);
    let mut ctx = Ctx {
        cfg,
        session,
        // provider ratios for the cache-aware ledger, from the request's own model
        rate: crate::cost::resolve_rate(body.get("model").and_then(|m| m.as_str())).1,
        cfg_key: format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}",
            cfg.level,
            cfg.distill,
            cfg.table,
            cfg.codebook,
            cfg.font == Font::Tiny,
            cfg.min_chars,
            cfg.ratio,
            cfg.min_save,
            cfg.max_pages,
            cfg.verbatim
        ),
        minify_off: std::env::var("TANUKI_MINIFY").as_deref() == Ok("off"),
        seen: HashMap::new(),
        imaged_blocks: 0,
        orig_chars: 0,
        image_count: 0,
        page_tok: 0,
        saved_tokens: 0,
        saved_ca: 0,
        minified_blocks: 0,
    };
    let mut reps: Reps = BTreeMap::new();
    let mut touched: HashSet<usize> = HashSet::new(); // messages the proxy rewrote (T8b)
    let mut pre_tok: HashMap<(usize, usize, usize), u64> = HashMap::new();
    // index of the last message we imaged into; where the cache breakpoint goes
    let mut last_imaged_msg: i64 = -1;

    // rule 7: lossless JSON minify of tool results, everywhere, before imaging.
    {
        let messages = body["messages"].as_array_mut()?;
        for (i, m) in messages.iter_mut().enumerate() {
            let Some(content) = m.get_mut("content").and_then(|c| c.as_array_mut()) else {
                continue;
            };
            let bspans = kids(spans[i].content.as_deref())?;
            for (j, block) in content.iter_mut().enumerate() {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let bs = &bspans[j];
                if let Some(text) = block["content"].as_str() {
                    if let Some(memo) = ctx.minify(text) {
                        let cs = bs.content.as_deref()?;
                        put(&mut reps, cs.s, cs.e, vec![memo.enc.clone()], false);
                        pre_tok.insert((i, j, usize::MAX), memo.min_tok);
                        block["content"] = Value::String(memo.min.clone()?);
                        touched.insert(i);
                    }
                } else if block["content"].is_array() {
                    let ispans = kids(bs.content.as_deref())?;
                    let items = block["content"].as_array_mut()?;
                    for (k, item) in items.iter_mut().enumerate() {
                        if item.get("type").and_then(|t| t.as_str()) != Some("text") {
                            continue;
                        }
                        if let Some(text) = item["text"].as_str() {
                            if let Some(memo) = ctx.minify(text) {
                                let (ts, te) = ispans[k].text?;
                                put(&mut reps, ts, te, vec![memo.enc.clone()], false);
                                pre_tok.insert((i, j, k), memo.min_tok);
                                item["text"] = Value::String(memo.min.clone()?);
                                touched.insert(i);
                            }
                        }
                    }
                }
            }
        }
    }

    // rule 3: keep the latest recency_window message(s) as text (VIST slow-fast:
    // recent turns reasoned over precisely, distant bulk imaged). Default 1.
    let keep = cfg.recency_window.max(1);
    {
        let messages = body["messages"].as_array_mut()?;
        for (i, m) in messages.iter_mut().enumerate().take(msg_count.saturating_sub(keep)) {
            // Anthropic accepts image blocks only in user-role content.
            if m["role"].as_str() != Some("user") {
                continue;
            }
            let ms = &spans[i];
            if let Some(text) = m["content"].as_str() {
                if let Some(done) = ctx.image_block(text) {
                    let cs = ms.content.as_deref()?;
                    put(&mut reps, cs.s, cs.e, done.json.clone(), true);
                    m["content"] = Value::Array(done.blocks.clone());
                    touched.insert(i);
                    last_imaged_msg = i as i64;
                }
                continue;
            }
            let Some(content) = m["content"].as_array_mut() else {
                continue;
            };
            let bspans = kids(ms.content.as_deref())?;
            let before = ctx.imaged_blocks;
            let mut out: Vec<Value> = Vec::with_capacity(content.len());
            for (j, mut block) in content.drain(..).enumerate() {
                if !block.is_object() || block.get("cache_control").is_some() {
                    out.push(block); // rule 4
                    continue;
                }
                if block["type"] == "text" {
                    if let Some(text) = block["text"].as_str() {
                        if let Some(done) = ctx.image_block(text) {
                            put(&mut reps, bspans[j].s, bspans[j].e, done.json.clone(), false);
                            out.extend(done.blocks.iter().cloned());
                            continue;
                        }
                    }
                    out.push(block);
                    continue;
                }
                if block["type"] == "tool_result" {
                    if block["content"].is_string() {
                        let done = ctx.image_block(block["content"].as_str()?);
                        if let Some(done) = done {
                            let cs = bspans[j].content.as_deref()?;
                            put(&mut reps, cs.s, cs.e, done.json.clone(), true);
                            block["content"] = Value::Array(done.blocks.clone());
                        }
                    } else if block["content"].is_array() {
                        let ispans = kids(bspans[j].content.as_deref())?;
                        let items = block["content"].as_array_mut()?;
                        let mut inner: Vec<Value> = Vec::with_capacity(items.len());
                        for (k, item) in items.drain(..).enumerate() {
                            if item["type"] == "text" && item.get("cache_control").is_none() {
                                if let Some(text) = item["text"].as_str() {
                                    if let Some(done) = ctx.image_block(text) {
                                        put(&mut reps, ispans[k].s, ispans[k].e, done.json.clone(), false);
                                        inner.extend(done.blocks.iter().cloned());
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
            if ctx.imaged_blocks > before {
                last_imaged_msg = i as i64;
                touched.insert(i);
            }
        }
    }

    let Ctx {
        session,
        imaged_blocks,
        orig_chars,
        image_count,
        page_tok,
        saved_tokens,
        saved_ca: saved_tokens_cache_aware,
        minified_blocks,
        ..
    } = ctx;
    let mut session = session;

    // F4 diagnostics run on EVERY parseable request, transform or not: a cache
    // break is most often caused by a request the proxy left alone. Hashes are
    // taken AFTER imaging (these are the bytes the API cache sees) but BEFORE
    // our own cache_control placement below - the breakpoint moves forward as
    // later content gets imaged, and hashing it would forge a false "modified"
    // attribution at the old holder on every advance.
    let mut blocks: Vec<String> = Vec::new();
    // Per-block text-token cost, aligned with `blocks`: string-content
    // messages count whole, typed blocks count only when type == "text".
    let mut block_tokens: Vec<u64> = Vec::new();
    let mut flat_msg: Vec<usize> = Vec::new(); // message index of every hashed block (T8b)
    let mut flat_type: Vec<String> = Vec::new();
    if let Some(ms) = body["messages"].as_array() {
        for (i, m) in ms.iter().enumerate() {
            let role = m["role"].as_str().unwrap_or("");
            let content = &m["content"];
            if let Some(s) = content.as_str() {
                let h = crate::sha256::hex(
                    format!("{role}\u{0}{}", table::canon_string(content)).as_bytes(),
                );
                blocks.push(h[..12].to_string());
                block_tokens.push(crate::text_tokens(s));
                flat_msg.push(i);
                flat_type.push("text".to_string());
                continue;
            }
            if let Some(arr) = content.as_array() {
                for block in arr {
                    let h = crate::sha256::hex(
                        format!("{role}\u{0}{}", table::canon_string(block)).as_bytes(),
                    );
                    blocks.push(h[..12].to_string());
                    let tok = if block["type"] == "text" {
                        block["text"].as_str().map_or(0, crate::text_tokens)
                    } else {
                        0
                    };
                    block_tokens.push(tok);
                    flat_msg.push(i);
                    flat_type.push(
                        block.get("type").and_then(|t| t.as_str()).unwrap_or("block").to_string(),
                    );
                }
            }
        }
    }

    // cacheBreak vs the previous request of this (single-conversation) session
    let mut cache_break: Option<CacheBreak> = None;
    let mut client_break = 0usize;
    let mut warn: Option<String> = None;
    let mut stable = 0usize;
    if let Some(s) = session.as_deref_mut() {
        if !s.prev_blocks.is_empty() {
            let brk = attribute_break(&s.prev_blocks, &blocks);
            if let Some((index, kind)) = &brk {
                let rebilled: u64 = block_tokens.iter().skip(*index).sum();
                cache_break = Some(CacheBreak { index: *index, kind: kind.clone(), rebilled });
            }
            // T8a/T8b streaks. `stable` counts requests whose earlier messages
            // matched the previous request; a `modified` break inside a message
            // we did not rewrite is the client's own doing (a proxy-made one,
            // e.g. the recency window advancing over a block, sits in a touched
            // message).
            match &brk {
                None => {
                    s.stable += 1;
                    s.client_breaks = 0;
                }
                Some((index, kind)) => {
                    s.stable = 0;
                    s.client_breaks = if kind == "modified" && !touched.contains(&flat_msg[*index]) {
                        s.client_breaks + 1
                    } else {
                        0
                    };
                    if s.client_breaks >= 3 && !s.warned {
                        s.warned = true;
                        warn = Some(format!(
                            "warning: your client rewrites message {} (block {index}, {}) every turn - the cache never holds",
                            flat_msg[*index], flat_type[*index]
                        ));
                    }
                }
            }
            client_break = s.client_breaks;
        }
        stable = s.stable;
        s.prev_blocks = blocks.clone();
    }

    // toolTax - only when tools are advertised AND at least one tool_use exists
    let mut tool_tax: Option<ToolTax> = None;
    if let Some(tools) = body["tools"].as_array() {
        if !tools.is_empty() {
            let mut used: std::collections::HashSet<&str> = std::collections::HashSet::new();
            if let Some(ms) = body["messages"].as_array() {
                for m in ms {
                    if let Some(arr) = m["content"].as_array() {
                        for block in arr {
                            if block["type"] == "tool_use" {
                                if let Some(n) = block["name"].as_str() {
                                    used.insert(n);
                                }
                            }
                        }
                    }
                }
            }
            if !used.is_empty() {
                let mut unused: Vec<String> = tools
                    .iter()
                    .filter_map(|t| t["name"].as_str())
                    .filter(|n| !used.contains(n))
                    .map(str::to_string)
                    .collect();
                if !unused.is_empty() {
                    unused.sort();
                    let tokens: u64 = tools
                        .iter()
                        .filter(|t| t["name"].as_str().is_some_and(|n| unused.iter().any(|u| u == n)))
                        .map(|t| crate::text_tokens(&table::canon_string(t)))
                        .sum();
                    unused.truncate(8);
                    tool_tax = Some(ToolTax { unused, tokens });
                }
            }
        }
    }

    // volatileSystem: uuid/timestamp/jwt shapes in the system prompt bust the
    // prefix cache the client is paying to keep warm (headroom's CacheAligner).
    let system_text = match &body["system"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let volatile_system = !system_text.is_empty()
        && (M_UUID.is_match(&system_text)
            || M_TS.is_match(&system_text)
            || M_JWT.is_match(&system_text));

    let est_tokens = estimate_tokens(&body, &pre_tok) + page_tok;

    // Imaged pages are the ideal cache payload: large, byte-stable (asserted in
    // the render tests) and re-sent verbatim on every later turn. The proxy has
    // always PRICED caching (cache_aware_saved) but never CREATED it. Measured
    // at Sonnet rates on a 7530-token page set, re-sending it costs $0.226 over
    // 10 turns uncached vs $0.0486 cached - 4.7x, 3.0x over 5 turns, 2.1x over
    // 3. The breakpoint goes on the last block of the last message we imaged:
    // it is before the recency window, so everything it covers is settled
    // history.
    // ponytail: no minimum-prefix check - Anthropic silently declines to cache
    // a prefix under the model's floor rather than erroring, so a size test
    // would only duplicate a rule the API already enforces.
    let mut placed: HashSet<usize> = HashSet::new();
    let mut cached = false;
    if cfg.cache && last_imaged_msg >= 0 && count_breakpoints(&body) + placed.len() < MAX_BREAKPOINTS {
        cached = place(last_imaged_msg as usize, false, raw, &body, &spans, &mut reps, &mut placed)?;
    }
    // T8a: a client that never caches pays full price for its whole history every
    // turn. After two requests in a row whose earlier messages matched the last
    // one (so the prefix demonstrably holds) one breakpoint on the last block
    // before the recency window makes that history a cache read. Never when the
    // client caches itself, never a 5th breakpoint.
    let mut auto_cache = false;
    if auto_cache_on(cfg)
        && session.is_some()
        && stable >= 2
        && !client_cc
        && msg_count > keep
        && count_breakpoints(&body) + placed.len() < MAX_BREAKPOINTS
    {
        auto_cache = place(msg_count - keep - 1, true, raw, &body, &spans, &mut reps, &mut placed)?;
    }

    let changed = !reps.is_empty();
    Some(TransformResult {
        body: if changed { splice(raw, &reps) } else { raw.to_string() },
        changed,
        imaged_blocks,
        minified_blocks,
        orig_chars,
        image_count,
        saved_tokens,
        saved_tokens_cache_aware,
        cached,
        auto_cache,
        est_tokens,
        client_break,
        warn,
        blocks,
        cache_break,
        tool_tax,
        volatile_system,
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
            // Fail open. A compression proxy sits in the request path and must
            // never break the request it is optimizing; a panic here would take
            // the connection down with it. Forward the original bytes instead.
            // AssertUnwindSafe is sound because a panic discards tstats and the
            // session is best-effort stats whose poisoning is already handled.
            tstats = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                transform_request_body(text, cfg, Some(&mut guard))
            }))
            .unwrap_or(None);
        }
        if let Some(s) = &tstats {
            if s.changed {
                body_buf = s.body.clone().into_bytes();
            }
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
        let mut ev = json!({
            "ts": now_ms(),
            "tool": "proxy",
            "compressed": tstats.as_ref().is_some_and(|s| s.changed),
            "minified_blocks": tstats.as_ref().map_or(0, |s| s.minified_blocks),
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
            // whether WE placed the breakpoint (as opposed to the client
            // already caching): separates our win from theirs in the ledger
            "cache_breakpoint": tstats.as_ref().is_some_and(|s| s.cached),
            // the automatic breakpoint before the recency window (T8a)
            "auto_cache": tstats.as_ref().is_some_and(|s| s.auto_cache),
            // T2b: what the estimator predicted for the forwarded request next
            // to what Anthropic billed (input + cache reads + creates)
            "est_input_tokens": tstats.as_ref().map_or(0, |s| s.est_tokens),
            "billed_input_tokens": actual,
            "input_tokens": input,
            "cache_read_tokens": cache_read,
            "cache_create_tokens": cache_create,
            "output_tokens": output,
            // F4 diagnostics
            "blocks": tstats.as_ref().map_or_else(Vec::new, |s| s.blocks.clone()),
        });
        if let Some(s) = &tstats {
            if let Some(cb) = &s.cache_break {
                ev["cacheBreak"] = json!({ "index": cb.index, "kind": cb.kind, "rebilled": cb.rebilled });
            }
            if s.client_break > 0 {
                ev["client_break"] = json!(s.client_break);
            }
            if let Some(tt) = &s.tool_tax {
                ev["toolTax"] = json!({ "unused": tt.unused, "tokens": tt.tokens });
            }
            if s.volatile_system {
                ev["volatileSystem"] = json!(true);
            }
        }
        log_event(&ev);
        // F4: per-request diagnostic stdout, mirrored with the TS engine
        if let Some(w) = tstats.as_ref().and_then(|s| s.warn.as_ref()) {
            eprintln!("[tanuki proxy] {w}");
        }
        if let Some(s) = &tstats {
            let mut diag = String::new();
            if let Some(cb) = &s.cache_break {
                diag.push_str(&format!(" \u{b7} break@{} {}", cb.index, cb.kind));
            }
            if let Some(tt) = &s.tool_tax {
                diag.push_str(&format!(" \u{b7} toolTax {}tok", tt.tokens));
            }
            if !diag.is_empty() {
                eprintln!("[tanuki proxy]{diag}");
            }
        }
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
        "tanuki-context proxy on http://127.0.0.1:{port} -> {}\n  {knobs}\n  rules: system prompt & tools untouched \u{b7} edits spliced into your own request bytes (nothing else moves) \u{b7} in-place blocks only \u{b7} last {} message(s) kept as text \u{b7} secrets never imaged \u{b7} cache_control blocks never imaged \u{b7} identical blocks imaged once{}{} \u{b7} pretty JSON tool results minified (lossless)\n  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:{port}\n",
        cfg.upstream,
        cfg.recency_window.max(1),
        if cfg.cache { " \u{b7} imaged prefix marked cacheable" } else { "" },
        if auto_cache_on(cfg) {
            " \u{b7} auto cache breakpoint once the prefix holds"
        } else {
            ""
        },
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


    #[test]
    fn minify_json_is_whitespace_only_and_guarded() {
        let pretty = serde_json::to_string_pretty(&json!({
            "items": (0..20).map(|i| json!({ "name": format!("row {i}"), "note": "keep  these\tspaces \"q\" \\n" })).collect::<Vec<_>>()
        }))
        .unwrap()
        .replace("\"row 3\"", "12345678901234567890");
        let min = minify_json(&pretty).unwrap();
        assert!(min.contains("\"keep  these\\tspaces \\\"q\\\" \\\\n\""), "{min}");
        assert!(min.contains("12345678901234567890") && !min.contains('\n') && !min.contains(": "));
        assert_eq!(minify_json(&min), None, "already compact saves nothing");
        assert_eq!(minify_json(&format!("{pretty}\nprose")), None, "not JSON");
        assert_eq!(minify_json("{\n  \"a\": 1\n}"), None, "too small");
    }
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
        let raw_tok = crate::text_tokens(text);
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
        let r = transform_request_body(&body, &cfg(), None).expect("diagnostics still returned");
        assert!(!r.changed);
    }

    #[test]
    fn cache_control_blocks_untouched() {
        let body = json!({ "messages": [
            msg("user", json!([{ "type": "text", "text": big(), "cache_control": { "type": "ephemeral" } }])),
            msg("user", json!("latest")),
        ] })
        .to_string();
        let r = transform_request_body(&body, &cfg(), None).expect("diagnostics still returned");
        assert!(!r.changed); // rule 4
    }

    #[test]
    fn small_and_non_message_bodies_pass_through() {
        let small = json!({ "messages": [msg("user", json!("just a short note")), msg("user", json!("x"))] });
        let r = transform_request_body(&small.to_string(), &cfg(), None).expect("parseable body");
        assert!(!r.changed);
        // Unparseable / message-less bodies stay None: nothing to analyze.
        assert!(transform_request_body(r#"{"model":"m"}"#, &cfg(), None).is_none());
        assert!(transform_request_body("not json", &cfg(), None).is_none());
    }

    #[test]
    fn identical_consecutive_requests_are_not_a_break() {
        // Regression for the `>=` in attribute_break: identical lists used to
        // fall through both prefix checks - the TS engine reported a bogus
        // "modified" at index len, this engine panicked on prev[len].
        let a = vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()];
        assert!(attribute_break(&a, &a.clone()).is_none());
        // and a session-driven repeat produces no cacheBreak field
        let b = big();
        let body = json!({ "messages": [msg("user", json!(b)), msg("user", json!("latest"))] })
            .to_string();
        let mut s = ProxySession::new();
        let _first = transform_request_body(&body, &cfg(), Some(&mut s)).expect("must transform");
        let second = transform_request_body(&body, &cfg(), Some(&mut s)).expect("must transform");
        assert!(second.cache_break.is_none());
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

    /// The TS test of the same name, mirrored: the session is a ledger, never a
    /// rewrite. Swapping a block seen in an EARLIER request for a short pointer
    /// changes the prefix and invalidates the cache entry the cache_control
    /// breakpoint exists to keep stable, so EVERY sequential call of a warm
    /// session must emit the same bytes as a session-less call, not just the
    /// first. Rust had no session coverage at all before this.
    #[test]
    fn session_never_changes_emitted_bytes() {
        let b = big();
        let body = json!({ "model": "claude-opus-4", "messages": [
            msg("user", json!(b)),
            msg("user", json!("latest")),
        ] })
        .to_string();
        let cold = transform_request_body(&body, &cfg(), None).expect("must transform");
        let mut s = ProxySession::new();
        s.caching_seen = true;
        let first = transform_request_body(&body, &cfg(), Some(&mut s)).expect("must transform");
        let second = transform_request_body(&body, &cfg(), Some(&mut s)).expect("must transform");
        let third = transform_request_body(&body, &cfg(), Some(&mut s)).expect("must transform");
        assert_eq!(first.body, cold.body);
        assert_eq!(second.body, cold.body);
        assert_eq!(third.body, cold.body);
        // and the session really was warm, so the equalities above are not
        // passing on a session that never recorded anything: the block is
        // remembered and the ledger moved from first-flip to replay pricing.
        assert_eq!(s.seen_blocks.len(), 1);
        assert_ne!(second.saved_tokens_cache_aware, first.saved_tokens_cache_aware);
    }

    /// The exact dedupe marker for a repeat of `text` first imaged as `pages` pages.
    fn expected_dupe_marker(text: &str, pages: usize) -> String {
        format!(
            "[tanuki-context: {} chars, byte-identical to a block imaged above ({pages} PNG page(s)); not repeated]",
            text.chars().count(),
        )
    }

    // The proxy has always PRICED caching but never CREATED it. Imaged pages
    // are the ideal cache payload: byte-stable and re-sent every turn. Measured
    // at Sonnet rates on a 7530-token page set: 2.1x cheaper over 3 turns,
    // 4.7x over 10.
    fn cache_body(extra: Option<(&str, Value)>) -> String {
        let mut b = json!({ "messages": [
            msg("user", json!([{ "type": "text", "text": big() }, { "type": "text", "text": "tail" }])),
            msg("user", json!("latest")),
        ] });
        if let Some((k, v)) = extra {
            b[k] = v;
        }
        b.to_string()
    }

    #[test]
    fn marks_last_block_of_last_imaged_message() {
        let r = transform_request_body(&cache_body(None), &cfg(), None).expect("must transform");
        assert!(r.cached);
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        // breakpoint sits at the END of the imaged message, so the whole prefix
        // (system, tools, pages) is covered by one boundary
        assert_eq!(c.last().unwrap()["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(c.iter().filter(|b| b.get("cache_control").is_some()).count(), 1);
        // and the volatile trailing message is NOT part of the cached prefix
        assert_eq!(out["messages"][1]["content"], json!("latest"));
    }

    #[test]
    fn never_exceeds_the_four_breakpoint_ceiling() {
        // client already spent all four; a fifth is a 400, so we must decline
        let four: Vec<Value> = (0..4)
            .map(|_| json!({ "type": "text", "text": "x", "cache_control": { "type": "ephemeral" } }))
            .collect();
        let r = transform_request_body(&cache_body(Some(("system", json!(four)))), &cfg(), None)
            .expect("must still image");
        assert!(!r.cached);
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert!(c.iter().all(|b| b.get("cache_control").is_none()));
    }

    #[test]
    fn opt_out_leaves_body_free_of_breakpoints() {
        let no_cache = ProxyCfg { cache: false, ..cfg() };
        let r = transform_request_body(&cache_body(None), &no_cache, None).expect("must transform");
        assert!(!r.cached);
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert!(c.iter().all(|b| b.get("cache_control").is_none()));
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
        let tok = |t: &str| crate::text_tokens(t) as i64;
        let imaged = render::render_text(&b, true, true, Font::Normal);
        assert_eq!(r.imaged_blocks, 2);
        assert_eq!(r.image_count, pages as u64);
        assert_eq!(r.orig_chars, 2 * chars as u64);
        let dupe_marker = expected_dupe_marker(&b, pages);
        assert_eq!(
            r.saved_tokens,
            (tok(&b) - imaged.tokens as i64) + (tok(&b) - tok(&dupe_marker))
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
        assert_eq!(last["billed_input_tokens"], 136); // 111 + 22 + 3
        assert!(last["est_input_tokens"].as_u64().unwrap() > 0);
        assert_eq!(last["auto_cache"], false);
    }

    // ------------------------------------------------ T1a byte-exact splicing
    // The rewritten request is the client's own bytes with only the changed
    // spans substituted: key order, spacing, escapes and number spellings
    // elsewhere stay. (Mirror of the "byte splicing" block in proxy.test.ts.)
    const OPEN: &str = r#"{"stream" : true,
 "max_tokens":1e2, "temperature": 1.0, "system" :[{"text":"caf\u00e9 \/ sys","type":"text"}],
 "tools":[{"name":"t","input_schema":{"z":12345678901234567890,"a":1.50}}],
 "messages" : [
  "#;
    const MID: &str = r#",
  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"get","input":{"id":12345678901234567890,"f":1.50,"e":1e2}}]},
  "#;
    const LAST: &str = r#"{"content":"latest","role":"user"}
 ]
}"#;

    fn jstr(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }

    #[test]
    fn splice_keeps_untouched_bytes_of_an_imaged_request() {
        let m0 = format!(r#"{{"role":"user", "content":{}}}"#, jstr(&big()));
        let raw = format!("{OPEN}{m0}{MID}{LAST}");
        let r = transform_request_body(&raw, &cfg(), None).expect("must transform");
        assert!(r.changed && r.imaged_blocks == 1);
        assert!(r.body.starts_with(&format!(r#"{OPEN}{{"role":"user", "content":["#)));
        assert!(r.body.ends_with(&format!("}}{MID}{LAST}")));
        // 1e2, 1.0, 1.50, \u00e9 and the 20-digit ints all survived as spelled
        for lit in ["1e2", "1.0", "1.50", r"caf\u00e9 \/ sys", "12345678901234567890"] {
            assert!(r.body.contains(lit), "{lit}");
        }
        let out: Value = serde_json::from_str(&r.body).unwrap();
        let c = out["messages"][0]["content"].as_array().unwrap();
        assert!(c[0]["text"].as_str().unwrap().starts_with("[tanuki-context:"));
        assert_eq!(c.last().unwrap()["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn a_minified_tool_result_replaces_exactly_its_string_literal() {
        let doc = json!({ "items": (0..20).map(|i| json!({ "name": format!("row {i}"), "n": "N" })).collect::<Vec<_>>() });
        let pretty = serde_json::to_string_pretty(&doc).unwrap().replace("\"N\"", "12345678901234567890");
        let min = serde_json::to_string(&doc).unwrap().replace("\"N\"", "12345678901234567890");
        let tr = format!(r#"{{"content" : {} ,"type": "tool_result","tool_use_id" :"t1"}}"#, jstr(&pretty));
        let raw = format!(r#"{OPEN}{{"role":"user","content":[ {tr} ]}}{MID}{LAST}"#);
        let r = transform_request_body(&raw, &cfg(), None).expect("must transform");
        assert_eq!(r.minified_blocks, 1);
        assert_eq!(r.body, raw.replace(&jstr(&pretty), &jstr(&min)));
    }

    #[test]
    fn the_clients_own_tail_block_gains_the_breakpoint_as_one_more_member() {
        let raw = format!(
            r#"{{"messages":[{{"role":"user","content":[ {{"type":"text","text":{}}} , {{"type":"text","text":"tail" }} ]}},{{"role":"user","content":"latest"}}]}}"#,
            jstr(&big())
        );
        let r = transform_request_body(&raw, &cfg(), None).expect("must transform");
        assert!(r.cached);
        assert!(r.body.contains(r#", {"type":"text","text":"tail","cache_control":{"type":"ephemeral"} } ]}"#));
        assert!(r.body.ends_with(r#",{"role":"user","content":"latest"}]}"#));
    }

    #[test]
    fn duplicate_keys_escaped_keys_and_odd_whitespace_do_not_desynchronise_the_spans() {
        let vals: Vec<String> = (0..40).map(|i| format!("v{i}")).collect();
        let inner = jstr(&serde_json::to_string_pretty(&json!({ "a": vals })).unwrap());
        let tr = format!(
            r#"{{"type":"tool_result","tool_use_id":"t1","con\u0074ent":"stale","content":{inner}}}"#
        );
        let raw = format!(
            r#"{{ "messages" :
[
{{ "role":"user" , "content" : [ {tr} ] }} ,
{{"role":"user","content":"x"}} ] , "messages":[{{"role":"user","content":[ {tr} ]}},{{"role":"user","content":"x"}}] }}"#
        );
        let r = transform_request_body(&raw, &cfg(), None).expect("must transform");
        assert_eq!(r.minified_blocks, 1);
        assert!(r.body.starts_with("{ \"messages\" :\n[\n{ \"role\":\"user\" , \"content\" : [ "));
        assert!(r.body.ends_with(r#"{"role":"user","content":"x"}] }"#));
        let out: Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(
            out["messages"][0]["content"][0]["content"].as_str().unwrap(),
            serde_json::to_string(&json!({ "a": vals })).unwrap()
        );
    }

    // ------------------------------------------------ T1b memoised minify
    fn pretty_doc(n: usize) -> String {
        serde_json::to_string_pretty(&json!({
            "items": (0..350).map(|i| json!({ "id": format!("n{n}-{i}"), "name": format!("row {i}"), "note": "keep  these\tspaces", "tags": ["a", "b"] })).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[test]
    fn a_warm_session_scans_nothing_again_on_a_pretty_json_history() {
        let _env = AUTO_ENV.read().unwrap();
        let kb = pretty_doc(0).len() / 1024;
        let messages: Vec<Value> = (0..200)
            .map(|n| msg("user", json!([{ "type": "tool_result", "tool_use_id": format!("t{n}"), "content": pretty_doc(n) }])))
            .collect();
        let raw = json!({ "model": "claude-sonnet-4", "messages": messages }).to_string();
        // imaging off (and the auto breakpoint with it, default): this is the minify + bookkeeping path
        let c = ProxyCfg { min_chars: 1_000_000_000, ..cfg() };
        let mut s = ProxySession::new();
        let t = std::time::Instant::now();
        let first = transform_request_body(&raw, &c, Some(&mut s)).unwrap();
        let t1 = t.elapsed().as_secs_f64() * 1000.0;
        let scanned = s.memo_chars;
        let t = std::time::Instant::now();
        let second = transform_request_body(&raw, &c, Some(&mut s)).unwrap();
        let t2 = t.elapsed().as_secs_f64() * 1000.0;
        // timing is informational (shared CI runners); the gate owns speed
        println!(
            "memo timing: 200 messages x {kb} KB pretty JSON ({:.1} MB): first {t1:.0} ms, second {t2:.0} ms",
            raw.len() as f64 / 1e6
        );
        assert_eq!(first.minified_blocks, 200);
        assert_eq!(second.minified_blocks, 200);
        assert_eq!(second.body, first.body);
        assert_eq!(s.minify_memo.len(), 200);
        assert_eq!(s.memo_chars, scanned); // every block came from the memo: no text was scanned or parsed twice
    }

    #[test]
    fn already_compact_json_is_never_parsed_and_stays_untouched() {
        let compact = json!({ "items": (0..600).map(|i| json!({ "id": i, "name": format!("row {i}") })).collect::<Vec<_>>() }).to_string();
        let body = json!({ "messages": [msg("user", json!([{ "type": "tool_result", "tool_use_id": "t", "content": compact }]))] }).to_string();
        let mut s = ProxySession::new();
        let r = transform_request_body(&body, &cfg(), Some(&mut s)).unwrap();
        assert!(!r.changed);
        assert!(!could_minify(&compact));
        // the verdict is remembered
        assert_eq!(s.minify_memo.len(), 1);
        assert!(s.minify_memo.values().all(|m| m.min.is_none()));
    }

    #[test]
    fn the_memos_never_change_the_bytes_warm_and_cold_sessions_agree() {
        let body = json!({ "messages": [
            msg("user", json!([{ "type": "tool_result", "tool_use_id": "t", "content": pretty_doc(1) }])),
            msg("user", json!(big())),
            msg("assistant", json!("ok")),
        ] })
        .to_string();
        let cold = transform_request_body(&body, &cfg(), None).unwrap();
        let mut s = ProxySession::new();
        let first = transform_request_body(&body, &cfg(), Some(&mut s)).unwrap();
        let second = transform_request_body(&body, &cfg(), Some(&mut s)).unwrap();
        assert_eq!(first.body, cold.body);
        assert_eq!(second.body, cold.body);
        assert!(!s.image_memo.is_empty());
    }

    #[test]
    fn the_image_memo_is_keyed_by_config_another_font_in_the_same_session_images_afresh() {
        let body = json!({ "messages": [msg("user", json!(big())), msg("user", json!("x"))] }).to_string();
        let tiny = ProxyCfg { font: Font::Tiny, ..cfg() };
        let mut s = ProxySession::new();
        let normal = run(&body, &cfg(), &mut s);
        let other = run(&body, &tiny, &mut s);
        assert_eq!(other.body, transform_request_body(&body, &tiny, None).unwrap().body); // a cold session's answer
        assert_ne!(other.body, normal.body);
        assert_eq!(run(&body, &cfg(), &mut s).body, normal.body); // and back again
    }

    // ------------------------------------------------ T8a automatic cache breakpoint
    fn conv(n: usize, first: Value, extra: Option<(&str, Value)>) -> String {
        let msgs: Vec<Value> = vec![
            msg("user", first),
            msg("assistant", json!("a0")),
            msg("user", json!("q1")),
            msg("assistant", json!("a1")),
            msg("user", json!("q2")),
        ];
        let mut b = json!({ "model": "claude-sonnet-4", "messages": msgs.into_iter().take(n).collect::<Vec<_>>() });
        if let Some((k, v)) = extra {
            b[k] = v;
        }
        b.to_string()
    }

    fn run(body: &str, c: &ProxyCfg, s: &mut ProxySession) -> TransformResult {
        transform_request_body(body, c, Some(s)).expect("messages body")
    }

    fn warm_auto(c: &ProxyCfg) -> bool {
        let mut s = ProxySession::new();
        run(&conv(1, json!("q0"), None), c, &mut s);
        run(&conv(3, json!("q0"), None), c, &mut s);
        run(&conv(5, json!("q0"), None), c, &mut s).auto_cache
    }

    // the feature is opt-in (ProxyCfg::default().auto_cache is false): these tests turn it on
    fn auto() -> ProxyCfg {
        ProxyCfg { auto_cache: true, ..cfg() }
    }

    fn total(body: &str) -> usize {
        body.matches("cache_control").count()
    }

    fn cc_block() -> Value {
        json!({ "type": "text", "text": "x", "cache_control": { "type": "ephemeral" } })
    }

    /// `conv` with `sn` system blocks and the first `tn` of four tools carrying a breakpoint.
    fn conv_bp(n: usize, first: Value, sn: usize, tn: usize) -> String {
        let mut b: Value = serde_json::from_str(&conv(n, first, None)).unwrap();
        if sn > 0 {
            b["system"] = json!((0..sn).map(|_| cc_block()).collect::<Vec<_>>());
        }
        b["tools"] = json!((0..4)
            .map(|i| {
                let mut t = json!({ "name": format!("t{i}"), "description": "d", "input_schema": { "type": "object" } });
                if i < tn {
                    t["cache_control"] = json!({ "type": "ephemeral" });
                }
                t
            })
            .collect::<Vec<_>>());
        b.to_string()
    }

    /// TANUKI_AUTO_CACHE is process-wide: the one test that sets it holds the
    /// write side, every test that replays a warm session on the default cfg
    /// holds the read side, so none of them sees it flip mid-run.
    static AUTO_ENV: std::sync::RwLock<()> = std::sync::RwLock::new(());

    #[test]
    fn default_cfg_places_none_the_proxy_stays_a_pass_through() {
        let _env = AUTO_ENV.read().unwrap();
        let mut s = ProxySession::new();
        for n in [1, 3, 5] {
            let body = conv(n, json!("q0"), None);
            let r = run(&body, &cfg(), &mut s);
            assert!(!r.auto_cache);
            assert_eq!(r.body, body);
        }
    }

    #[test]
    fn tanuki_auto_cache_on_opts_in_with_the_default_cfg_but_not_past_no_cache_and_off_means_nothing_special() {
        let _env = AUTO_ENV.write().unwrap();
        std::env::set_var("TANUKI_AUTO_CACHE", "on");
        assert!(warm_auto(&cfg()));
        let mut s = ProxySession::new();
        run(&conv(1, json!("q0"), None), &cfg(), &mut s);
        run(&conv(3, json!("q0"), None), &cfg(), &mut s);
        assert_eq!(total(&run(&conv(5, json!("q0"), None), &cfg(), &mut s).body), 1);
        assert!(!warm_auto(&ProxyCfg { cache: false, ..cfg() }));
        std::env::set_var("TANUKI_AUTO_CACHE", "off");
        assert!(!warm_auto(&cfg()));
        assert!(warm_auto(&auto()));
        std::env::remove_var("TANUKI_AUTO_CACHE");
    }

    #[test]
    fn first_two_requests_untouched_the_third_gets_one_breakpoint_before_the_recency_window() {
        let mut s = ProxySession::new();
        let r1 = run(&conv(1, json!("q0"), None), &auto(), &mut s);
        let r2 = run(&conv(3, json!("q0"), None), &auto(), &mut s);
        assert!(!(r1.changed || r2.changed || r1.auto_cache || r2.auto_cache));
        let r3 = run(&conv(5, json!("q0"), None), &auto(), &mut s);
        assert!(r3.auto_cache);
        // the same literal becomes the one text block that carries it; nothing else moves
        assert_eq!(
            r3.body,
            conv(5, json!("q0"), None).replace(
                r#""content":"a1""#,
                r#""content":[{"type":"text","text":"a1","cache_control":{"type":"ephemeral"}}]"#
            )
        );
        assert_eq!(total(&r3.body), 1);
    }

    #[test]
    fn a_client_breakpoint_on_any_message_block_suppresses_it() {
        let mut s = ProxySession::new();
        let client = json!([{ "type": "text", "text": "q0", "cache_control": { "type": "ephemeral" } }]);
        for n in [1, 3, 5] {
            let r = run(&conv(n, client.clone(), None), &auto(), &mut s);
            assert!(!r.auto_cache && !r.changed);
        }
    }

    #[test]
    fn client_breakpoints_in_system_tools_or_both_count_toward_the_ceiling_of_four() {
        // (system, tools, does auto place one?)
        for (sn, tn, expected) in [
            (4, 0, false), (3, 0, true), (0, 4, false), (0, 3, true), (2, 2, false),
            (1, 2, true), (1, 3, false), (3, 1, false), (2, 1, true),
        ] {
            let mut s = ProxySession::new();
            for n in [1, 3] {
                run(&conv_bp(n, json!("q0"), sn, tn), &auto(), &mut s);
            }
            let r = run(&conv_bp(5, json!("q0"), sn, tn), &auto(), &mut s);
            assert_eq!(r.auto_cache, expected, "system {sn} tools {tn}");
            assert_eq!(total(&r.body), sn + tn + usize::from(expected), "system {sn} tools {tn}");
        }
    }

    #[test]
    fn with_imaging_on_the_imaged_prefix_breakpoint_and_the_automatic_one_never_pass_four_in_total() {
        let c = ProxyCfg { min_chars: 1000, ..auto() };
        for sn in 0..=4 {
            for tn in 0..=(4 - sn) {
                let k = sn + tn;
                let mut s = ProxySession::new();
                // big() opens the conversation, so it is imaged from the first request on
                for n in [3, 3] {
                    assert!(total(&run(&conv_bp(n, json!(big()), sn, tn), &c, &mut s).body) <= 4);
                }
                let r = run(&conv_bp(5, json!(big()), sn, tn), &c, &mut s);
                assert_eq!(r.imaged_blocks, 1, "system {sn} tools {tn}");
                assert_eq!(r.cached, k < 4, "system {sn} tools {tn}");
                assert_eq!(r.auto_cache, k < 3, "system {sn} tools {tn}");
                assert_eq!(total(&r.body), (k + 2).min(4), "system {sn} tools {tn}");
            }
        }
    }

    #[test]
    fn breakpoints_inside_a_tool_results_own_content_count_too() {
        let nested = |n: usize| msg("user", json!([{ "type": "tool_result", "tool_use_id": "t", "content": (0..n).map(|_| cc_block()).collect::<Vec<_>>() }]));
        // four nested breakpoints leave no room for the imaged-prefix one
        let full = json!({ "model": "claude-sonnet-4", "messages": [
            msg("user", json!(big())), msg("assistant", json!("a0")), nested(4), msg("assistant", json!("a1")), msg("user", json!("q2")),
        ] })
        .to_string();
        let r = transform_request_body(&full, &auto(), None).unwrap();
        assert_eq!(r.imaged_blocks, 1);
        assert!(!r.cached);
        assert_eq!(total(&r.body), 4);
        // and a nested one is a client breakpoint: the automatic one stays away
        let mut s = ProxySession::new();
        for n in [1, 3, 5] {
            let msgs: Vec<Value> = vec![nested(1), msg("assistant", json!("a0")), msg("user", json!("q1")), msg("assistant", json!("a1")), msg("user", json!("q2"))];
            let body = json!({ "model": "claude-sonnet-4", "messages": msgs.into_iter().take(n).collect::<Vec<_>>() }).to_string();
            assert!(!run(&body, &auto(), &mut s).auto_cache);
        }
    }

    #[test]
    fn a_prefix_that_keeps_changing_earns_none_and_the_opt_outs_hold() {
        let _env = AUTO_ENV.read().unwrap();
        let mut s = ProxySession::new();
        for (i, n) in [1, 3, 5, 5].into_iter().enumerate() {
            // message 0 differs on every request: the cache never held
            assert!(!run(&conv(n, json!(format!("q0-{i}")), None), &auto(), &mut s).auto_cache);
        }
        assert!(warm_auto(&auto()));
        assert!(!warm_auto(&cfg())); // the default
        assert!(!warm_auto(&ProxyCfg { cache: false, ..auto() })); // --no-cache
        assert!(!transform_request_body(&conv(5, json!("q0"), None), &auto(), None).unwrap().auto_cache); // no session
    }

    #[test]
    fn a_thinking_tail_cannot_carry_one() {
        let thinking = json!([{ "type": "thinking", "thinking": "hm", "signature": "s" }]);
        let body = |n: usize| {
            let mut v: Vec<Value> = vec![
                msg("user", json!("q0")),
                msg("assistant", thinking.clone()),
                msg("user", json!("q1")),
                msg("assistant", thinking.clone()),
                msg("user", json!("q2")),
            ];
            v.truncate(n);
            json!({ "messages": v }).to_string()
        };
        let mut s = ProxySession::new();
        run(&body(1), &auto(), &mut s);
        run(&body(3), &auto(), &mut s);
        let r = run(&body(5), &auto(), &mut s);
        assert!(!r.auto_cache && !r.changed);
    }

    #[test]
    fn the_breakpoint_lands_on_the_clients_own_last_block_as_one_more_member() {
        let mut s = ProxySession::new();
        let head = r#"{"model":"m","messages":[{"role":"user","content":"q0"},{"role":"assistant","content":"a0"},{"role":"user","content":"q1"}"#;
        let short = format!("{head}]}}");
        let long = format!(
            r#"{head},{{"role":"assistant","content":[{{"type":"text","text":"a1"}},{{"type":"text", "text":"a2" }}]}},{{"role":"user","content":"q2"}}]}}"#
        );
        run(&short, &auto(), &mut s);
        run(&short, &auto(), &mut s);
        let r = run(&long, &auto(), &mut s);
        assert!(r.auto_cache);
        assert_eq!(
            r.body,
            long.replace(r#""text":"a2" }"#, r#""text":"a2","cache_control":{"type":"ephemeral"} }"#)
        );
    }

    // ------------------------------------------------ T8b client cache-break warning
    // the client rewrites message 1 on every turn (a volatile timestamp, say)
    fn turn(n: usize, tool: Option<&str>) -> String {
        let first = match tool {
            None => json!("q0"),
            Some(t) => json!([{ "type": "tool_result", "tool_use_id": "t", "content": t }]),
        };
        json!({ "model": "claude-sonnet-4", "messages": [
            msg("user", first),
            msg("assistant", json!(format!("reply at {n}"))),
            msg("user", json!("q1")),
        ] })
        .to_string()
    }

    #[test]
    fn three_consecutive_modified_breaks_in_an_untouched_message_warn_once() {
        let mut s = ProxySession::new();
        assert_eq!(run(&turn(0, None), &cfg(), &mut s).client_break, 0);
        let mut streak = Vec::new();
        let mut warns: Vec<Option<String>> = Vec::new();
        for n in 1..=5 {
            let r = run(&turn(n, None), &cfg(), &mut s);
            streak.push(r.client_break);
            warns.push(r.warn);
        }
        assert_eq!(streak, vec![1, 2, 3, 4, 5]);
        assert!(warns[0].is_none() && warns[1].is_none());
        let w = warns[2].as_deref().expect("third break warns");
        assert!(w.contains("message 1") && w.contains("block 1") && w.contains("text") && w.contains("cache never holds"), "{w}");
        assert!(warns[3].is_none() && warns[4].is_none()); // once per session
    }

    #[test]
    fn a_clean_append_resets_the_streak() {
        let mut s = ProxySession::new();
        run(&turn(0, None), &cfg(), &mut s);
        run(&turn(1, None), &cfg(), &mut s);
        assert_eq!(run(&turn(2, None), &cfg(), &mut s).client_break, 2);
        let mut grown: Value = serde_json::from_str(&turn(2, None)).unwrap();
        grown["messages"].as_array_mut().unwrap().push(msg("assistant", json!("more")));
        assert_eq!(run(&grown.to_string(), &cfg(), &mut s).client_break, 0);
        assert_eq!(run(&turn(3, None), &cfg(), &mut s).client_break, 1);
    }

    #[test]
    fn a_break_inside_a_message_the_proxy_rewrote_is_not_the_clients() {
        let mut s = ProxySession::new();
        for n in 0..6 {
            let pretty = serde_json::to_string_pretty(&json!({
                "items": (0..30).map(|i| json!({ "id": format!("v{n}-{i}"), "note": "keep  spaces" })).collect::<Vec<_>>()
            }))
            .unwrap();
            let r = run(&turn(0, Some(&pretty)), &cfg(), &mut s);
            assert_eq!(r.minified_blocks, 1);
            assert_eq!(r.client_break, 0);
            assert!(r.warn.is_none());
        }
    }

    // ------------------------------------------------ T2b estimated vs billed
    #[test]
    fn the_estimate_covers_system_tools_text_tool_traffic_and_our_pages() {
        let base = json!({
            "model": "m", "system": "You are terse.",
            "tools": [{ "name": "get", "description": "fetch a thing", "input_schema": { "type": "object" } }],
            "messages": [
                msg("user", json!("hello there")),
                msg("assistant", json!([{ "type": "tool_use", "id": "t1", "name": "get", "input": { "k": "v" } }])),
                msg("user", json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "done" }])),
            ],
        });
        let r = transform_request_body(&base.to_string(), &cfg(), None).unwrap();
        assert!(r.est_tokens > 20);
        // more text -> larger estimate, monotonically
        let mut more = base.clone();
        more["system"] = json!(format!("You are terse. {}", "Be careful and precise. ".repeat(40)));
        let m = transform_request_body(&more.to_string(), &cfg(), None).unwrap();
        assert!(m.est_tokens > r.est_tokens + 100);
        // an imaged block is priced at its pages, not at the text it replaced
        let body = json!({ "messages": [msg("user", json!(big())), msg("user", json!("latest"))] }).to_string();
        let imaged = transform_request_body(&body, &cfg(), None).unwrap();
        let as_text = transform_request_body(&body, &ProxyCfg { min_chars: 1_000_000_000, ..cfg() }, None).unwrap();
        assert_eq!(imaged.imaged_blocks, 1);
        assert!(imaged.est_tokens < as_text.est_tokens);
        assert!(imaged.est_tokens > 200); // pages are not free
    }
}
