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

/// Box-filter a glyph's native coverage down to an arbitrary `dst_w x dst_h`
/// cell (area-weighted average). Used by the experimental tiny (4x6) font.
pub fn coverage_scaled(rank: usize, dst_w: usize, dst_h: usize) -> Vec<u8> {
    let cov = coverage(rank);
    let sw = if is_wide(rank) { 2 * CELL_W } else { CELL_W };
    box_resample(cov, sw, CELL_H, dst_w, dst_h)
}

fn box_resample(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh];
    let (fx, fy) = (sw as f64 / dw as f64, sh as f64 / dh as f64);
    for dy in 0..dh {
        let (y0, y1) = (dy as f64 * fy, (dy + 1) as f64 * fy);
        for dx in 0..dw {
            let (x0, x1) = (dx as f64 * fx, (dx + 1) as f64 * fx);
            let (mut acc, mut wsum) = (0.0f64, 0.0f64);
            for sy in y0.floor() as usize..(y1.ceil() as usize).min(sh) {
                let wy = ((sy + 1) as f64).min(y1) - (sy as f64).max(y0);
                if wy <= 0.0 {
                    continue;
                }
                for sx in x0.floor() as usize..(x1.ceil() as usize).min(sw) {
                    let wx = ((sx + 1) as f64).min(x1) - (sx as f64).max(x0);
                    if wx <= 0.0 {
                        continue;
                    }
                    let w = wx * wy;
                    acc += w * src[sy * sw + sx] as f64;
                    wsum += w;
                }
            }
            out[dy * dw + dx] = if wsum > 0.0 {
                (acc / wsum).round().clamp(0.0, 255.0) as u8
            } else {
                0
            };
        }
    }
    out
}
