// Decode the grayscale filter-0 PNGs both engines emit, so pages can be
// compared by PIXELS rather than by compressed bytes.
//
// This matters and was duplicated in parity-ts.mjs and proxy-parity.mjs: the TS
// and Rust zlib encoders produce different IDAT bytes for identical pixels, so
// a byte comparison of two correct renders FAILS. Anyone re-deriving the check
// without knowing that either reports a phantom parity break or, worse,
// "fixes" it by loosening the comparison to something meaningless.

import { inflateSync } from "node:zlib";

/** `Buffer` of a grayscale filter-0 PNG -> `{ w, h, px }` raw pixel bytes. */
export function pngPixels(buf) {
  let off = 8;
  const idat = [];
  let w = 0;
  let h = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      w = buf.readUInt32BE(off + 8);
      h = buf.readUInt32BE(off + 12);
    }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w + 1)] !== 0) throw new Error(`non-zero PNG filter at row ${y}`);
    raw.copy(px, y * w, y * (w + 1) + 1, (y + 1) * (w + 1));
  }
  return { w, h, px };
}

/** True when two base64 PNGs are pixel-identical (geometry included). */
export function pixelEqual(b64a, b64b) {
  const a = pngPixels(Buffer.from(b64a, "base64"));
  const b = pngPixels(Buffer.from(b64b, "base64"));
  return a.w === b.w && a.h === b.h && a.px.equals(b.px);
}
