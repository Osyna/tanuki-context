//! Stage 2: the `pxpipe` imaging engine, ported from pxpipe's render.ts
//! production dense path (bare 5x8 AA cell, 312 cols, 1568x728 pages).
//! Glyphs cover the full BMP (Spleen for ASCII/code, Unifont fallback), so
//! CJK/Cyrillic/etc. render exactly as pxpipe does; only astral codepoints
//! (emoji outside the BMP) fall back to `▯` and are counted as dropped —
//! same behavior as pxpipe's own atlas.

use crate::atlas::{self, CELL_H, CELL_W};
use crate::png::encode_gray_png;
use regex::Regex;
use std::sync::LazyLock;

pub const COLS: usize = 312;
pub const PAD_X: usize = 4;
pub const PAD_Y: usize = 4;
pub const MAX_HEIGHT_PX: usize = 728;
pub const CHARS_PER_IMAGE: usize = 28080;
pub const MAX_LINES: usize = (MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H; // 90

pub const NL_SENTINEL: char = '\u{21B5}'; // ↵ inserted for original hard newlines
pub const NL_LITERAL: char = '\u{23CE}'; // ⏎ stands in for pre-existing ↵ in source
const TAB_MARK: char = '\u{2192}'; // → visible tab marker
const FALLBACK: char = '\u{25AF}'; // ▯ for codepoints outside the atlas (astral only)
const TAB_WIDTH: usize = 4;

static NL4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{4,}").unwrap());

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

/// Swap pre-existing ↵ for ⏎ so reflow can pack newlines (render-prep only).
pub fn neutralize(text: &str) -> String {
    if text.contains(NL_SENTINEL) {
        text.replace(NL_SENTINEL, &NL_LITERAL.to_string())
    } else {
        text.to_string()
    }
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

/// Shared front half of render/estimate: (neutralize -> reflow ->) wrap -> page.
fn prep_pages(text: &str, use_reflow: bool) -> Vec<Vec<String>> {
    let prepped: String = if use_reflow {
        reflow(&neutralize(text))
    } else {
        text.to_string()
    };
    let lines = wrap_lines(&prepped, COLS);
    split_pages(lines, MAX_LINES, CHARS_PER_IMAGE)
}

pub const PAGE_WIDTH: usize = 2 * PAD_X + COLS * CELL_W; // 1568

fn page_height(rows: usize) -> usize {
    2 * PAD_Y + rows * CELL_H
}

pub struct Page {
    pub png: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub dropped: usize,
}

/// Blit one glyph's AA coverage (max blend) at pixel position; returns cells advanced.
fn blit(fb: &mut [u8], fb_w: usize, x: usize, y: usize, cp: u32) -> usize {
    let rank = match atlas::rank(cp) {
        Some(r) => r,
        None => return 0,
    };
    let wide = atlas::is_wide(rank);
    let src_w = if wide { 2 * CELL_W } else { CELL_W };
    let cov = atlas::coverage(rank);
    for gy in 0..CELL_H {
        let dst_row = (y + gy) * fb_w + x;
        let src_row = gy * src_w;
        for gx in 0..src_w {
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
fn render_page(lines: &[String]) -> Page {
    let width = PAGE_WIDTH;
    let height = page_height(lines.len());
    let mut fb = vec![0u8; width * height];
    let mut dropped = 0usize;
    for (row, line) in lines.iter().enumerate() {
        let base_y = PAD_Y + row * CELL_H;
        let mut col = 0usize;
        for ch in line.chars() {
            if col >= COLS {
                break;
            }
            let base_x = PAD_X + col * CELL_W;
            let mut advance = blit(&mut fb, width, base_x, base_y, ch as u32);
            if advance == 0 {
                dropped += 1;
                if ch != ' ' {
                    blit(&mut fb, width, base_x, base_y, FALLBACK as u32);
                }
                advance = 1;
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

pub struct Rendered {
    pub pages: Vec<Page>,
    pub pixels: u64,
    pub dropped: usize,
}

/// Full stage 2: prep + blit + PNG encode.
pub fn render_text(text: &str, use_reflow: bool) -> Rendered {
    let pages: Vec<Page> = prep_pages(text, use_reflow)
        .iter()
        .map(|p| render_page(p))
        .collect();
    let pixels = pages.iter().map(|p| (p.width * p.height) as u64).sum();
    let dropped = pages.iter().map(|p| p.dropped).sum();
    Rendered {
        pages,
        pixels,
        dropped,
    }
}

pub struct Estimated {
    pub pages: usize,
    pub pixels: u64,
}

/// Same geometry as render_text without blitting/encoding — exact, fast,
/// and never touches the (lazily decompressed) pixel data.
pub fn estimate_text(text: &str, use_reflow: bool) -> Estimated {
    let page_lines = prep_pages(text, use_reflow);
    let pixels = page_lines
        .iter()
        .map(|p| (PAGE_WIDTH * page_height(p.len())) as u64)
        .sum();
    Estimated {
        pages: page_lines.len(),
        pixels,
    }
}

/// Session convention: image tokens = round(pixels / 750).
pub fn image_tokens(pixels: u64) -> u64 {
    ((pixels as f64) / 750.0).round() as u64
}
