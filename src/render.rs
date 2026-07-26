//! Stage 2: the `pxpipe` imaging engine, ported from pxpipe's render.ts
//! production dense path (bare 5x8 AA cell, 312 cols, 1568x728 pages).
//! Glyphs cover BMP (pxpipe's atlas: Spleen for ASCII/code, Unifont fallback)
//! PLUS the astral planes (unifont_upper, incl. emoji) — beyond pxpipe, which
//! drops astral. Only unassigned codepoints fall back to `▯` and are counted
//! as dropped.
//!
//! Two tanuki-only extensions over the faithful port, both behind knobs so the
//! `pack=false, font=Normal` path stays byte-identical to pxpipe (parity):
//!   * `pack`  — lossless reflow tighter than pxpipe: single-cell tabs (no
//!               4-col padding) + indent run-length (`⇥N`), plus per-page
//!               width-trim so short payloads stop paying for 1568px rows.
//!   * `font`  — `Tiny` renders the same atlas box-filtered into a 4x6 cell
//!               (390 cols x 120 rows/page), ~40% fewer image-tokens; opt-in,
//!               transcription-accuracy gated.

use crate::atlas::{self, CELL_H, CELL_W};
use crate::png::encode_gray_png;
use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

pub const PAD_X: usize = 4;
pub const PAD_Y: usize = 4;
pub const MAX_WIDTH_PX: usize = 1568; // Anthropic no-resample bound
pub const MAX_HEIGHT_PX: usize = 728;

pub const NL_SENTINEL: char = '\u{21B5}'; // ↵ inserted for original hard newlines
pub const NL_LITERAL: char = '\u{23CE}'; // ⏎ stands in for pre-existing ↵ in source
const TAB_MARK: char = '\u{2192}'; // → visible tab marker
const TAB_LITERAL: char = '\u{21E2}'; // ⇢ stands in for pre-existing → (pack mode)
const INDENT_MARK: char = '\u{21E5}'; // ⇥ leading-indent run-length header (pack mode)
const INDENT_LITERAL: char = '\u{21E8}'; // ⇨ stands in for pre-existing ⇥ (pack mode)
const FALLBACK: char = '\u{25AF}'; // ▯ for codepoints absent from the atlas (unassigned)
const TAB_WIDTH: usize = 4;
const MIN_INDENT: usize = 3; // shorter runs aren't worth a 2-char code
// 62 count symbols: an indent run of N spaces (3..=61) -> INDENT_MARK + ALPHABET[N].
pub(crate) const INDENT_ALPHABET: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

static NL4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{4,}").unwrap());

/// Cell dimensions and page grid for a font.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Font {
    Normal,
    Tiny,
}

impl Font {
    pub fn parse(s: &str) -> Font {
        if s.eq_ignore_ascii_case("tiny") {
            Font::Tiny
        } else {
            Font::Normal
        }
    }
    fn cell(self) -> (usize, usize) {
        match self {
            Font::Normal => (CELL_W, CELL_H),
            Font::Tiny => (4, 6),
        }
    }
}

#[derive(Clone, Copy)]
pub struct Geom {
    pub cw: usize,
    pub ch: usize,
    pub cols: usize,
    pub max_lines: usize,
    pub max_chars: usize,
}

pub fn geom(font: Font) -> Geom {
    let (cw, ch) = font.cell();
    let cols = (MAX_WIDTH_PX - 2 * PAD_X) / cw;
    let max_lines = (MAX_HEIGHT_PX - 2 * PAD_Y) / ch;
    Geom {
        cw,
        ch,
        cols,
        max_lines,
        max_chars: cols * max_lines,
    }
}

/// Cells a codepoint occupies (pxpipe cellsFor): wide glyphs take 2,
/// missing codepoints advance 1 for wrap stability.
fn cells_for(cp: u32) -> usize {
    match atlas::rank(cp) {
        Some(r) if atlas::is_wide(r) => 2,
        _ => 1,
    }
}

