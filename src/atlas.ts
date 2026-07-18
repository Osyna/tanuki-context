//! Full-BMP glyph atlas (Spleen 5x8 for ASCII/code + Unifont fallback),
//! extracted from pxpipe's generated gray atlas by `tools/gen-glyphs.mjs`.
//!
//! Codepoints + wide flags load eagerly (~175 KB, needed for wrap math);
//! coverage pixels stay zlib-packed on disk and decompress lazily on the
//! first blit, so `estimate` never pays for them.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export const CELL_W = 5;
export const CELL_H = 8;

const CPS_RAW: Uint8Array = readFileSync(new URL("../assets/glyphs.cps", import.meta.url));
const WIDE: Uint8Array = readFileSync(new URL("../assets/glyphs.wide", import.meta.url));

/// Little-endian u32 view over the codepoint table (copy only if unaligned).
const CPS: Uint32Array = (() => {
  const n = CPS_RAW.byteLength >>> 2;
  if ((CPS_RAW.byteOffset & 3) === 0) {
    return new Uint32Array(CPS_RAW.buffer, CPS_RAW.byteOffset, n);
  }
  return new Uint32Array(
    CPS_RAW.buffer.slice(CPS_RAW.byteOffset, CPS_RAW.byteOffset + (n << 2)),
  );
})();

/// Byte offset of each glyph's coverage run (prefix sum over wide flags).
const OFFSETS: Uint32Array = (() => {
  const offsets = new Uint32Array(WIDE.length);
  let off = 0;
  for (let i = 0; i < WIDE.length; i++) {
    offsets[i] = off;
    off += (WIDE[i] === 1 ? 2 * CELL_W : CELL_W) * CELL_H;
  }
  return offsets;
})();

/// Lazily inflated AA coverage bytes for all glyphs, concatenated.
let PIXELS: Uint8Array | null = null;

/// Binary-search the sorted codepoint table; -1 if absent (Rust: Option).
export function rank(cp: number): number {
  let lo = 0;
  let hi = CPS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = CPS[mid];
    if (v < cp) lo = mid + 1;
    else if (v > cp) hi = mid - 1;
    else return mid;
  }
  return -1;
}

export function isWide(rank: number): boolean {
  return WIDE[rank] === 1;
}

/// AA coverage bytes for a glyph: `(2*)CELL_W x CELL_H`, row-major.
export function coverage(rank: number): Uint8Array {
  if (PIXELS === null) {
    PIXELS = inflateSync(readFileSync(new URL("../assets/glyphs.pix.z", import.meta.url)));
  }
  const off = OFFSETS[rank];
  const w = isWide(rank) ? 2 * CELL_W : CELL_W;
  return PIXELS.subarray(off, off + w * CELL_H);
}

/// Box-filter a glyph's native coverage down to an arbitrary `dw x dh`
/// cell (area-weighted average). Used by the experimental tiny (4x6) font.
export function coverageScaled(rank: number, dw: number, dh: number): Uint8Array {
  const cov = coverage(rank);
  const sw = isWide(rank) ? 2 * CELL_W : CELL_W;
  return boxResample(cov, sw, CELL_H, dw, dh);
}

function boxResample(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * fy;
    const y1 = (dy + 1) * fy;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * fx;
      const x1 = (dx + 1) * fx;
      let acc = 0;
      let wsum = 0;
      const syEnd = Math.min(Math.ceil(y1), sh);
      for (let sy = Math.floor(y0); sy < syEnd; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        const sxEnd = Math.min(Math.ceil(x1), sw);
        for (let sx = Math.floor(x0); sx < sxEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          acc += w * src[sy * sw + sx];
          wsum += w;
        }
      }
      out[dy * dw + dx] =
        wsum > 0 ? Math.min(255, Math.max(0, Math.round(acc / wsum))) : 0;
    }
  }
  return out;
}
