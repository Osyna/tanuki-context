//! Minimal grayscale PNG encoder (bit depth 8, color type 0), mirroring
//! pxpipe's png.ts: IHDR + one IDAT (zlib) + IEND, filter byte 0 per row.

use miniz_oxide::deflate::compress_to_vec_zlib;

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

static TABLE: [u32; 256] = crc_table();

fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(ty);
    out.extend_from_slice(data);
    let mut c = 0xffff_ffffu32;
    for &b in ty.iter().chain(data.iter()) {
        c = TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    out.extend_from_slice(&(!c).to_be_bytes());
}

pub fn encode_gray_png(fb: &[u8], w: usize, h: usize) -> Vec<u8> {
    debug_assert_eq!(fb.len(), w * h);
    let mut raw = Vec::with_capacity(h * (w + 1));
    for y in 0..h {
        raw.push(0); // filter: none
        raw.extend_from_slice(&fb[y * w..(y + 1) * w]);
    }
    let compressed = compress_to_vec_zlib(&raw, 6);
    let mut out = Vec::with_capacity(compressed.len() + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&(w as u32).to_be_bytes());
    ihdr[4..8].copy_from_slice(&(h as u32).to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grayscale
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &compressed);
    chunk(&mut out, b"IEND", &[]);
    out
}
