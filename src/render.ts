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

import { CELL_H, CELL_W, coverage, coverageScaled, isWide, rank } from "./atlas.ts";
import { encodeGray } from "./png.ts";

export const PAD_X = 4;
export const PAD_Y = 4;
export const MAX_WIDTH_PX = 1568; // Anthropic no-resample bound
export const MAX_HEIGHT_PX = 728;

export const NL_SENTINEL = "\u21B5"; // ↵ inserted for original hard newlines
export const NL_LITERAL = "\u23CE"; // ⏎ stands in for pre-existing ↵ in source
const TAB_MARK = "\u2192"; // → visible tab marker
const TAB_LITERAL = "\u21E2"; // ⇢ stands in for pre-existing → (pack mode)
const INDENT_MARK = "\u21E5"; // ⇥ leading-indent run-length header (pack mode)
const INDENT_LITERAL = "\u21E8"; // ⇨ stands in for pre-existing ⇥ (pack mode)
const FALLBACK_CP = 0x25af; // ▯ for codepoints absent from the atlas (unassigned)
const TAB_WIDTH = 4;
const MIN_INDENT = 3; // shorter runs aren't worth a 2-char code
// 62 count symbols: an indent run of N spaces (3..=61) -> INDENT_MARK + ALPHABET[N].
export const INDENT_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const NL4 = /\n{4,}/g;

export type Font = "normal" | "tiny";

export function parseFont(s: string): Font {
  // Rust eq_ignore_ascii_case: fold ASCII letters only.
  return s.length === 4 && s.replace(/[A-Z]/g, (c) => c.toLowerCase()) === "tiny"
    ? "tiny"
    : "normal";
}

/// Cell dimensions and page grid for a font.
export interface Geom {
  cw: number;
  ch: number;
  cols: number;
  maxLines: number;
  maxChars: number;
}

export function geom(font: Font): Geom {
  const cw = font === "tiny" ? 4 : CELL_W;
  const ch = font === "tiny" ? 6 : CELL_H;
  const cols = Math.floor((MAX_WIDTH_PX - 2 * PAD_X) / cw);
  const maxLines = Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ch);
  return { cw, ch, cols, maxLines, maxChars: cols * maxLines };
}

// Wrap math is hot: precompute cell widths for the ASCII range once.
const ASCII_CELLS: Uint8Array = (() => {
  const t = new Uint8Array(128);
  for (let cp = 0; cp < 128; cp++) {
    const r = rank(cp);
    t[cp] = r >= 0 && isWide(r) ? 2 : 1;
  }
  return t;
})();

/// Cells a codepoint occupies (pxpipe cellsFor): wide glyphs take 2,
/// missing codepoints advance 1 for wrap stability.
function cellsFor(cp: number): number {
  if (cp < 128) return ASCII_CELLS[cp];
  const r = rank(cp);
  return r >= 0 && isWide(r) ? 2 : 1;
}

/// Codepoint count (Rust chars().count()).
function cpCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) i++;
    }
    n++;
  }
  return n;
}

/// Strip trailing spaces/tabs per line, collapse 4+ consecutive \n to 3
/// (pxpipe minifyForRender).
export function minify(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let e = l.length;
    while (e > 0) {
      const c = l.charCodeAt(e - 1);
      if (c !== 0x20 && c !== 0x09) break;
      e--;
    }
    if (e !== l.length) lines[i] = l.slice(0, e);
  }
  return lines.join("\n").replace(NL4, "\n\n\n");
}

/// Expand tabs to 4-col stops: '→' marker + spaces (pxpipe expandTabsInLine).
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const span = TAB_WIDTH - (col % TAB_WIDTH);
      out += TAB_MARK;
      for (let i = 1; i < span; i++) out += " ";
      col += span;
    } else {
      out += ch;
      col += cellsFor(ch.codePointAt(0)!);
    }
  }
  return out;
}

