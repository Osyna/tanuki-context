//! Verbatim sidecar - byte-parity port of `src/needles.ts` (rationale lives
//! there). Same patterns in the same priority order, same overlap, dedupe
//! and cap rules. `(?-u)` forces ASCII `\b`/`\d` semantics to match JS.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub struct Needle {
    pub line: usize, // 1-based line in the text the pages carry
    pub value: String,
}

pub struct Sidecar {
    pub needles: Vec<Needle>,
    pub more: usize,
    pub text: String,
    pub tokens: u64,
}

pub const NEEDLE_CAP: usize = 32;

static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // uuid
        r"(?-u)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        // prefixed digest (sha256:..., md5:..., blake3:...)
        r"(?-u)\b(?:sha1|sha256|sha384|sha512|md5|blake2b|blake2s|blake3):[0-9a-fA-F]{8,128}",
        // 0x address / hash
        r"(?-u)\b0x[0-9a-fA-F]{8,64}\b",
        // stack frame path:line:col (needs a / or . in the path, so 09:30:00 stays a timestamp)
        r"(?-u)[A-Za-z0-9_./-]*[/.][A-Za-z0-9_.-]*:\d+:\d+",
        // bare hex run (request ids, short shas >= 12)
        r"(?-u)\b[0-9a-fA-F]{12,64}\b",
        // ipv4, optional :port
        r"(?-u)\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b",
        // version, optional prerelease (1.15.8-rc.3)
        r"(?-u)\b\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

pub fn scan_needles(text: &str) -> Sidecar {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut kept: Vec<Needle> = Vec::new();
    let mut more = 0usize;
    for (i, line) in text.split('\n').enumerate() {
        let mut claimed: Vec<(usize, usize)> = Vec::new();
        for pat in PATTERNS.iter() {
            for m in pat.find_iter(line) {
                let (at, end) = (m.start(), m.end());
                if claimed.iter().any(|&(a, b)| at < b && end > a) {
                    continue;
                }
                claimed.push((at, end));
                if seen.contains(m.as_str()) {
                    continue;
                }
                seen.insert(m.as_str());
                if kept.len() < NEEDLE_CAP {
                    kept.push(Needle { line: i + 1, value: m.as_str().to_string() });
                } else {
                    more += 1;
                }
            }
        }
    }
    if kept.is_empty() {
        return Sidecar { needles: Vec::new(), more: 0, text: String::new(), tokens: 0 };
    }
    kept.sort_by_key(|n| n.line); // stable, mirrors JS Array.sort
    let mut out = format!(
        "\u{b7}verbatim\u{b7} {} exact strings (read them here, not from pixels)",
        kept.len() + more
    );
    for n in &kept {
        out.push_str(&format!("\nL{} {}", n.line, n.value));
    }
    if more > 0 {
        out.push_str(&format!("\n\u{2026} +{more} more (needle-dense; keep the source as text)"));
    }
    let tokens = ((out.chars().count() as f64) / 4.0).round() as u64;
    Sidecar { needles: kept, more, text: out, tokens }
}

/// Credential refuse-to-render gate - byte-parity with `src/needles.ts`
/// `scanCredentials`. A block carrying a credential-shaped secret is never
/// imaged (a secret must not be silently misread from pixels); it stays text.
/// High-confidence formats only, so a false positive just keeps a block as
/// text. `(?-u)` matches JS `\b`/`\d` semantics.
static CREDENTIALS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("aws-key", r"(?-u)\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b"),
        ("gcp-key", r"(?-u)\bAIza[0-9A-Za-z_-]{35}\b"),
        ("github-token", r"(?-u)\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b"),
        ("github-pat", r"(?-u)\bgithub_pat_[0-9A-Za-z_]{82}\b"),
        ("slack-token", r"(?-u)\bxox[baprs]-[0-9A-Za-z-]{10,}"),
        ("stripe-key", r"(?-u)\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b"),
        ("api-key", r"(?-u)\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b"),
        ("private-key", r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
        ("jwt", r"(?-u)\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    ]
    .iter()
    .map(|(k, p)| (*k, Regex::new(p).unwrap()))
    .collect()
});

/// Distinct credential kinds found in `text`, sorted. Empty = safe to image.
pub fn scan_credentials(text: &str) -> Vec<String> {
    let mut kinds: Vec<String> = CREDENTIALS
        .iter()
        .filter(|(_, pat)| pat.is_match(text))
        .map(|(k, _)| (*k).to_string())
        .collect();
    kinds.sort();
    kinds
}
