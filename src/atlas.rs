//! Full-BMP glyph atlas (Spleen 5x8 for ASCII/code + Unifont fallback),
//! extracted from pxpipe's generated gray atlas by `tools/gen-glyphs.mjs`.
//!
//! Codepoints + wide flags load eagerly (~175 KB, needed for wrap math);
//! coverage pixels stay zlib-packed in the binary and decompress lazily on
//! the first blit, so `estimate` never pays for them.

use std::sync::LazyLock;

pub const CELL_W: usize = 5;
pub const CELL_H: usize = 8;

static CPS_RAW: &[u8] = include_bytes!("../assets/glyphs.cps");
static WIDE: &[u8] = include_bytes!("../assets/glyphs.wide");
static PIX_Z: &[u8] = include_bytes!("../assets/glyphs.pix.z");

static CPS: LazyLock<Vec<u32>> = LazyLock::new(|| {
    CPS_RAW
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
});

/// Byte offset of each glyph's coverage run (prefix sum over wide flags).
static OFFSETS: LazyLock<Vec<u32>> = LazyLock::new(|| {
    let mut offsets = Vec::with_capacity(WIDE.len());
    let mut off = 0u32;
    for &w in WIDE {
        offsets.push(off);
        off += (if w == 1 { 2 * CELL_W } else { CELL_W } * CELL_H) as u32;
    }
    offsets
});

static PIXELS: LazyLock<Vec<u8>> = LazyLock::new(|| {
    miniz_oxide::inflate::decompress_to_vec_zlib(PIX_Z).expect("corrupt glyph atlas")
});

pub fn rank(cp: u32) -> Option<usize> {
    CPS.binary_search(&cp).ok()
}

pub fn is_wide(rank: usize) -> bool {
    WIDE[rank] == 1
}

/// AA coverage bytes for a glyph: `(2*)CELL_W x CELL_H`, row-major.
pub fn coverage(rank: usize) -> &'static [u8] {
    let off = OFFSETS[rank] as usize;
    let w = if is_wide(rank) { 2 * CELL_W } else { CELL_W };
    &PIXELS[off..off + w * CELL_H]
}
