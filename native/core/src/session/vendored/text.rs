//! `clean`, `one_line` and `is_bidi`: copied from herdr-tui's `md.rs` (herdr-mobile ef846f3). That file is
//! a markdown renderer on ratatui; these are the only parts the reducer's `question.rs` needs.

use super::acp::is_unsafe_control;

use crate::session::vendored::width;

/// `text` without control characters (newline and tab stay) and without zero-width joiners, which a
/// terminal draws as two columns or one depending on the terminal.
#[must_use]
pub fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !is_unsafe_control(*c) || *c == '\n' || *c == '\t')
        .filter(|c| !width::is_joiner(*c))
        .collect()
}

/// `text` as one line that is safe to show outside the interface (a title, a note): every control
/// character becomes a space, bidirectional overrides are dropped, and it is cut to `max` characters.
#[must_use]
pub fn one_line(text: &str, max: usize) -> String {
    let spaced: String = text
        .chars()
        .filter(|c| !is_bidi(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    spaced.trim().chars().take(max).collect()
}

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{61c}')
}
