#!/usr/bin/env node
// Regenerate assets/glyphs.{cps,wide,pix.z}:
//   1. BMP: pxpipe's generated gray atlas (Spleen 5x8 for ASCII/code + Unifont,
//      AA coverage cells) — pixel-faithful to pxpipe's production renderer.
//   2. Astral (U+10000..U+10FFFF, incl. emoji): GNU unifont_upper .hex bitmaps,
//      box-filtered from 16x16/8x16 1-bit to the same 10x8/5x8 AA cells.
//      This EXCEEDS pxpipe (which drops astral); auto-downloaded on first run.
// Run after a pxpipe atlas rebuild:
//   PXPIPE_DIST=~/Projects/pxpipe/dist node tools/gen-glyphs.mjs
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { deflateSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PXPIPE_DIST || path.join(process.env.HOME, "Projects", "pxpipe", "dist");
const UNIFONT_VERSION = "16.0.04";
const UPPER_HEX = path.join(HERE, "data", `unifont_upper-${UNIFONT_VERSION}.hex`);
const UPPER_URL = `https://unifoundry.com/pub/unifont/unifont-${UNIFONT_VERSION}/font-builds/unifont_upper-${UNIFONT_VERSION}.hex.gz`;

// ---- 1) BMP from pxpipe's gray atlas --------------------------------------
const g = await import(path.join(DIST, "core", "atlas-gray.js"));
const cw = g.ATLAS_GRAY_CELL_W, ch = g.ATLAS_GRAY_CELL_H;
if (cw !== 5 || ch !== 8) throw new Error(`unexpected cell ${cw}x${ch} — update CELL_W/CELL_H in src/atlas.rs`);

/** glyphs: Map cp -> { wide: bool, cov: Uint8Array((wide?2cw:cw)*ch) } */
const glyphs = new Map();
let prev = -1;
for (let i = 0; i < g.ATLAS_GRAY_CODEPOINTS.length; i++) {
  const cp = g.ATLAS_GRAY_CODEPOINTS[i];
  if (cp <= prev) throw new Error("pxpipe atlas codepoints not sorted — format changed");
  prev = cp;
  const wide = g.ATLAS_GRAY_WIDE_FLAGS[i] === 1;
  const w = wide ? 2 * cw : cw;
  const cov = new Uint8Array(w * ch);
  const src = g.ATLAS_GRAY_OFFSETS[i];
  for (let j = 0; j < w * ch; j++) cov[j] = g.ATLAS_GRAY_PIXELS[src + j];
  glyphs.set(cp, { wide, cov });
}
const bmpCount = glyphs.size;

// ---- 2) astral from unifont_upper .hex ------------------------------------
if (!existsSync(UPPER_HEX)) {
  console.log(`fetching ${UPPER_URL} ...`);
  const res = await fetch(UPPER_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} — place the file at ${UPPER_HEX} manually`);
  const gz = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(UPPER_HEX), { recursive: true });
  writeFileSync(UPPER_HEX, gunzipSync(gz));
}

/** Box-filter a 1-bit bitmap (srcW x 16) down to (dstW x 8) AA coverage. */
function downscale(bits, srcW, dstW) {
  const dstH = ch, srcH = 16;
  const out = new Uint8Array(dstW * dstH);
  const sx = srcW / dstW, sy = srcH / dstH;
  for (let ty = 0; ty < dstH; ty++) {
    for (let tx = 0; tx < dstW; tx++) {
      const x0 = tx * sx, x1 = x0 + sx, y0 = ty * sy, y1 = y0 + sy;
      let acc = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          acc += wx * wy * bits[yy * srcW + xx];
        }
      }
      out[ty * dstW + tx] = Math.round((acc / (sx * sy)) * 255);
    }
  }
  return out;
}

let astral = 0;
for (const line of readFileSync(UPPER_HEX, "utf8").split("\n")) {
  const m = line.match(/^([0-9A-Fa-f]{4,6}):([0-9A-Fa-f]+)$/);
  if (!m) continue;
  const cp = parseInt(m[1], 16);
  if (cp < 0x10000 || glyphs.has(cp)) continue; // astral only; pxpipe atlas wins
  const hex = m[2];
  const srcW = hex.length === 32 ? 8 : 16; // 2 or 4 hex digits per 16 rows
  const bits = new Uint8Array(srcW * 16);
  const digitsPerRow = hex.length / 16;
  for (let row = 0; row < 16; row++) {
    const bitsRow = parseInt(hex.slice(row * digitsPerRow, (row + 1) * digitsPerRow), 16);
    for (let x = 0; x < srcW; x++) bits[row * srcW + x] = (bitsRow >> (srcW - 1 - x)) & 1;
  }
  const wide = srcW === 16;
  glyphs.set(cp, { wide, cov: downscale(bits, srcW, wide ? 2 * cw : cw) });
  astral++;
}

// ---- 3) emit sorted --------------------------------------------------------
const cps = [...glyphs.keys()].sort((a, b) => a - b);
const cpsBuf = Buffer.alloc(cps.length * 4);
const wideBuf = Buffer.alloc(cps.length);
let pixLen = 0;
for (const cp of cps) pixLen += glyphs.get(cp).cov.length;
const pix = Buffer.alloc(pixLen);
let off = 0;
cps.forEach((cp, i) => {
  const { wide, cov } = glyphs.get(cp);
  cpsBuf.writeUInt32LE(cp, i * 4);
  wideBuf[i] = wide ? 1 : 0;
  pix.set(cov, off);
  off += cov.length;
});

const out = path.join(HERE, "..", "assets");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "glyphs.cps"), cpsBuf);
writeFileSync(path.join(out, "glyphs.wide"), wideBuf);
const z = deflateSync(pix, { level: 9 });
writeFileSync(path.join(out, "glyphs.pix.z"), z);
console.log(`glyphs: ${cps.length} codepoints (${bmpCount} BMP from pxpipe + ${astral} astral from unifont_upper), pixels ${(pixLen / 1048576).toFixed(2)} MB -> ${(z.length / 1048576).toFixed(2)} MB zlib`);