/// Strip trailing spaces/tabs per line, collapse 4+ consecutive \n to 3
/// (pxpipe minifyForRender).
pub fn minify(text: &str) -> String {
    let joined = text
        .split('\n')
        .map(|l| l.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n");
    NL4.replace_all(&joined, "\n\n\n").into_owned()
}

/// Expand tabs to 4-col stops: '→' marker + spaces (pxpipe expandTabsInLine).
pub fn expand_tabs(line: &str) -> String {
    if !line.contains('\t') {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 8);
    let mut col = 0usize;
    for ch in line.chars() {
        if ch == '\t' {
            let span = TAB_WIDTH - (col % TAB_WIDTH);
            out.push(TAB_MARK);
            for _ in 1..span {
                out.push(' ');
            }
            col += span;
        } else {
            out.push(ch);
            col += cells_for(ch as u32);
        }
    }
    out
}

/// Pack a single line: every tab -> single '→' cell (no 4-col padding), then
/// run-length the leading-space run (`⇥` + one count symbol). Lossless; the
/// inverse is `⇥X` -> X spaces, `→` -> tab.
fn pack_line(line: &str) -> String {
    let tabbed: String = line.replace('\t', &TAB_MARK.to_string());
    let indent = tabbed.chars().take_while(|&c| c == ' ').count();
    if indent >= MIN_INDENT && indent < INDENT_ALPHABET.len() {
        let mut out = String::with_capacity(tabbed.len());
        out.push(INDENT_MARK);
        out.push(INDENT_ALPHABET[indent] as char);
        out.push_str(&tabbed[indent..]); // leading run is ASCII spaces -> byte index ok
        out
    } else {
        tabbed
    }
}

/// Swap pre-existing ↵ for ⏎ so reflow can pack newlines (render-prep only).
pub fn neutralize(text: &str) -> String {
    if text.contains(NL_SENTINEL) {
        text.replace(NL_SENTINEL, &NL_LITERAL.to_string())
    } else {
        text.to_string()
    }
}

/// Pack-mode neutralize: also protect pre-existing `→`/`⇥` (they become
/// meaningful sentinels after packing) so reconstruction stays exact.
pub fn neutralize_pack(text: &str) -> String {
    let mut s = neutralize(text);
    if s.contains(TAB_MARK) {
        s = s.replace(TAB_MARK, &TAB_LITERAL.to_string());
    }
    if s.contains(INDENT_MARK) {
        s = s.replace(INDENT_MARK, &INDENT_LITERAL.to_string());
    }
    s
}

/// Minify + expand tabs + join hard newlines with the ↵ sentinel.
/// Call after `neutralize` so the join can never collide.
pub fn reflow(text: &str) -> String {
    let minified = minify(text);
    let mut out = String::with_capacity(minified.len());
    let mut first = true;
    for line in minified.split('\n') {
        if !first {
            out.push(NL_SENTINEL);
        }
        out.push_str(&expand_tabs(line));
        first = false;
    }
    out
}

/// Pack-mode reflow: single-cell tabs + indent RLE, then ↵-join.
/// Call after `neutralize_pack`.
pub fn reflow_pack(text: &str) -> String {
    let minified = minify(text);
    let mut out = String::with_capacity(minified.len());
    let mut first = true;
    for line in minified.split('\n') {
        if !first {
            out.push(NL_SENTINEL);
        }
        out.push_str(&pack_line(line));
        first = false;
    }
    out
}

/// Wrap to `cols` cells per row, by codepoint (pxpipe wrapLines).
pub fn wrap_lines(text: &str, cols: usize) -> Vec<String> {
    let mut out = Vec::new();
    let minified = minify(text);
    for raw_line in minified.split('\n') {
        let line = expand_tabs(raw_line);
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut cur = String::new();
        let mut cur_cols = 0usize;
        for ch in line.chars() {
            let w = cells_for(ch as u32);
            if cur_cols + w > cols {
                out.push(std::mem::take(&mut cur));
                cur.push(ch);
                cur_cols = w;
            } else {
                cur.push(ch);
                cur_cols += w;
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

/// Split wrapped lines into pages of <= max_lines rows and <= max_chars chars
/// (pxpipe splitWrappedLinesIntoReadablePages).
pub fn split_pages(lines: Vec<String>, max_lines: usize, max_chars: usize) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut cur_chars = 0usize;
    for line in lines {
        let line_chars = line.chars().count() + usize::from(!cur.is_empty());
        if !cur.is_empty() && (cur.len() >= max_lines || cur_chars + line_chars > max_chars) {
            pages.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur_chars += line.chars().count() + usize::from(!cur.is_empty());
        cur.push(line);
    }
    if !cur.is_empty() {
        pages.push(cur);
    }
    pages
}

/// pxpipe v0.11 (#96): a codepoint absent from the atlas renders as a readable
/// `[U+HEX]` escape instead of a lost cell — except invisible/formatting
/// codepoints, which stay (and blit as a blank cell, not a ▯).
pub fn is_escape_exempt(cp: u32) -> bool {
    cp < 0x20 // C0 controls (tabs are expanded before this runs)
        || (0x7f..=0x9f).contains(&cp) // DEL + C1 controls
        || (0x0300..=0x036f).contains(&cp) // combining diacritics
        || matches!(cp, 0x200b | 0x200c | 0x200d | 0x2060 | 0xfeff) // zero-width / word-joiner / BOM
        || (0xfe00..=0xfe0f).contains(&cp) // variation selectors
        || (0xe0100..=0xe01ef).contains(&cp) // variation selectors supplement
}

/// Escape atlas-missing codepoints as `[U+HEX]` so wrap math and the blitter
/// see the readable text. Borrows when nothing is missing (the common case).
pub fn escape_missing_glyphs(text: &str) -> Cow<'_, str> {
    let mut out: Option<String> = None; // lazily materialized on first miss
    for (i, ch) in text.char_indices() {
        let cp = ch as u32;
        if atlas::rank(cp).is_none() && !is_escape_exempt(cp) {
            use std::fmt::Write as _;
            let s = out.get_or_insert_with(|| text[..i].to_string());
            let _ = write!(s, "[U+{cp:X}]");
        } else if let Some(s) = &mut out {
            s.push(ch);
        }
    }
    match out {
        Some(s) => Cow::Owned(s),
        None => Cow::Borrowed(text),
    }
}

/// Shared front half of render/estimate: (neutralize -> reflow ->) escape -> wrap -> page.
fn prep_pages(text: &str, use_reflow: bool, pack: bool, g: Geom) -> Vec<Vec<String>> {
    let prepped: String = if use_reflow {
        if pack {
            reflow_pack(&neutralize_pack(text))
        } else {
            reflow(&neutralize(text))
        }
    } else {
        text.to_string()
    };
    let lines = wrap_lines(&escape_missing_glyphs(&prepped), g.cols);
    split_pages(lines, g.max_lines, g.max_chars)
}

fn page_height(rows: usize, g: Geom) -> usize {
    2 * PAD_Y + rows * g.ch
}

/// Page pixel width: full (pxpipe) unless `pack`, then trimmed to the widest
/// row actually present (capped at the column bound). Pure geometry — lossless.
fn page_width(lines: &[String], g: Geom, pack: bool) -> usize {
    if !pack {
        return 2 * PAD_X + g.cols * g.cw;
    }
    let max_cells = lines
        .iter()
        .map(|l| l.chars().map(|c| cells_for(c as u32)).sum::<usize>().min(g.cols))
        .max()
        .unwrap_or(0);
    (2 * PAD_X + max_cells * g.cw).max(2 * PAD_X + g.cw)
}

pub struct Page {
    pub png: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub dropped: usize,
}

/// Blit one glyph's AA coverage (max blend) at pixel position; returns cells advanced.
fn blit(fb: &mut [u8], fb_w: usize, x: usize, y: usize, cp: u32, g: Geom, font: Font) -> usize {
    let rank = match atlas::rank(cp) {
        Some(r) => r,
        None => return 0,
    };
    let wide = atlas::is_wide(rank);
    let dst_w = if wide { 2 * g.cw } else { g.cw };
    let scaled;
    let cov: &[u8] = match font {
        Font::Normal => atlas::coverage(rank),
        Font::Tiny => {
            scaled = atlas::coverage_scaled(rank, dst_w, g.ch);
            &scaled
        }
    };
    for gy in 0..g.ch {
        let dst_row = (y + gy) * fb_w + x;
        let src_row = gy * dst_w;
        for gx in 0..dst_w {
            let c = cov[src_row + gx];
            if c > 0 {
                let idx = dst_row + gx;
                if c > fb[idx] {
                    fb[idx] = c;
                }
            }
        }
    }
    if wide {
        2
    } else {
        1
    }
}

/// Render one page of wrapped lines to a grayscale PNG (black-on-white).
fn render_page(lines: &[String], g: Geom, pack: bool, font: Font) -> Page {
    let width = page_width(lines, g, pack);
    let height = page_height(lines.len(), g);
    let mut fb = vec![0u8; width * height];
    let mut dropped = 0usize;
    for (row, line) in lines.iter().enumerate() {
        let base_y = PAD_Y + row * g.ch;
        let mut col = 0usize;
        for ch in line.chars() {
            if col >= g.cols {
                break;
            }
            let base_x = PAD_X + col * g.cw;
            let mut advance = blit(&mut fb, width, base_x, base_y, ch as u32, g, font);
            if advance == 0 {
                advance = 1;
                if is_escape_exempt(ch as u32) {
                    // invisible formatting char: blank cell, not content loss
                } else {
                    dropped += 1;
                    if ch != ' ' {
                        blit(&mut fb, width, base_x, base_y, FALLBACK as u32, g, font);
                    }
                }
            }
            col += advance;
        }
    }
    for v in fb.iter_mut() {
        *v = 255 - *v; // invert: black ink on white paper
    }
    let png = encode_gray_png(&fb, width, height);
    Page {
        png,
        width,
        height,
        dropped,
    }
}

#[allow(dead_code)] // `pixels` is read by unit tests only; billing moved to `tokens`
pub struct Rendered {
    pub pages: Vec<Page>,
    pub pixels: u64, // kept internally (tests, future callers); billing uses `tokens`
    pub tokens: u64,
    pub dropped: usize,
}

/// Full stage 2: prep + blit + PNG encode.
pub fn render_text(text: &str, use_reflow: bool, pack: bool, font: Font) -> Rendered {
    let g = geom(font);
    let pages: Vec<Page> = prep_pages(text, use_reflow, pack, g)
        .iter()
        .map(|p| render_page(p, g, pack, font))
        .collect();
    let pixels = pages.iter().map(|p| (p.width * p.height) as u64).sum();
    let tokens = pages.iter().map(|p| patch_tokens(p.width, p.height)).sum();
    let dropped = pages.iter().map(|p| p.dropped).sum();
    Rendered {
        pages,
        pixels,
        tokens,
        dropped,
    }
}

#[allow(dead_code)] // `pixels` is read by unit tests only; billing moved to `tokens`
pub struct Estimated {
    pub pages: usize,
    pub pixels: u64, // kept internally; billing uses `tokens`
    pub tokens: u64,
}

/// Same geometry as render_text without blitting/encoding — exact, fast,
/// and never touches the (lazily decompressed) pixel data.
pub fn estimate_text(text: &str, use_reflow: bool, pack: bool, font: Font) -> Estimated {
    let g = geom(font);
    let page_lines = prep_pages(text, use_reflow, pack, g);
    let (mut pixels, mut tokens) = (0u64, 0u64);
    for p in &page_lines {
        let (w, h) = (page_width(p, g, pack), page_height(p.len(), g));
        pixels += (w * h) as u64;
        tokens += patch_tokens(w, h);
    }
    Estimated {
        pages: page_lines.len(),
        pixels,
        tokens,
    }
}

/// Anthropic bills by 28×28-px PATCHES: ⌈w/28⌉×⌈h/28⌉ visual tokens (the old
/// pixels/750 was a ~4-5% continuous approximation of the same 784 px²/patch
/// grid). Pages are always ≤ 1568×728 = 56×26 = 1456 patches, inside the
/// standard tier's long-edge (1568) and token (1568) limits, so the documented
/// pre-billing downscale never fires and the raw patch count IS the cost.
pub const PATCH_PX: usize = 28;
pub fn patch_tokens(width: usize, height: usize) -> u64 {
    (width.div_ceil(PATCH_PX) * height.div_ceil(PATCH_PX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inverse of `reflow_pack` — proves the pack transform is lossless.
    fn pack_decode(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                NL_SENTINEL => out.push('\n'),
                TAB_MARK => out.push('\t'),
                INDENT_MARK => {
                    if let Some(&sym) = chars.peek() {
                        chars.next();
                        let n = INDENT_ALPHABET
                            .iter()
                            .position(|&b| b as char == sym)
                            .expect("valid indent symbol");
                        for _ in 0..n {
                            out.push(' ');
                        }
                    }
                }
                TAB_LITERAL => out.push(TAB_MARK),
                INDENT_LITERAL => out.push(INDENT_MARK),
                NL_LITERAL => out.push(NL_SENTINEL),
                other => out.push(other),
            }
        }
        out
    }

    #[test]
    fn pack_roundtrip_code() {
        let src = "fn main() {\n\t\tlet x = 1;\n        deep();\n}";
        let packed = reflow_pack(&neutralize_pack(src));
        assert_eq!(pack_decode(&packed), src);
    }

    #[test]
    fn pack_roundtrip_preexisting_sentinels() {
        // literal → and ⇥ and ↵ in the source must survive exactly.
        let src = "a → b\tc\n⇥weird↵end";
        let packed = reflow_pack(&neutralize_pack(src));
        assert_eq!(pack_decode(&packed), src);
    }

    #[test]
    fn pack_shrinks_indented_code() {
        // 12-space indent: pack replaces 12 cells with a 2-cell ⇥ code.
        let src = "            deeply_indented();";
        let packed = reflow_pack(&neutralize_pack(src));
        assert!(packed.chars().count() < src.chars().count());
        assert_eq!(pack_decode(&packed), src);
    }

    #[test]
    fn width_trim_helps_short_input() {
        let short = "error: connection refused\nretry 3";
        let full = estimate_text(short, true, false, Font::Normal);
        let packed = estimate_text(short, true, true, Font::Normal);
        assert!(packed.pixels < full.pixels, "pack must trim short pages");
    }

    #[test]
    fn tiny_font_cuts_pixels() {
        let body = "the quick brown fox jumps over the lazy dog ".repeat(200);
        let normal = estimate_text(&body, true, true, Font::Normal);
        let tiny = estimate_text(&body, true, true, Font::Tiny);
        assert!(tiny.pixels < normal.pixels);
    }

    #[test]
    fn nonpack_geometry_is_pxpipe() {
        // pack=false full width must be exactly the 1568px page.
        let g = geom(Font::Normal);
        let full = 2 * PAD_X + g.cols * g.cw;
        assert_eq!(full, MAX_WIDTH_PX);
    }

    #[test]
    fn patch_grid_token_math() {
        // full page 1568×728 = 56×26 patches; a width-trimmed 353×16 page = 13×1.
        assert_eq!(patch_tokens(MAX_WIDTH_PX, MAX_HEIGHT_PX), 1456);
        assert_eq!(patch_tokens(353, 16), 13);
    }

    #[test]
    fn missing_glyphs_escape_readable() {
        // U+10FFFE is a noncharacter (never in the atlas) -> readable escape;
        // exempt invisibles (ZWSP) stay put.
        assert_eq!(escape_missing_glyphs("a\u{10FFFE}b"), "a[U+10FFFE]b");
        assert_eq!(escape_missing_glyphs("a\u{200B}b"), "a\u{200B}b");
        // wrap math sees the escape: 9 chars still fit one page/row.
        let est = estimate_text("x\u{10FFFE}", true, true, Font::Normal);
        assert_eq!(est.pages, 1);
    }
}
