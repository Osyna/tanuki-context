#!/usr/bin/env node
// Regenerate assets/glyphs.{cps,wide,pix.z} from pxpipe's generated gray atlas
// (full-BMP: Spleen 5x8 for ASCII/code + Unifont fallback, AA coverage cells).
// Run after any pxpipe atlas rebuild:
//   PXPIPE_DIST=~/Projects/pxpipe/dist node tools/gen-glyphs.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PXPIPE_DIST || path.join(process.env.HOME, "Projects", "pxpipe", "dist");
const g = await import(path.join(DIST, "core", "atlas-gray.js"));

const cw = g.ATLAS_GRAY_CELL_W, ch = g.ATLAS_GRAY_CELL_H;
if (cw !== 5 || ch !== 8) throw new Error(`unexpected cell ${cw}x${ch} — update CELL_W/CELL_H in src/atlas.rs`);

const n = g.ATLAS_GRAY_CODEPOINTS.length;
const cps = Buffer.alloc(n * 4);
const wide = Buffer.alloc(n);
let pixLen = 0;
for (let i = 0; i < n; i++) pixLen += (g.ATLAS_GRAY_WIDE_FLAGS[i] === 1 ? 2 * cw : cw) * ch;
const pix = Buffer.alloc(pixLen);

// Atlas codepoints are sorted; keep that order so Rust can binary-search and
// derive offsets by prefix sum over the wide flags.
let prev = -1, off = 0;
for (let i = 0; i < n; i++) {
  const cp = g.ATLAS_GRAY_CODEPOINTS[i];
  if (cp <= prev) throw new Error("codepoints not sorted — atlas format changed");
  prev = cp;
  cps.writeUInt32LE(cp, i * 4);
  const w = (g.ATLAS_GRAY_WIDE_FLAGS[i] === 1 ? 2 * cw : cw);
  wide[i] = g.ATLAS_GRAY_WIDE_FLAGS[i] === 1 ? 1 : 0;
  const src = g.ATLAS_GRAY_OFFSETS[i];
  for (let j = 0; j < w * ch; j++) pix[off + j] = g.ATLAS_GRAY_PIXELS[src + j];
  off += w * ch;
}

const out = path.join(HERE, "..", "assets");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "glyphs.cps"), cps);
writeFileSync(path.join(out, "glyphs.wide"), wide);
const z = deflateSync(pix, { level: 9 });
writeFileSync(path.join(out, "glyphs.pix.z"), z);
console.log(`glyphs: ${n} codepoints (${wide.filter ? [...wide].filter(Boolean).length : "?"} wide), pixels ${(pixLen / 1048576).toFixed(2)} MB -> ${(z.length / 1048576).toFixed(2)} MB zlib`);
