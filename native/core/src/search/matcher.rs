//! The fuzzy matcher: `nucleo-matcher` (fzf v2 scoring) over text that is folded once, when the index is made, so a
//! keystroke folds only the query. Long text (a message, a pane's last rows) is never matched by subsequence, because a
//! subsequence of a paragraph matches almost any query: it is a whole word's start or a substring.

use nucleo_matcher::{Config, Matcher, Utf32String};

use super::fold::{Folded, fold};

/// Text prepared for matching: folded, with the way back to the original.
#[derive(Debug, Clone)]
pub struct Haystack {
    folded: Folded,
    text: Utf32String,
}

impl Haystack {
    pub fn new(s: &str) -> Self {
        let folded = fold(s);
        let text = Utf32String::from(folded.text.as_str());
        Self { folded, text }
    }

    pub fn is_empty(&self) -> bool {
        self.folded.text.is_empty()
    }

    /// The folded text.
    pub fn text(&self) -> &str {
        &self.folded.text
    }

    /// The index in the original text (in characters) of the folded character `at`.
    pub fn original(&self, at: u32) -> u32 {
        self.folded.original(at)
    }
}

/// A query word, folded.
#[derive(Debug, Clone)]
pub struct Needle {
    text: String,
    utf32: Utf32String,
}

impl Needle {
    pub fn new(word: &str) -> Self {
        let text = super::fold::fold_text(word);
        let utf32 = Utf32String::from(text.as_str());
        Self { text, utf32 }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn len(&self) -> usize {
        self.utf32.len()
    }

    pub fn is_empty(&self) -> bool {
        self.utf32.is_empty()
    }
}

/// Points per matched character in the substring score: nucleo's own base for a match is 16.
const PER_CHAR: u32 = 16;

/// Scores needles against haystacks. One per thread: the matcher keeps scratch memory.
pub struct Scorer {
    matcher: Matcher,
}

impl Scorer {
    /// `paths`: the delimiter bonuses of file paths (a match after `/` counts as a word start).
    pub fn new(paths: bool) -> Self {
        let mut config = if paths {
            Config::DEFAULT.match_paths()
        } else {
            Config::DEFAULT
        };
        // Both sides are folded already, so nucleo's own normalising and case folding would only cost time.
        config.ignore_case = false;
        config.normalize = false;
        Self {
            matcher: Matcher::new(config),
        }
    }

    /// Subsequence score of `needle` in `haystack` (a name: short text), `None` when it is not one.
    pub fn fuzzy(&mut self, haystack: &Haystack, needle: &Needle) -> Option<u32> {
        let score = self
            .matcher
            .fuzzy_match(haystack.text.slice(..), needle.utf32.slice(..))?;
        Some(u32::from(score))
    }

    /// As [`Scorer::fuzzy`], and pushes the matched character indices of the original text (sorted, unique) onto `marks`.
    pub fn fuzzy_marks(
        &mut self,
        haystack: &Haystack,
        needle: &Needle,
        marks: &mut Vec<u32>,
    ) -> Option<u32> {
        let start = marks.len();
        let score =
            self.matcher
                .fuzzy_indices(haystack.text.slice(..), needle.utf32.slice(..), marks)?;
        for m in &mut marks[start..] {
            *m = haystack.original(*m);
        }
        marks[start..].sort_unstable();
        Some(u32::from(score))
    }

    /// Score of `needle` as a substring of `haystack` (long text): higher when it starts a word. `None` when it is not
    /// one.
    pub fn word_or_substring(&self, haystack: &Haystack, needle: &Needle) -> Option<u32> {
        let h = haystack.text();
        let n = needle.text();
        if n.is_empty() {
            return None;
        }
        let mut best: Option<u32> = None;
        let mut from = 0;
        while let Some(at) = h[from..].find(n) {
            let at = from + at;
            let starts_word = h[..at]
                .chars()
                .next_back()
                .is_none_or(|p| !p.is_alphanumeric());
            let score = needle.len() as u32 * PER_CHAR + if starts_word { 24 } else { 0 };
            best = Some(best.map_or(score, |b| b.max(score)));
            if starts_word {
                break;
            }
            from = at + n.chars().next().map_or(1, char::len_utf8);
            if from >= h.len() {
                break;
            }
        }
        best
    }
}

/// Rewrites sorted character indices as runs: `[1, 2, 3, 7]` is `[(1, 4), (7, 8)]`.
pub fn runs(indices: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &i in indices {
        match out.last_mut() {
            Some(last) if last.1 == i => last.1 = i + 1,
            Some(last) if last.1 > i => {}
            _ => out.push((i, i + 1)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(h: &str, n: &str) -> Option<u32> {
        Scorer::new(false).fuzzy(&Haystack::new(h), &Needle::new(n))
    }

    #[test]
    fn a_subsequence_matches_and_a_prefix_beats_a_scattered_match() {
        assert!(score("payments api", "pay").unwrap() > score("p a y", "pay").unwrap());
        assert!(score("payments", "pyt").is_some());
        assert!(score("payments", "xyz").is_none());
    }

    #[test]
    fn dinh_finds_the_vietnamese_name_and_the_marks_point_into_the_original() {
        let h = Haystack::new("Định tuyến");
        let n = Needle::new("dinh");
        let mut marks = Vec::new();
        assert!(Scorer::new(false).fuzzy_marks(&h, &n, &mut marks).is_some());
        assert_eq!(marks, vec![0, 1, 2, 3]);
        assert_eq!(runs(&marks), vec![(0, 4)]);
    }

    #[test]
    fn camel_case_and_path_segments_count_as_word_starts() {
        let camel = score("PaymentGateway", "pg").unwrap();
        let flat = score("paymentgateway", "pg").unwrap();
        assert!(camel >= flat);
        let mut paths = Scorer::new(true);
        let a = paths.fuzzy(
            &Haystack::new("components/palette.tsx"),
            &Needle::new("cpal"),
        );
        assert!(a.is_some());
    }

    #[test]
    fn long_text_matches_a_word_start_or_a_substring_only() {
        let s = Scorer::new(false);
        let text = Haystack::new("retry the payments job once more");
        assert!(s.word_or_substring(&text, &Needle::new("pay")).is_some());
        // A subsequence of a paragraph is not a match.
        assert!(s.word_or_substring(&text, &Needle::new("rpj")).is_none());
        assert!(
            s.word_or_substring(&text, &Needle::new("pay")).unwrap()
                > s.word_or_substring(&text, &Needle::new("ayme")).unwrap()
        );
    }

    #[test]
    fn runs_join_neighbours() {
        assert_eq!(runs(&[1, 2, 3, 7]), vec![(1, 4), (7, 8)]);
        assert_eq!(runs(&[]), vec![]);
    }
}
