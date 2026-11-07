//! Regular expressions with Dart's semantics.
//!
//! The patterns of this module are ported verbatim from herdr-mobile, where they
//! run on Dart's engine: `\w`, `\d` and `\b` there are ASCII-only. Rust's are
//! Unicode-aware, and the difference points the unsafe way (`forcé` has no
//! boundary after `force` in Rust, so a risky word would pass), so every pattern
//! goes through [`translate`] first. The one remaining difference is `\s`, which
//! is Unicode white space on both sides except for U+FEFF and U+0085.

use fancy_regex::RegexBuilder;
use regex::Regex;

/// ASCII word characters, written inside a class.
const WORD: &str = "A-Za-z0-9_";

/// An ASCII word boundary built from look-around, for the engine that has no
/// `(?-u:\b)`.
const FANCY_BOUNDARY: &str =
    "(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))";

/// How many steps the backtracking engine may take on one text before it gives
/// up. Generous: the longest text read is a few hundred characters.
const BACKTRACK_LIMIT: usize = 20_000_000;

/// Rewrites the Dart-flavoured `pattern` so that `\w`, `\d` and `\b` stay ASCII.
/// `fancy` selects the look-around form of `\b` for the backtracking engine.
fn translate(pattern: &str, fancy: bool) -> String {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut in_class = false;
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(next) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (next, in_class) {
                    ('w', true) => out.push_str(WORD),
                    ('w', false) => {
                        out.push('[');
                        out.push_str(WORD);
                        out.push(']');
                    }
                    ('d', true) => out.push_str("0-9"),
                    ('d', false) => out.push_str("[0-9]"),
                    ('b', false) if fancy => out.push_str(FANCY_BOUNDARY),
                    ('b', false) => out.push_str(r"(?-u:\b)"),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Compiles a lookaround-free Dart pattern. Patterns are literals of this crate,
/// so an invalid one is a bug caught by the first test that touches it.
pub(crate) fn rx(pattern: &str) -> Regex {
    Regex::new(&translate(pattern, false))
        .unwrap_or_else(|e| panic!("bad pattern {pattern:?}: {e}"))
}

/// [`rx`] ignoring case, as Dart's `caseSensitive: false`.
pub(crate) fn rx_i(pattern: &str) -> Regex {
    rx(&format!("(?i){pattern}"))
}

/// A pattern that may use look-around, and so may need the backtracking engine.
pub(crate) enum Matcher {
    /// No look-around: the linear-time engine.
    Plain(Regex),
    /// Look-around: the backtracking engine.
    Fancy(fancy_regex::Regex),
}

impl Matcher {
    /// Compiles `pattern`, case-insensitive unless `case_sensitive`.
    pub(crate) fn new(pattern: &str, case_sensitive: bool) -> Self {
        let flagged = if case_sensitive {
            pattern.to_owned()
        } else {
            format!("(?i){pattern}")
        };
        if ["(?=", "(?!", "(?<=", "(?<!"]
            .iter()
            .any(|l| pattern.contains(l))
        {
            let built = RegexBuilder::new(&translate(&flagged, true))
                .backtrack_limit(BACKTRACK_LIMIT)
                .build();
            Self::Fancy(built.unwrap_or_else(|e| panic!("bad pattern {pattern:?}: {e}")))
        } else {
            Self::Plain(
                Regex::new(&translate(&flagged, false))
                    .unwrap_or_else(|e| panic!("bad pattern {pattern:?}: {e}")),
            )
        }
    }

    /// Whether `text` matches. A text that exhausts the backtracking budget
    /// counts as a match: these patterns flag risk, and a missed flag is the
    /// costly error.
    pub(crate) fn is_match(&self, text: &str) -> bool {
        match self {
            Self::Plain(re) => re.is_match(text),
            Self::Fancy(re) => re.is_match(text).unwrap_or(true),
        }
    }
}
