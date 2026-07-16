//! Stage 0.5: in-image codebook (the "push base64 the right way" inversion).
//!
//! Under pixel pricing every atlas codepoint costs one cell, so a recurring
//! long token or path prefix can be swapped for a single-cell sigil and the
//! expansion carried once in a trailing `·legend·` line. Deterministic and
//! inspectable — the model expands the sigils from the legend it can see, so
//! nothing becomes model-only (the oversight property the base64 paper flags).
//!
//! Only whole tokens / path prefixes with a net-positive saving are chosen; a
//! sigil already present in the source is skipped, so `sigil -> value` is an
//! unambiguous inverse.

use std::collections::HashMap;

const SIGILS: &str = "§¤¢£¥µ¶ª°±¬×÷ØÞßæðøþ¡¿";
const MIN_LEN: usize = 12;
const MIN_COUNT: usize = 3;

pub struct Codebook {
    pub text: String,
    pub entries: usize,
}

pub fn apply(text: &str) -> Codebook {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for tok in text.split(char::is_whitespace) {
        if tok.chars().count() >= MIN_LEN {
            *counts.entry(tok.to_string()).or_default() += 1;
        }
        if tok.contains('/') {
            // count every path prefix at a '/' boundary (>=3 segments deep)
            let mut acc = String::new();
            for (i, seg) in tok.split('/').enumerate() {
                if i > 0 {
                    acc.push('/');
                }
                acc.push_str(seg);
                if i >= 2 {
                    let pref = format!("{acc}/");
                    if pref.chars().count() >= MIN_LEN {
                        *counts.entry(pref).or_default() += 1;
                    }
                }
            }
        }
    }

    // rank by chars saved = (len-1)*count; deterministic tie-break by value.
    let mut cands: Vec<(String, usize)> = counts.into_iter().filter(|(_, c)| *c >= MIN_COUNT).collect();
    cands.sort_by(|a, b| {
        let sa = (a.0.chars().count() - 1) * a.1;
        let sb = (b.0.chars().count() - 1) * b.1;
        sb.cmp(&sa).then_with(|| a.0.cmp(&b.0))
    });

    let avail: Vec<char> = SIGILS.chars().filter(|s| !text.contains(*s)).collect();
    let mut chosen: Vec<(char, String)> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for (k, c) in cands {
        if chosen.len() >= avail.len() {
            break;
        }
        let len = k.chars().count();
        // net win must beat the legend cost (~len + sigil + '=' + space).
        if (len - 1) * c <= len + 3 {
            continue;
        }
        // skip prefix-overlaps: a chosen key that contains/extends this one.
        if used.iter().any(|u| u.starts_with(&k) || k.starts_with(u.as_str())) {
            continue;
        }
        let sig = avail[chosen.len()];
        used.push(k.clone());
        chosen.push((sig, k));
    }

    if chosen.is_empty() {
        return Codebook {
            text: text.to_string(),
            entries: 0,
        };
    }

    // apply longest-first so a shorter key can't shadow a longer one.
    let mut order: Vec<usize> = (0..chosen.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(chosen[i].1.chars().count()));
    let mut body = text.to_string();
    for &i in &order {
        let (sig, val) = &chosen[i];
        body = body.replace(val.as_str(), &sig.to_string());
    }

    let mut legend = String::from("\n·legend· ");
    for (sig, val) in &chosen {
        legend.push(*sig);
        legend.push('=');
        legend.push_str(val);
        legend.push(' ');
    }
    body.push_str(legend.trim_end());
    Codebook {
        text: body,
        entries: chosen.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expand a codebooked body back via its legend — proves reversibility.
    fn decode(coded: &str) -> String {
        let marker = "\n·legend· ";
        let idx = coded.rfind(marker).expect("legend present");
        let body = &coded[..idx];
        let legend = &coded[idx + marker.len()..];
        let mut out = body.to_string();
        for entry in legend.split(' ') {
            if let Some((sig, val)) = entry.split_once('=') {
                out = out.replace(sig, val);
            }
        }
        out
    }

    #[test]
    fn codebook_roundtrips_paths() {
        let mut lines = Vec::new();
        for i in 0..20 {
            lines.push(format!(
                "INFO copied /var/lib/backup/snapshots/2026/home/user/file_{i:04}.dat ok"
            ));
        }
        let src = lines.join("\n");
        let cb = apply(&src);
        assert!(cb.entries > 0, "should mine the shared path prefix");
        assert!(cb.text.chars().count() < src.chars().count(), "must shrink");
        assert_eq!(decode(&cb.text), src);
    }

    #[test]
    fn codebook_noop_when_nothing_repeats() {
        let src = "one two three four five six seven eight";
        let cb = apply(src);
        assert_eq!(cb.entries, 0);
        assert_eq!(cb.text, src);
    }
}
