//! Verbatim sidecar - byte-parity port of `src/needles.ts` (rationale lives
//! there). Same patterns in the same priority order, same overlap, dedupe
//! and cap rules. `(?-u)` forces ASCII `\b`/`\d` semantics to match JS.
//!
//! Token scanning walks byte offsets while every length test counts CHARS,
//! so a non-ASCII line agrees with the UTF-16 indices JS uses. Trims stop
//! only on ASCII bytes, so every slice lands on a char boundary.

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
    pub dense: bool, // more > 0: too many exact strings to carry - keep as text
    pub text: String,
    pub tokens: u64,
}

pub const NEEDLE_CAP_MIN: usize = 32;
pub const NEEDLE_CAP_MAX: usize = 512;

/// Scales with the block: a flat 32 truncated ordinary pages instead of only
/// hash-dense ones (EVALS section 7). Overflow sets `dense`.
pub fn needle_cap(lines: usize) -> usize {
    if lines < NEEDLE_CAP_MIN {
        NEEDLE_CAP_MIN
    } else if lines > NEEDLE_CAP_MAX {
        NEEDLE_CAP_MAX
    } else {
        lines
    }
}

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

/// Recoverable from sequence or format. Words are deliberately absent - a
/// blanket `^[A-Za-z]+$` would wave through every random alphabetic id.
static RECOVERABLE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?-u)^[0-9]+(?:\.[0-9]+)?(?:ns|us|ms|s|m|h|d|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|%)$",
        r"(?-u)^(?:[0-9]+h)?(?:[0-9]+m)?[0-9]+(?:\.[0-9]+)?s$",
        r"(?-u)^[0-9]{4}-[0-9]{2}-[0-9]{2}[0-9A-Za-z:.+-]*$",
        r"(?-u)^[0-9]{2}:[0-9]{2}:[0-9]{2}[0-9.,]*$",
        r"(?-u)^[vV]?[0-9]+(?:[._][0-9]+)+$",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

static RE_MAC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$").unwrap());
static RE_HEXGROUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)^(?:[0-9a-fA-F]{4,}[:-])+[0-9a-fA-F]{4,}$").unwrap());
static RE_B64: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)^[A-Za-z0-9+/]{16,}={0,2}$").unwrap());

/// True when losing one character of `v` would be both silent and unfixable.
pub fn at_risk(v: &str) -> bool {
    let n = v.chars().count();
    if n < 6 {
        return false;
    }
    let mut digits = 0usize;
    let mut lower = false;
    let mut upper = false;
    let mut hexish = true;
    let mut flips = 0usize;
    let mut prev = false;
    for (k, c) in v.chars().enumerate() {
        let d = c.is_ascii_digit();
        if d {
            digits += 1;
        } else if c.is_ascii_lowercase() {
            lower = true;
        } else if c.is_ascii_uppercase() {
            upper = true;
        }
        if !(d || matches!(c, 'a'..='f' | 'A'..='F')) {
            hexish = false;
        }
        if k > 0 && d != prev {
            flips += 1;
        }
        prev = d;
    }
    if digits == n {
        return n >= 9; // small ints recover from context, long ids do not
    }
    if hexish {
        return true; // hex run >= 6: git short sha, request id
    }
    for p in RECOVERABLE.iter() {
        if p.is_match(v) {
            return false;
        }
    }
    if RE_MAC.is_match(v) || RE_HEXGROUP.is_match(v) {
        return true;
    }
    if digits > 0 && upper && lower && RE_B64.is_match(v) {
        return true;
    }
    // Segment scan: a long alnum run mixing letters and digits, or a long
    // alphabetic run that is not a word. Words alternate vowels and
    // consonants; random letters pile up.
    let chars: Vec<char> = v.chars().collect();
    let mut s = 0usize;
    while s < n {
        while s < n && !chars[s].is_ascii_alphanumeric() {
            s += 1;
        }
        let mut e = s;
        let mut seg_digits = 0usize;
        let mut seg_alpha = 0usize;
        let mut vowels = 0usize;
        let mut run = 0usize;
        let mut max_run = 0usize;
        while e < n && chars[e].is_ascii_alphanumeric() {
            let c = chars[e];
            if c.is_ascii_digit() {
                seg_digits += 1;
            } else {
                seg_alpha += 1;
                match c.to_ascii_lowercase() {
                    'a' | 'e' | 'i' | 'o' | 'u' | 'y' => {
                        vowels += 1;
                        run = 0;
                    }
                    _ => {
                        run += 1;
                        if run > max_run {
                            max_run = run;
                        }
                    }
                }
            }
            e += 1;
        }
        let len = e - s;
        if len >= 8 && seg_digits > 0 && seg_alpha > 0 {
            return true;
        }
        if len >= 8 && seg_digits == 0 && (max_run >= 5 || vowels * 100 < len * 15) {
            return true;
        }
        s = e;
    }
    // generic, no named format: interleaved alnum - pod, build, container ids
    n >= 10 && digits > 0 && (upper || lower) && flips >= 3
}

