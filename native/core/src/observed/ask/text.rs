//! Text helpers the two drivers and the result checks share.

use std::sync::LazyLock;

use regex::Regex;

/// A literal pattern of this module; an invalid one is a bug the first test that touches it shows.
pub(super) fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|e| panic!("bad pattern {pattern:?}: {e}"))
}

/// Dart's whitespace: Unicode white space and the byte order mark.
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `s` without leading and trailing whitespace, as Dart's `String.trim` counts it.
pub(super) fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s` without trailing whitespace, as Dart's `String.trimRight` counts it.
pub(super) fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// `s` without leading whitespace, as Dart's `String.trimLeft` counts it.
pub(super) fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// Lower-case letters, digits and combining marks only: what two renderings of the same text share
/// (markdown marks, quotes, ellipses and spacing are dropped).
pub(super) fn key(s: &str) -> String {
    static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| rx(r"[^\p{L}\p{N}\p{M}]"));
    NOT_WORD.replace_all(&s.to_lowercase(), "").into_owned()
}

/// Every run of white space as one space, trimmed.
pub(super) fn flat(s: &str) -> String {
    static RUN: LazyLock<Regex> = LazyLock::new(|| rx(r"\s+"));
    trim(&RUN.replace_all(s, " ")).to_owned()
}

/// `s` without its last character when that is `…` (a row the screen cut), `None` when it is not cut.
pub(super) fn cut_by_ellipsis(s: &str) -> Option<&str> {
    s.strip_suffix('…')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_keeps_what_two_renderings_share() {
        assert_eq!(key("“Hà Nội” — dự án!"), "hànộidựán");
        assert_eq!(key("Other (type your own)"), "othertypeyourown");
    }

    #[test]
    fn trim_counts_the_byte_order_mark_as_space() {
        assert_eq!(trim("\u{feff} a b \u{a0}"), "a b");
        assert_eq!(flat(" a \n\t b  "), "a b");
    }
}
