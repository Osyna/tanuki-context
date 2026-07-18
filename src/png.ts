//! Minimal grayscale PNG encoder (bit depth 8, color type 0), mirroring
//! pxpipe's png.ts: IHDR + one IDAT (zlib) + IEND, filter byte 0 per row.

import { deflateSync } from "node:zlib";

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/// Append a chunk (len BE + type + data + CRC over type||data) at `pos`.
function chunk(out: Uint8Array, pos: number, ty: string, data: Uint8Array): number {
  const len = data.length;
  out[pos] = (len >>> 24) & 0xff;
  out[pos + 1] = (len >>> 16) & 0xff;
  out[pos + 2] = (len >>> 8) & 0xff;
  out[pos + 3] = len & 0xff;
  const tyOff = pos + 4;
  for (let i = 0; i < 4; i++) out[tyOff + i] = ty.charCodeAt(i);
  out.set(data, tyOff + 4);
  let c = 0xffffffff;
  for (let i = tyOff; i < tyOff + 4 + len; i++) {
    c = TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  }
  c = ~c >>> 0;
  const crcOff = tyOff + 4 + len;
  out[crcOff] = (c >>> 24) & 0xff;
  out[crcOff + 1] = (c >>> 16) & 0xff;
  out[crcOff + 2] = (c >>> 8) & 0xff;
  out[crcOff + 3] = c & 0xff;
  return crcOff + 4;
}

/// Encode a `w x h` grayscale framebuffer as an 8-bit color-type-0 PNG.
export function encodeGray(pixels: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0, o = 0, s = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    raw.set(pixels.subarray(s, s + w), o);
    o += w;
    s += w;
  }
  const compressed: Uint8Array = deflateSync(raw, { level: 6 });
  const out = new Uint8Array(8 + 25 + (12 + compressed.length) + 12);
  out[0] = 0x89;
  out[1] = 0x50; // P
  out[2] = 0x4e; // N
  out[3] = 0x47; // G
  out[4] = 0x0d;
  out[5] = 0x0a;
  out[6] = 0x1a;
  out[7] = 0x0a;
  const ihdr = new Uint8Array(13);
  ihdr[0] = (w >>> 24) & 0xff;
  ihdr[1] = (w >>> 16) & 0xff;
  ihdr[2] = (w >>> 8) & 0xff;
  ihdr[3] = w & 0xff;
  ihdr[4] = (h >>> 24) & 0xff;
  ihdr[5] = (h >>> 16) & 0xff;
  ihdr[6] = (h >>> 8) & 0xff;
  ihdr[7] = h & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  let pos = chunk(out, 8, "IHDR", ihdr);
  pos = chunk(out, pos, "IDAT", compressed);
  chunk(out, pos, "IEND", new Uint8Array(0));
  return out;
}
