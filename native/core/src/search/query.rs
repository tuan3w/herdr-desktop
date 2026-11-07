//! A query as typed: words, and the attribute filters `on:<machine>`, `in:<project>` and `is:<state>`.

use super::fold::fold_text;

/// The values `is:` understands (a prefix of one is enough).
pub const IS_VALUES: [&str; 8] = [
    "needs", "review", "working", "idle", "chat", "terminal", "pinned", "unread",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    On(String),
    In(String),
    Is(String),
}

impl Filter {
    /// As typed, folded: `on:gpu`.
    pub fn text(&self) -> String {
        match self {
            Self::On(v) => format!("on:{v}"),
            Self::In(v) => format!("in:{v}"),
            Self::Is(v) => format!("is:{v}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Parsed {
    /// The words to match, folded.
    pub words: Vec<String>,
    pub filters: Vec<Filter>,
}

/// Splits `query` into words and filters. `is:` takes a value only when it starts one of [`IS_VALUES`] (so `is:zzz`
/// is a word a person is still typing, not a filter that hides everything); `on:` and `in:` take any non-empty value.
pub fn parse(query: &str) -> Parsed {
    let mut out = Parsed::default();
    for raw in query.split_whitespace() {
        let word = fold_text(raw);
        if word.is_empty() {
            continue;
        }
        if let Some(v) = word.strip_prefix("on:").filter(|v| !v.is_empty()) {
            out.filters.push(Filter::On(v.to_owned()));
        } else if let Some(v) = word.strip_prefix("in:").filter(|v| !v.is_empty()) {
            out.filters.push(Filter::In(v.to_owned()));
        } else if let Some(v) = word
            .strip_prefix("is:")
            .filter(|v| !v.is_empty() && IS_VALUES.iter().any(|k| k.starts_with(v)))
        {
            out.filters.push(Filter::Is(v.to_owned()));
        } else {
            out.words.push(word);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_come_out_of_the_words() {
        let p = parse("pay on:GPU in:Ledger is:ne");
        assert_eq!(p.words, vec!["pay"]);
        assert_eq!(
            p.filters,
            vec![
                Filter::On("gpu".into()),
                Filter::In("ledger".into()),
                Filter::Is("ne".into())
            ]
        );
    }

    #[test]
    fn a_filter_still_being_typed_or_unknown_is_a_word() {
        assert_eq!(parse("on:").words, vec!["on:"]);
        assert_eq!(parse("is:zzz").words, vec!["is:zzz"]);
        assert!(parse("is:zzz").filters.is_empty());
    }
}
