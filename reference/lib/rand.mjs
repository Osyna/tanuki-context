// Seeded randomness shared by every harness. `lcg` was copy-pasted into six
// reports and `hex` into five; they were byte-identical apart from one being
// written on a single line, so unifying them changes no output. Every fixture
// in this repo is seeded on purpose: a harness whose corpus moves between runs
// cannot be used to compare two engines or two releases.

/** Numerical Recipes LCG. Same constants in every historical copy. */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** `n` lowercase hex chars drawn from `r`. */
export const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[(r() * 16) | 0]).join("");

/** The service-unit vocabulary every synthetic log draws from. */
export const UNITS = ["api-gateway", "worker", "scheduler", "ingest", "cache", "relay"];
