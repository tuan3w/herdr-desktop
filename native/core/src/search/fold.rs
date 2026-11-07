//! One fold for both sides of a search: lower case, no diacritics, no invisible characters. The same rules as
//! `lib/text.ts` `fold` (so `dinh` finds `Định`), applied one character at a time so a match position in the folded text
//! maps back to a character of the original, which is what the row underlines.

use unicode_normalization::UnicodeNormalization;

/// Soft hyphens and zero-width characters: a paste can carry them, nobody sees them, and they break a match.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}'
    )
}

/// `c` folded, or `None` when it is invisible or a lone combining mark.
pub fn fold_char(c: char) -> Option<char> {
    if c.is_ascii() {
        return Some(c.to_ascii_lowercase());
    }
    if invisible(c) {
        return None;
    }
    // The stroked d does not decompose, so NFD leaves it.
    if matches!(c, '\u{110}' | '\u{111}') {
        return Some('d');
    }
    let base = c.nfd().next().unwrap_or(c);
    if ('\u{300}'..='\u{36f}').contains(&base) {
        return None;
    }
    // `İ` lower-cases to two characters; the first is the letter.
    base.to_lowercase().next()
}

/// Text folded, with where each folded character came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folded {
    /// The folded text.
    pub text: String,
    /// For each folded character, the index of the character of the original it came from. `None` while that is the
    /// identity (nothing was dropped), which is the case for nearly every string.
    pub origin: Option<Box<[u32]>>,
}

impl Folded {
    /// The index in the original text (in characters) of the folded character `at`.
    pub fn original(&self, at: u32) -> u32 {
        match &self.origin {
            Some(map) => map.get(at as usize).copied().unwrap_or(at),
            None => at,
        }
    }
}

/// Folds `s`.
pub fn fold(s: &str) -> Folded {
    let mut text = String::with_capacity(s.len());
    let mut origin: Vec<u32> = Vec::new();
    let mut identity = true;
    for (i, c) in s.chars().enumerate() {
        match fold_char(c) {
            Some(f) => {
                if !identity {
                    origin.push(i as u32);
                }
                text.push(f);
            }
            None => {
                if identity {
                    // First character dropped: everything before it maps to itself.
                    origin.extend(0..text.chars().count() as u32);
                    identity = false;
                }
            }
        }
    }
    Folded {
        text,
        origin: (!identity).then(|| origin.into_boxed_slice()),
    }
}

/// `s` folded, without the map: for a query or a word list.
pub fn fold_text(s: &str) -> String {
    s.chars().filter_map(fold_char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diacritics_case_and_the_stroked_d_fold_away() {
        assert_eq!(fold_text("Crème Brûlée"), "creme brulee");
        assert_eq!(fold_text("Định"), "dinh");
        assert_eq!(fold_text("ĐINH"), "dinh");
        assert_eq!(fold_text("Việt Nam, tiếng Việt"), "viet nam, tieng viet");
    }

    #[test]
    fn invisible_characters_are_dropped_and_positions_map_back() {
        let f = fold("pa\u{200b}y\u{ad}ments");
        assert_eq!(f.text, "payments");
        // "ments" starts after the two dropped characters: folded `m` is the sixth character of the original.
        assert_eq!(f.original(3), 5);
        assert_eq!(f.original(0), 0);
        assert_eq!(f.original(2), 3);
    }

    #[test]
    fn a_string_with_nothing_dropped_keeps_the_identity_map() {
        let f = fold("Định");
        assert!(f.origin.is_none());
        assert_eq!(f.original(2), 2);
    }

    #[test]
    fn a_lone_combining_mark_is_dropped() {
        assert_eq!(fold_text("e\u{301}"), "e");
    }
}
