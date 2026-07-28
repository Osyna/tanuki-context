//! Verbatim sidecar - byte-parity port of `src/needles.ts` (rationale lives
//! there). Same patterns in the same priority order, same overlap, dedupe
//! and cap rules. `(?-u)` forces ASCII `\b`/`\d` semantics to match JS.
//!
//! Token scanning walks byte offsets while every length test counts CHARS,
//! so a non-ASCII line agrees with the UTF-16 indices JS uses. Trims stop
//! only on ASCII bytes, so every slice lands on a char boundary.

use regex::Regex;
use serde_json::Value;
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

/// The sidecar is tri-state on the wire. Measured on a 1200-line service log:
/// the sidecar is 5,611 tokens of a 13,213-token render (42%), and 1,199 of
/// its 1,239 strings are irreducible random hex - compressing it recovers 68
/// tokens, so the only lever is not shipping it eagerly. `Lazy` ships one
/// pointer line instead, for callers that read the bulk and never quote an id.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verbatim {
    Full,
    Lazy,
    Off,
}

impl Verbatim {
    /// `false` opts out, `"lazy"` withholds, anything else (absent included)
    /// is the full sidecar.
    ///
    /// `TANUKI_VERBATIM` sets the default for callers that do not pass
    /// `verbatim`, so an operator can set the sidecar policy once for a
    /// deployment instead of per call. An explicit argument always wins.
    /// Unset or unrecognised = Full, the shipped default, so nothing changes
    /// for anyone who does not set it.
    fn from_env() -> Verbatim {
        match std::env::var("TANUKI_VERBATIM") {
            Ok(e) if e.eq_ignore_ascii_case("lazy") => Verbatim::Lazy,
            Ok(e) if e.eq_ignore_ascii_case("off") || e.eq_ignore_ascii_case("false") => Verbatim::Off,
            _ => Verbatim::Full,
        }
    }

    pub fn parse(v: &Value) -> Verbatim {
        match v {
            // Only an ABSENT argument consults the environment. An explicit
            // `true` must mean the full sidecar even under
            // TANUKI_VERBATIM=lazy, or the env stops being a default and
            // becomes an override the caller cannot escape.
            Value::Null => Verbatim::from_env(),
            Value::Bool(false) => Verbatim::Off,
            Value::String(s) if s.eq_ignore_ascii_case("lazy") => Verbatim::Lazy,
            _ => Verbatim::Full,
        }
    }
}

/// The lazy sidecar: what was withheld and how to get it back. `id` is the
/// stash the strings can be fetched from; the proxy path has no stash, so it
/// passes None and the `id=` clause is omitted rather than invented.
/// Counts what was FOUND, not what a full sidecar would have carried - lazy
/// withholds the overflow too.
pub fn lazy_pointer(side: &Sidecar, id: Option<&str>) -> String {
    format!(
        "\u{b7}verbatim\u{b7} {} exact strings withheld (lazy) - tanuki_fetch {}query=<substring>, or tanuki_verify to settle one value",
        side.needles.len() + side.more,
        match id {
            Some(i) => format!("id={i} "),
            None => String::new(),
        }
    )
}

/// The sidecar must not erase the compression win it protects: budget its
/// text at half the RAW characters it is an alternative to. Over that, the
/// sidecar approaches the cost of just shipping the text, so stop and set
/// `dense`; `route` then refuses to image, because a budgeted sidecar stays
/// cheap while dropping the very ids it exists to carry.
///
/// The baseline is RAW, not the compressed text handed to the scanner - a
/// codebook/tiny run shrinks the compressed text while the legend still
/// carries the ids (EVALS section 7).
pub const SIDECAR_SHARE: usize = 2;
pub const SIDECAR_MIN_CHARS: usize = 256;

