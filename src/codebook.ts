// Stage 0.5: in-image codebook (the "push base64 the right way" inversion).
//
// Under pixel pricing every atlas codepoint costs one cell, so a recurring
// long token or path prefix can be swapped for a single-cell sigil and the
// expansion carried once in a trailing `·legend·` line. Deterministic and
// inspectable — the model expands the sigils from the legend it can see, so
// nothing becomes model-only (the oversight property the base64 paper flags).
//
// Only whole tokens / path prefixes with a net-positive saving are chosen; a
// sigil already present in the source is skipped, so `sigil -> value` is an
// unambiguous inverse.

import { charCount, cmpCodepoints, isRustWhitespace } from "./serde.ts";

export const SIGILS = "§¤¢£¥µ¶ª°±¬×÷ØÞßæðøþ¡¿";
const MIN_LEN = 12;
const MIN_COUNT = 3;

export interface Codebook {
  text: string;
  entries: number;
}

export function apply(text: string): Codebook {
  const counts = new Map<string, number>();
  const bump = (k: string): void => {
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  const consider = (tok: string): void => {
    if (charCount(tok) >= MIN_LEN) bump(tok);
    if (tok.includes("/")) {
      // count every path prefix at a '/' boundary (>=3 segments deep)
      const segs = tok.split("/");
      let acc = "";
      for (let i = 0; i < segs.length; i++) {
        if (i > 0) acc += "/";
        acc += segs[i];
        if (i >= 2) {
          const pref = acc + "/";
          if (charCount(pref) >= MIN_LEN) bump(pref);
        }
      }
    }
  };
  // text.split(char::is_whitespace) — empty tokens are no-ops in both
  // branches, so scanning maximal non-whitespace runs is equivalent.
  let start = -1;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    if (isRustWhitespace(cp)) {
      if (start >= 0) {
        consider(text.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
    i += w;
  }
  if (start >= 0) consider(text.slice(start));

  // rank by chars saved = (len-1)*count; deterministic tie-break by value.
  const cands: { k: string; c: number; len: number; saved: number }[] = [];
  for (const [k, c] of counts) {
    if (c >= MIN_COUNT) {
      const len = charCount(k);
      cands.push({ k, c, len, saved: (len - 1) * c });
    }
  }
  cands.sort((a, b) => b.saved - a.saved || cmpCodepoints(a.k, b.k));

  const avail: string[] = [];
  for (const s of SIGILS) {
    if (!text.includes(s)) avail.push(s);
  }
  const chosen: { sig: string; val: string; len: number }[] = [];
  const used: string[] = [];
  for (const { k, c, len } of cands) {
    if (chosen.length >= avail.length) break;
    // net win must beat the legend cost (~len + sigil + '=' + space).
    if ((len - 1) * c <= len + 3) continue;
    // skip prefix-overlaps: a chosen key that contains/extends this one.
    let overlaps = false;
    for (let i = 0; i < used.length; i++) {
      const u = used[i];
      if (u.startsWith(k) || k.startsWith(u)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    const sig = avail[chosen.length];
    used.push(k);
    chosen.push({ sig, val: k, len });
  }

  if (chosen.length === 0) {
    return { text, entries: 0 };
  }

  // apply longest-first so a shorter key can't shadow a longer one.
  const order = chosen.map((_, i) => i);
  order.sort((a, b) => chosen[b].len - chosen[a].len); // stable, like sort_by_key
  let body = text;
  for (let n = 0; n < order.length; n++) {
    const { sig, val } = chosen[order[n]];
    body = body.replaceAll(val, sig);
  }

  let legend = "\n·legend· ";
  for (let i = 0; i < chosen.length; i++) {
    legend += chosen[i].sig + "=" + chosen[i].val + " ";
  }
  body += legend.slice(0, -1); // legend.trim_end() — sole trailing ws is our ' '
  return { text: body, entries: chosen.length };
}
