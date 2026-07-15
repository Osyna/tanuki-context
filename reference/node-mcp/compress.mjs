// Graded text compression for the pxpipe MCP.
//
// Levels form a ladder — each ⊇ the previous. Higher = more tokens saved = more
// fidelity loss. The caller (a model or a human) picks the tradeoff by `level`.
//
// EXACT-RECALL GUARD: from level 2 up, any line that looks like code/data or
// carries a structured token (hash, path, URL, base64, long id) is passed
// through VERBATIM. pxpipe's promise is that exact strings survive — lossy
// prose tightening never touches them. For byte-exact recall of bulk, image it
// with pxpipe_render instead (imaging keeps the source reconstructable).

export const LEVELS = [
  { n: 0, name: "none",       loss: "none",     desc: "passthrough (baseline)" },
  { n: 1, name: "whitespace", loss: "lossless", desc: "trailing whitespace + blank-line runs collapsed; safe for code" },
  { n: 2, name: "prose",      loss: "light",    desc: "L1 + prose lines: collapse spaces, cut redundant filler phrases (code/IDs protected)" },
  { n: 3, name: "dense",      loss: "medium",   desc: "L2 + prose: drop articles & intensifiers" },
  { n: 4, name: "caveman",    loss: "heavy",    desc: "L3 + prose: telegraphic — drop function words; gist only, NOT verbatim" },
];

// L2: redundant multi-word phrases -> shorter equivalents (meaning-preserving).
const FILLER = [
  [/\bin order to\b/gi, "to"], [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"], [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "for"], [/\bwith regard to\b/gi, "about"],
  [/\ba large number of\b/gi, "many"], [/\bit is important to note that\b/gi, ""],
  [/\bplease note that\b/gi, ""], [/\bas a matter of fact\b/gi, ""],
  [/\bin terms of\b/gi, "for"], [/\bthe fact that\b/gi, "that"],
];
// L3: low-information determiners/adverbs.
const ARTICLES = /\b(the|an|a)\s+/gi;
const INTENSIFIERS = /\b(very|really|just|actually|basically|simply|quite|rather|essentially|literally)\s+/gi;
// L4: copula, auxiliaries, light prepositions/determiners — telegraphic, gist-only.
const FUNCTION_WORDS = /\b(is|are|was|were|am|be|been|being|do|does|did|have|has|had|will|would|shall|should|can|could|may|might|of|to|in|on|at|for|with|that|this|these|those|it|its|there|here)\b\s*/gi;

/** A line that must be preserved verbatim (never reworded): indented (code),
 *  symbol-dense (code/JSON), or carrying a long whitespace-free token
 *  (hash/path/URL/base64/id). */
export function isProtectedLine(line) {
  if (/^\s/.test(line)) return true;
  const sym = (line.match(/[^\sA-Za-z0-9.,;:'"!?()\-]/g) || []).length;
  if (sym / (line.length || 1) > 0.3) return true;
  return line.split(/\s+/).some((t) => t.length >= 24);
}

function tightenProse(line, level) {
  let s = line.replace(/ {2,}/g, " ");
  for (const [re, to] of FILLER) s = s.replace(re, to);            // L2
  if (level >= 3) s = s.replace(ARTICLES, "").replace(INTENSIFIERS, "");
  if (level >= 4) s = s.replace(FUNCTION_WORDS, "");
  s = s.replace(/ {2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return s.replace(/^([a-z])/, (c) => c.toUpperCase()); // re-cap sentence start
}

/** Compress `text` at `level` (0-4). Returns { compressed, protectedLines, level }. */
export function compressText(text, level = 1) {
  level = Math.max(0, Math.min(4, Number(level) | 0));
  if (level === 0) return { compressed: text, protectedLines: 0, level };
  let protectedLines = 0;
  const lines = text.split("\n").map((raw) => {
    const line = raw.replace(/[ \t]+$/, ""); // trailing-ws strip: every level ≥1
    if (level === 1) return line;
    if (isProtectedLine(line)) { protectedLines++; return line; }
    return tightenProse(line, level);
  });
  return { compressed: lines.join("\n").replace(/\n{3,}/g, "\n\n"), protectedLines, level };
}