pub fn sidecar_budget(raw_chars: usize) -> usize {
    let b = raw_chars / SIDECAR_SHARE;
    if b < SIDECAR_MIN_CHARS {
        SIDECAR_MIN_CHARS
    } else {
        b
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
        let mut seg_hex_alpha = 0usize;
        let mut vowels = 0usize;
        let mut run = 0usize;
        let mut max_run = 0usize;
        while e < n && chars[e].is_ascii_alphanumeric() {
            let c = chars[e];
            if c.is_ascii_digit() {
                seg_digits += 1;
            } else {
                seg_alpha += 1;
                let f = c.to_ascii_lowercase();
                if matches!(f, 'a'..='f') {
                    seg_hex_alpha += 1;
                }
                match f {
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
        // A bare 7-hex sha is at risk, so one inside `ee70833..0c331b6` is too -
        // segments must mirror the whole-token hex and numeric rules, or a git
        // sha range slips through on length alone.
        if len >= 6 && seg_hex_alpha > 0 && seg_alpha == seg_hex_alpha {
            return true;
        }
        if len >= 9 && seg_alpha == 0 {
            return true;
        }
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

/// Scans raw input directly; `raw_chars` defaults to the text's own size.
pub fn scan_needles(text: &str) -> Sidecar {
    scan_needles_sized(text, text.chars().count())
}

/// `raw_chars` is the size of the ORIGINAL text this sidecar accompanies.
pub fn scan_needles_sized(text: &str, raw_chars: usize) -> Sidecar {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut order: Vec<(usize, &str)> = Vec::new(); // (1-based line, value), encounter order
    let lines: Vec<&str> = text.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let line: &str = line;
        let mut claimed: Vec<(usize, usize)> = Vec::new();
        // Whole-token pass first: an at-risk token ships entire, so a pattern
        // matching only its middle cannot ship a fragment that reads as safe.
        for (at, end) in risky_tokens(line) {
            claimed.push((at, end));
            let v = &line[at..end];
            if seen.insert(v) {
                order.push((i + 1, v));
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
                if seen.insert(m.as_str()) {
                    order.push((i + 1, m.as_str()));
                }
            }
        }
    }
    // Budget pass, sequential over the same encounter order the TS engine uses.
    let budget = sidecar_budget(raw_chars);
    let mut kept: Vec<Needle> = Vec::new();
    let mut more = 0usize;
    let mut used = 0usize;
    let mut full = false;
    for (line_no, v) in order {
        let cost = 3 + line_no.to_string().len() + v.chars().count(); // "\nL<line> <value>"
        if full || used + cost > budget {
            full = true; // latch, so the carried list never ends ragged
            more += 1;
            continue;
        }
        used += cost;
        kept.push(Needle { line: line_no, value: v.to_string() });
    }
    if kept.is_empty() {
        return Sidecar { needles: Vec::new(), more: 0, dense: false, text: String::new(), tokens: 0 };
    }
    kept.sort_by_key(|n| n.line); // stable, mirrors JS Array.sort
    // Say what is CARRIED, not what was found: "read them here" is false for
    // anything past the budget, and the footer alone is easy to miss.
    let mut out = if more > 0 {
        format!(
            "\u{b7}verbatim\u{b7} {} of {} exact strings (read them here, not from pixels)",
            kept.len(),
            kept.len() + more
        )
    } else {
        format!(
            "\u{b7}verbatim\u{b7} {} exact strings (read them here, not from pixels)",
            kept.len()
        )
    };
    for n in &kept {
        out.push_str(&format!("\nL{} {}", n.line, n.value));
    }
    if more > 0 {
        out.push_str(&format!("\n\u{2026} +{more} more (needle-dense; keep the source as text)"));
    }
    let tokens = crate::text_tokens(&out);
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
        // Structure, not signature. Every rule above matches a value by its own
        // shape, which only works for vendors who prefix their tokens. An AWS
        // SECRET access key is 40 chars of base64 with no marker at all, and it
        // leaked straight through until this rule existed. Same inversion the
        // sidecar classifier needed: when the LEFT side of an assignment names
        // a secret, the right side is one whatever it looks like.
        //
        // Tightened against 19.7 MB of real logs (journal, dmesg, git log,
        // pacman), which is the only reason the bounds look arbitrary:
        //   - the secret word must END the key, or a systemd status line matches (8 hits);
        //   - singular only, or `imageTokens: rev.tokens` matches source code (84);
        //   - values exclude backticks, or a template literal matches (2).
        // Residual is 2 hits in 166,985 lines, and both are real secrets.
        (
            "named-secret",
            r#"(?i)\b[A-Za-z0-9_.-]*(?:secret|password|passwd|token|credential|auth[_-]?key|api[_-]?key|access[_-]?key|private[_-]?key)"?\s*[=:]\s*"?([^\s"',;`\[]{8,})"?"#,
        ),
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

/// Fetch-side counterpart to `scan_credentials`, over the SAME pattern table -
/// byte-parity with `src/needles.ts` `redactCredentials`. The gate stops a
/// secret from becoming pixels; it never stopped `tanuki_fetch` from handing
/// one back as text. The stash is untouched (raw bytes, byte-exact
/// round-trip); only what leaves for the context window is masked, and
/// `redact:false` still returns the original.
///
/// Count is values replaced, not kinds - the caller says so out loud, because
/// a silently altered slice gets re-fetched or quoted as fact.
///
/// ponytail: `private-key` matches the BEGIN header only, so a PEM body still
/// ships as text below a redacted header. Widen that one pattern in BOTH
/// engines if a real key corpus justifies it; a second heuristic here would
/// let the gate and the mask disagree about what a secret is.
pub fn redact_credentials(text: &str) -> (String, usize) {
    let mut out = text.to_string();
    let mut count = 0usize;
    for (kind, pat) in CREDENTIALS.iter() {
        let n = pat.find_iter(&out).count();
        if n == 0 {
            continue;
        }
        let placeholder = format!("[redacted:{kind}]");
        out = pat
            .replace_all(&out, |c: &regex::Captures| match c.get(1) {
                // shape rules match the secret itself
                None => placeholder.clone(),
                // the named rule matches `NAME=value` and captures only the
                // value, so the key stays readable. Splice at the capture
                // offset; the TS engine reaches the same index via
                // lastIndexOf, and a parity case pins `password=password`.
                Some(v) => {
                    let m = c.get(0).unwrap();
                    let s = m.as_str();
                    let rel = v.start() - m.start();
                    format!("{}{placeholder}{}", &s[..rel], &s[rel + v.as_str().len()..])
                }
            })
            .into_owned();
        count += n;
    }
    (out, count)
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

    /// The budget carries every id in ordinary content and refuses only when
    /// the sidecar would eat the win it protects.
    #[test]
    fn budget_carries_real_logs_and_flags_id_dense_blocks() {
        let prose: Vec<String> = (0..40)
            .map(|i| format!("2026-07-27T09:30:00Z relay INFO worker heartbeat seq {i} ok latency=14ms"))
            .collect();
        let mut mixed = prose.clone();
        mixed.push("relay dest=86:2b:11:51:58:03 down".to_string());
        mixed.push("merged 6c9224c into main".to_string());
        let ok = scan_needles(&mixed.join("\n"));
        assert_eq!(ok.more, 0, "ordinary content must not truncate");
        assert!(!ok.dense);
        assert!(ok.text.contains("86:2b:11:51:58:03") && ok.text.contains("6c9224c"));

        // A block that is nothing but ids cannot be protected by a sidecar
        // smaller than itself - it must say so rather than image silently.
        let ids: Vec<String> = (0..40).map(|i| format!("id={i:04}deadbeef4f3a")).collect();
        let crammed = scan_needles(&ids.join("\n"));
        assert!(crammed.dense);
        assert!(crammed.more > 0);
        assert!(crammed.text.contains("more (needle-dense"));
    }

    #[test]
    fn budget_scales_with_raw_size() {
        assert_eq!(sidecar_budget(0), SIDECAR_MIN_CHARS);
        assert_eq!(sidecar_budget(40_000), 20_000);
    }
}

#[cfg(test)]
mod honesty_tests {
    use super::*;

    /// The header must state what is CARRIED - "read them here" is false for
    /// anything past the budget.
    #[test]
    fn header_counts_carried_not_found() {
        let ids: Vec<String> = (0..40).map(|i| format!("id={i:04}deadbeef4f3a")).collect();
        let sc = scan_needles(&ids.join("\n"));
        assert!(sc.dense);
        let head = sc.text.lines().next().unwrap();
        assert_eq!(
            head,
            format!(
                "\u{b7}verbatim\u{b7} {} of {} exact strings (read them here, not from pixels)",
                sc.needles.len(),
                sc.needles.len() + sc.more
            )
        );
        let listed = sc.text.lines().filter(|l| l.starts_with('L')).count();
        assert_eq!(listed, sc.needles.len());
    }

    #[test]
    fn header_is_plain_when_everything_fits() {
        let sc = scan_needles("relay dest=86:2b:11:51:58:03 down");
        assert!(!sc.dense);
        assert!(sc.text.lines().next().unwrap().starts_with("\u{b7}verbatim\u{b7} 1 exact strings"));
    }
}

#[cfg(test)]
mod named_secret_tests {
    use super::redact_credentials;

    /// The shape rules only catch vendors who prefix their tokens. An AWS
    /// SECRET access key is 40 chars of base64 with no marker, and it leaked
    /// straight through `fetch` until the named rule existed. Bounds are
    /// measured against 19.7 MB of real logs: 2 hits in 166,985 lines.
    #[test]
    fn catches_assignment_shaped_secrets() {
        for line in [
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI00K7MDENGbPxRfiCYEXAMPLEKEY",
            "db_password: hunter2000secret",
            r#"{"client_secret": "9f3a2b1c4d5e6f7a"}"#,
            "DATABASE_PASSWORD=p@ssw0rd-very-long",
        ] {
            let (text, count) = redact_credentials(line);
            assert_eq!(count, 1, "{line}");
            assert!(text.contains("[redacted:named-secret]"), "{line}");
        }
    }

    #[test]
    fn leaves_the_key_name_readable() {
        let (text, _) = redact_credentials("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI00K7MDENGbPxRfiCYEXAMPLEKEY");
        assert_eq!(text, "AWS_SECRET_ACCESS_KEY=[redacted:named-secret]");
    }

    #[test]
    fn does_not_fire_on_measured_false_positives() {
        for line in [
            "CACHE_KEY=abc12345678",
            "idempotency-key: 9f3a2b1c4d5e",
            "imageTokens: rev.tokens,",
            "systemd-ask-password-console.path: Deactivated successfully.",
            "const token = `frame-allocator#${hex(r, 6)}`;",
            "token=short",
        ] {
            assert_eq!(redact_credentials(line).1, 0, "{line}");
        }
    }

    #[test]
    fn never_re_redacts_an_earlier_placeholder() {
        let (text, count) = redact_credentials(r#"api_key="AKIAIOSFODNN7EXAMPLE""#);
        assert_eq!(count, 1);
        assert_eq!(text, r#"api_key="[redacted:aws-key]""#);
    }

    #[test]
    fn splices_at_the_last_occurrence() {
        // matches the TS engine's lastIndexOf; indexOf would mask the key
        assert_eq!(redact_credentials("password=password").0, "password=[redacted:named-secret]");
    }
}

#[cfg(test)]
mod verbatim_env_tests {
    use super::Verbatim;
    use serde_json::json;

    /// TANUKI_VERBATIM is a DEFAULT, not an override. Both engines originally
    /// got this wrong in the same way - an explicit `true` fell through to the
    /// env - and because they were wrong identically the cross-engine check
    /// passed. Serialised: env is process-global.
    #[test]
    fn env_is_a_default_that_an_explicit_argument_beats() {
        // SAFETY: single-threaded test, restored before returning
        unsafe { std::env::set_var("TANUKI_VERBATIM", "lazy") };
        assert_eq!(Verbatim::parse(&json!(null)), Verbatim::Lazy, "absent takes the env");
        assert_eq!(Verbatim::parse(&json!(true)), Verbatim::Full, "explicit true beats the env");
        assert_eq!(Verbatim::parse(&json!(false)), Verbatim::Off);
        assert_eq!(Verbatim::parse(&json!("lazy")), Verbatim::Lazy);

        unsafe { std::env::set_var("TANUKI_VERBATIM", "off") };
        assert_eq!(Verbatim::parse(&json!(null)), Verbatim::Off);
        assert_eq!(Verbatim::parse(&json!(true)), Verbatim::Full);

        unsafe { std::env::set_var("TANUKI_VERBATIM", "nonsense") };
        assert_eq!(Verbatim::parse(&json!(null)), Verbatim::Full);

        unsafe { std::env::remove_var("TANUKI_VERBATIM") };
        assert_eq!(Verbatim::parse(&json!(null)), Verbatim::Full);
    }
}
