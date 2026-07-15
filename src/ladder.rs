//! Stage 1: graded text compression ladder (port of pxpipe mcp/compress.mjs).
//! Levels 0-4, each ⊇ the previous. From level 2 up, any line that looks like
//! code/data or carries a hash/path/URL/long id is passed VERBATIM.

use regex::Regex;
use std::sync::LazyLock;

pub const LEVELS: [(&str, &str, &str); 5] = [
    ("none", "none", "passthrough (baseline)"),
    (
        "whitespace",
        "lossless",
        "trailing whitespace + blank-line runs collapsed; safe for code",
    ),
    (
        "prose",
        "light",
        "L1 + prose lines: collapse spaces, cut redundant filler phrases (code/IDs protected)",
    ),
    (
        "dense",
        "medium",
        "L2 + prose: drop articles & intensifiers",
    ),
    (
        "caveman",
        "heavy",
        "L3 + prose: telegraphic — drop function words; gist only, NOT verbatim",
    ),
];

static FILLER: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)\bin order to\b", "to"),
        (r"(?i)\bdue to the fact that\b", "because"),
        (r"(?i)\bat this point in time\b", "now"),
        (r"(?i)\bin the event that\b", "if"),
        (r"(?i)\bfor the purpose of\b", "for"),
        (r"(?i)\bwith regard to\b", "about"),
        (r"(?i)\ba large number of\b", "many"),
        (r"(?i)\bit is important to note that\b", ""),
        (r"(?i)\bplease note that\b", ""),
        (r"(?i)\bas a matter of fact\b", ""),
        (r"(?i)\bin terms of\b", "for"),
        (r"(?i)\bthe fact that\b", "that"),
    ]
    .iter()
    .map(|(p, r)| (Regex::new(p).unwrap(), *r))
    .collect()
});
static ARTICLES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(the|an|a)\s+").unwrap());
static INTENSIFIERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(very|really|just|actually|basically|simply|quite|rather|essentially|literally)\s+",
    )
    .unwrap()
});
static FUNCTION_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(is|are|was|were|am|be|been|being|do|does|did|have|has|had|will|would|shall|should|can|could|may|might|of|to|in|on|at|for|with|that|this|these|those|it|its|there|here)\b\s*").unwrap()
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());
static PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+([.,;:!?])").unwrap());
static NL3: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// A line that must be preserved verbatim: indented (code), symbol-dense
/// (code/JSON), or carrying a long whitespace-free token (hash/path/URL/id).
pub fn is_protected_line(line: &str) -> bool {
    if line.starts_with([' ', '\t']) {
        return true;
    }
    let total = line.chars().count();
    if total == 0 {
        return false;
    }
    let sym = line
        .chars()
        .filter(|c| {
            !(c.is_whitespace()
                || c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '.' | ',' | ';' | ':' | '\'' | '"' | '!' | '?' | '(' | ')' | '-'
                ))
        })
        .count();
    if sym as f64 / total as f64 > 0.3 {
        return true;
    }
    line.split_whitespace().any(|t| t.chars().count() >= 24)
}

fn tighten_prose(line: &str, level: u8) -> String {
    let mut s = SPACES.replace_all(line, " ").into_owned();
    for (re, to) in FILLER.iter() {
        s = re.replace_all(&s, *to).into_owned();
    }
    if level >= 3 {
        s = ARTICLES.replace_all(&s, "").into_owned();
        s = INTENSIFIERS.replace_all(&s, "").into_owned();
    }
    if level >= 4 {
        s = FUNCTION_WORDS.replace_all(&s, "").into_owned();
    }
    s = SPACES.replace_all(&s, " ").into_owned();
    s = PUNCT.replace_all(&s, "$1").trim().to_string();
    // re-capitalize sentence start
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => c.to_ascii_uppercase().to_string() + chars.as_str(),
        _ => s,
    }
}

pub struct Compressed {
    pub compressed: String,
    pub protected_lines: usize,
    pub level: u8,
}

pub fn compress_text(text: &str, level: u8) -> Compressed {
    let level = level.min(4);
    if level == 0 {
        return Compressed {
            compressed: text.to_string(),
            protected_lines: 0,
            level,
        };
    }
    let mut protected = 0usize;
    let lines: Vec<String> = text
        .split('\n')
        .map(|raw| {
            let line = raw.trim_end_matches([' ', '\t']);
            if level == 1 {
                return line.to_string();
            }
            if is_protected_line(line) {
                protected += 1;
                return line.to_string();
            }
            tighten_prose(line, level)
        })
        .collect();
    let joined = lines.join("\n");
    Compressed {
        compressed: NL3.replace_all(&joined, "\n\n").into_owned(),
        protected_lines: protected,
        level,
    }
}