/// Pack a single line: every tab -> single '→' cell (no 4-col padding), then
/// run-length the leading-space run (`⇥` + one count symbol). Lossless; the
/// inverse is `⇥X` -> X spaces, `→` -> tab.
function packLine(line: string): string {
  const tabbed = line.includes("\t") ? line.replaceAll("\t", TAB_MARK) : line;
  let indent = 0;
  while (indent < tabbed.length && tabbed.charCodeAt(indent) === 0x20) indent++;
  if (indent >= MIN_INDENT && indent < INDENT_ALPHABET.length) {
    // leading run is ASCII spaces -> UTF-16 index == codepoint index
    return INDENT_MARK + INDENT_ALPHABET[indent] + tabbed.slice(indent);
  }
  return tabbed;
}

/// Swap pre-existing ↵ for ⏎ so reflow can pack newlines (render-prep only).
export function neutralize(text: string): string {
  return text.includes(NL_SENTINEL) ? text.replaceAll(NL_SENTINEL, NL_LITERAL) : text;
}

/// Pack-mode neutralize: also protect pre-existing `→`/`⇥` (they become
/// meaningful sentinels after packing) so reconstruction stays exact.
export function neutralizePack(text: string): string {
  let s = neutralize(text);
  if (s.includes(TAB_MARK)) s = s.replaceAll(TAB_MARK, TAB_LITERAL);
  if (s.includes(INDENT_MARK)) s = s.replaceAll(INDENT_MARK, INDENT_LITERAL);
  return s;
}

/// Minify + expand tabs + join hard newlines with the ↵ sentinel.
/// Call after `neutralize` so the join can never collide.
export function reflow(text: string): string {
  const lines = minify(text).split("\n");
  for (let i = 0; i < lines.length; i++) lines[i] = expandTabs(lines[i]);
  return lines.join(NL_SENTINEL);
}

/// Pack-mode reflow: single-cell tabs + indent RLE, then ↵-join.
/// Call after `neutralizePack`.
export function reflowPack(text: string): string {
  const lines = minify(text).split("\n");
  for (let i = 0; i < lines.length; i++) lines[i] = packLine(lines[i]);
  return lines.join(NL_SENTINEL);
}

/// Wrap to `cols` cells per row, by codepoint (pxpipe wrapLines).
export function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  const minified = minify(text);
  for (const rawLine of minified.split("\n")) {
    const line = expandTabs(rawLine);
    if (line.length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    let curCols = 0;
    for (const ch of line) {
      const w = cellsFor(ch.codePointAt(0)!);
      if (curCols + w > cols) {
        out.push(cur);
        cur = ch;
        curCols = w;
      } else {
        cur += ch;
        curCols += w;
      }
    }
    if (cur.length !== 0) out.push(cur);
  }
  return out;
}

/// Split wrapped lines into pages of <= maxLines rows and <= maxChars chars
/// (pxpipe splitWrappedLinesIntoReadablePages).
export function splitPages(lines: string[], maxLines: number, maxChars: number): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const line of lines) {
    const n = cpCount(line);
    const lineChars = n + (cur.length !== 0 ? 1 : 0);
    if (cur.length !== 0 && (cur.length >= maxLines || curChars + lineChars > maxChars)) {
      pages.push(cur);
      cur = [];
      curChars = 0;
    }
    curChars += n + (cur.length !== 0 ? 1 : 0);
    cur.push(line);
  }
  if (cur.length !== 0) pages.push(cur);
  return pages;
}

/// Shared front half of render/estimate: (neutralize -> reflow ->) wrap -> page.
function prepPages(text: string, useReflow: boolean, pack: boolean, g: Geom): string[][] {
  const prepped = useReflow
    ? pack
      ? reflowPack(neutralizePack(text))
      : reflow(neutralize(text))
    : text;
  return splitPages(wrapLines(prepped, g.cols), g.maxLines, g.maxChars);
}

/// Page pixel width: full (pxpipe) unless `pack`, then trimmed to the widest
/// row actually present (capped at the column bound). Pure geometry — lossless.
function pageWidth(lines: string[], g: Geom, pack: boolean): number {
  if (!pack) return 2 * PAD_X + g.cols * g.cw;
  let maxCells = 0;
  for (const l of lines) {
    let cells = 0;
    for (const ch of l) cells += cellsFor(ch.codePointAt(0)!);
    if (cells > g.cols) cells = g.cols;
    if (cells > maxCells) maxCells = cells;
  }
  const w = 2 * PAD_X + maxCells * g.cw;
  const min = 2 * PAD_X + g.cw;
  return w > min ? w : min;
}