/// At-risk whole-token byte spans in `line`, left to right. Whitespace
/// delimited, `key=value` reduced to the value, wrapping punctuation trimmed.
fn risky_tokens(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let n = b.len();
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut i = 0usize;
    while i < n {
        while i < n && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut j = i;
        while j < n && b[j] != b' ' && b[j] != b'\t' {
            j += 1;
        }
        let mut eq: Option<usize> = None;
        for k in i..j {
            if b[k] == b'=' {
                eq = Some(k);
            }
        }
        let mut s = match eq {
            Some(k) if k > i && j - (k + 1) >= 6 => k + 1,
            _ => i,
        };
        let mut e = j;
        while s < e && !b[s].is_ascii_alphanumeric() {
            s += 1;
        }
        // `=` `+` `/` survive the trailing trim so base64 padding stays intact
        while e > s && !(b[e - 1].is_ascii_alphanumeric() || b[e - 1] == b'=' || b[e - 1] == b'+' || b[e - 1] == b'/') {
            e -= 1;
        }
        if e > s && at_risk(&line[s..e]) {
            out.push((s, e));
        }
        i = j;
    }
    out
}

pub fn scan_needles(text: &str) -> Sidecar {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut kept: Vec<Needle> = Vec::new();
    let mut more = 0usize;
    let lines: Vec<&str> = text.split('\n').collect();
    let cap = needle_cap(lines.len());
    for (i, line) in lines.iter().enumerate() {
        let line: &str = line;
        let mut claimed: Vec<(usize, usize)> = Vec::new();
        // Whole-token pass first: an at-risk token ships entire, so a pattern
        // matching only its middle cannot ship a fragment that reads as safe.
        for (at, end) in risky_tokens(line) {
            claimed.push((at, end));
            let v = &line[at..end];
            if seen.contains(v) {
                continue;
            }
            seen.insert(v);
            if kept.len() < cap {
                kept.push(Needle { line: i + 1, value: v.to_string() });
            } else {
                more += 1;
            }
        }
        // Then the named-format allowlist, for matches inside ordinary tokens.
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
                if kept.len() < cap {
                    kept.push(Needle { line: i + 1, value: m.as_str().to_string() });
                } else {
                    more += 1;
                }
            }
        }
    }
    if kept.is_empty() {
        return Sidecar { needles: Vec::new(), more: 0, dense: false, text: String::new(), tokens: 0 };
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
    Sidecar { needles: kept, more, dense: more > 0, text: out, tokens }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// EVALS section 7: the allowlist carried 30.9% of unrecoverable ids on
    /// 19.7 MB of real logs. These are the families it missed.
    #[test]
    fn ids_with_no_named_format_still_ride_as_text() {
        for (id, line) in [
            ("86:2b:11:51:58:03", "relay dest=86:2b:11:51:58:03 unreachable"),
            ("6c9224c", "merged 6c9224c into main"),
            ("1022:14e5", "device 1022:14e5 bound to amdgpu"),
            ("api-worker-7d9f8b6c4-x2ktp", "pod api-worker-7d9f8b6c4-x2ktp evicted"),
            ("aGVsbG8gd29ybGQxMjM0NTY3", "body aGVsbG8gd29ybGQxMjM0NTY3 sent"),
            ("ryvkuvrdmg", "ref=ryvkuvrdmg failed"),
            ("YHFJNKGNSMTQBWC", "ref=YHFJNKGNSMTQBWC failed"),
            ("ORD-5171-JRUBJMGB", "order ORD-5171-JRUBJMGB shipped"),
        ] {
            assert!(scan_needles(line).text.contains(id), "missed {id}");
        }
    }

    /// The other half: ordinary prose must stay out or the sidecar bloats.
    #[test]
    fn words_durations_and_timestamps_stay_out() {
        for line in [
            "systemd-udev-load-credentials.service started successfully",
            "upstream.protocol negotiated background filesystem throughput",
            "lastseen=34m51s lastRecv=35m44s latency=14ms conn=3",
            "installed ocean-sound-theme noto-fonts-emoji lib32-libunistring",
        ] {
            assert!(scan_needles(line).needles.is_empty(), "false needle in {line}");
        }
    }

    #[test]
    fn cap_scales_with_block_and_density_announces_itself() {
        let ids: Vec<String> = (0..NEEDLE_CAP_MIN + 8)
            .map(|i| format!("id={:04}deadbeef4f3a", i))
            .collect();
        let per_line = scan_needles(&ids.join("\n"));
        assert_eq!(per_line.needles.len(), NEEDLE_CAP_MIN + 8);
        assert_eq!(per_line.more, 0);
        assert!(!per_line.dense);
        let crammed = scan_needles(&ids.join(" "));
        assert_eq!(crammed.needles.len(), NEEDLE_CAP_MIN);
        assert_eq!(crammed.more, 8);
        assert!(crammed.dense);
    }
}