export interface Page {
  png: Uint8Array;
  width: number;
  height: number;
  dropped: number;
}

// Tiny-font glyphs are box-filtered from the 5x8 atlas; cache per rank
// (the destination cell is fixed per font, so rank alone keys the result).
const scaledCache = new Map<number, Uint8Array>();

/// Blit one glyph's AA coverage (max blend) at pixel position; returns cells advanced.
function blit(
  fb: Uint8Array,
  fbW: number,
  x: number,
  y: number,
  cp: number,
  g: Geom,
  font: Font,
): number {
  const r = rank(cp);
  if (r < 0) return 0;
  const wide = isWide(r);
  const dstW = wide ? 2 * g.cw : g.cw;
  let cov: Uint8Array;
  if (font === "normal") {
    cov = coverage(r);
  } else {
    let scaled = scaledCache.get(r);
    if (scaled === undefined) {
      scaled = coverageScaled(r, dstW, g.ch);
      scaledCache.set(r, scaled);
    }
    cov = scaled;
  }
  for (let gy = 0; gy < g.ch; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const srcRow = gy * dstW;
    for (let gx = 0; gx < dstW; gx++) {
      const c = cov[srcRow + gx];
      if (c > 0) {
        const idx = dstRow + gx;
        if (c > fb[idx]) fb[idx] = c;
      }
    }
  }
  return wide ? 2 : 1;
}

/// Render one page of wrapped lines to a grayscale PNG (black-on-white).
function renderPage(lines: string[], g: Geom, pack: boolean, font: Font): Page {
  const width = pageWidth(lines, g, pack);
  const height = 2 * PAD_Y + lines.length * g.ch;
  const fb = new Uint8Array(width * height);
  let dropped = 0;
  for (let row = 0; row < lines.length; row++) {
    const baseY = PAD_Y + row * g.ch;
    let col = 0;
    for (const ch of lines[row]) {
      if (col >= g.cols) break;
      const baseX = PAD_X + col * g.cw;
      let advance = blit(fb, width, baseX, baseY, ch.codePointAt(0)!, g, font);
      if (advance === 0) {
        dropped++;
        if (ch !== " ") blit(fb, width, baseX, baseY, FALLBACK_CP, g, font);
        advance = 1;
      }
      col += advance;
    }
  }
  for (let i = 0; i < fb.length; i++) {
    fb[i] = 255 - fb[i]; // invert: black ink on white paper
  }
  return { png: encodeGray(fb, width, height), width, height, dropped };
}

export interface Rendered {
  pages: Page[];
  pixels: number;
  dropped: number;
}

/// Full stage 2: prep + blit + PNG encode.
export function renderText(text: string, useReflow: boolean, pack: boolean, font: Font): Rendered {
  const g = geom(font);
  const pages = prepPages(text, useReflow, pack, g).map((p) => renderPage(p, g, pack, font));
  let pixels = 0;
  let dropped = 0;
  for (const p of pages) {
    pixels += p.width * p.height;
    dropped += p.dropped;
  }
  return { pages, pixels, dropped };
}

export interface Estimated {
  pages: number;
  pixels: number;
}

/// Same geometry as renderText without blitting/encoding — exact, fast,
/// and never touches the (lazily decompressed) pixel data.
export function estimateText(
  text: string,
  useReflow: boolean,
  pack: boolean,
  font: Font,
): Estimated {
  const g = geom(font);
  const pageLines = prepPages(text, useReflow, pack, g);
  let pixels = 0;
  for (const p of pageLines) {
    pixels += pageWidth(p, g, pack) * (2 * PAD_Y + p.length * g.ch);
  }
  return { pages: pageLines.length, pixels };
}

/// Session convention: image tokens = round(pixels / 750).
export function imageTokens(pixels: number): number {
  return Math.round(pixels / 750);
}
