//! Text hygiene shared by the detector and the mode check.
//!
//! herdr-mobile measures and cuts text in UTF-16 units; the limits of the
//! detector (a 40-unit chip, a 160-unit question) were tuned that way, so the
//! helpers here count the same units and never cut inside a surrogate pair.

use std::sync::LazyLock;

use regex::Regex;

use super::re::rx;

static OSC: LazyLock<Regex> = LazyLock::new(|| rx(r"\x1B\][^\x07\x1B\n]*(?:\x07|\x1B\\)"));
static CSI: LazyLock<Regex> = LazyLock::new(|| rx(r"\x1B\[[0-?]*(?: q|[!-/]*[@-~])"));
static OTHER_ESCAPE: LazyLock<Regex> = LazyLock::new(|| rx(r"\x1B[@-Z\\^_]|\x1B[ -/]*[0-Z\\^-~]"));

/// `text` without terminal escape sequences (colour, cursor, OSC titles). An
/// OSC is removed only when it ends with BEL or ST on its own line, and a CSI
/// only when it completes: an unterminated `ESC [` keeps its ESC, as a terminal
/// would still show the text after it.
pub fn strip_ansi(text: &str) -> String {
    if !text.contains('\x1B') {
        return text.to_owned();
    }
    let s = OSC.replace_all(text, "");
    let s = CSI.replace_all(&s, "");
    OTHER_ESCAPE.replace_all(&s, "").into_owned()
}

/// Whether `c` can hide or reorder text, or is a control other than newline
/// and tab.
fn is_hidden(c: char) -> bool {
    let r = c as u32;
    if r < 0x20 {
        return r != 0x0A && r != 0x09;
    }
    if r < 0x7F {
        return false;
    }
    if r <= 0x9F {
        return true;
    }
    matches!(r, 0x00AD | 0x061C | 0x180E | 0xFEFF)
        || (0x200B..=0x200F).contains(&r)
        || (0x2028..=0x202E).contains(&r)
        || (0x2060..=0x206F).contains(&r)
        || (0xFFF9..=0xFFFB).contains(&r)
        || (0xE0000..=0xE007F).contains(&r)
}

/// `text` as one clean line: ANSI sequences removed, hidden characters and
/// controls dropped (a direction override must not reorder a sentence),
/// whitespace runs folded into single spaces.
pub fn plain_line(text: &str) -> String {
    let s = strip_ansi(text);
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if matches!(c, '\n' | '\t' | ' ' | '\u{A0}' | '\u{2028}' | '\u{2029}') {
            space = true;
        } else if !is_hidden(c) {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// `s` as UTF-16 units.
pub(crate) fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// UTF-16 units back to text; an unpaired surrogate is dropped.
pub(crate) fn from_units(u: &[u16]) -> String {
    char::decode_utf16(u.iter().copied())
        .filter_map(Result::ok)
        .collect()
}

/// Length of `s` in UTF-16 units.
pub(crate) fn ulen(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Number of leading white-space characters of `row`.
pub(crate) fn indent(row: &str) -> usize {
    row.chars().take_while(|c| c.is_whitespace()).count()
}

/// `s` cut to at most `limit` UTF-16 units (at least 2) with a trailing ellipsis,
/// at a space when one lies within the last 24 units.
pub fn ellipsize(s: &str, limit: usize) -> String {
    let u = units(s);
    if u.len() <= limit {
        return s.to_owned();
    }
    let mut cut = limit - 1;
    if (u[cut - 1] & 0xFC00) == 0xD800 {
        cut -= 1;
    }
    if let Some(space) = u[..cut].iter().rposition(|&x| x == u16::from(b' '))
        && space + 24 > cut
        && space > 0
    {
        cut = space;
    }
    format!("{}…", from_units(&u[..cut]).trim_end())
}

/// `s` cut to `max` units without leaving half a surrogate pair, trailing
/// white space removed.
pub(crate) fn cut_units(s: &str, max: usize) -> String {
    let u = units(s);
    let mut end = max.min(u.len());
    if end > 0 && (u[end - 1] & 0xFC00) == 0xD800 {
        end -= 1;
    }
    from_units(&u[..end]).trim_end().to_owned()
}

/// `s` cut to `max` units, the cut marked with `…`.
pub(crate) fn cap(s: &str, max: usize) -> String {
    if ulen(s) <= max {
        return s.to_owned();
    }
    let u = units(s);
    format!("{}…", from_units(&u[..max - 1]).trim_end())
}

/// `s` cut to `max` units on a word boundary when one is near.
pub(crate) fn cap_at_word(s: &str, max: usize) -> String {
    let u = units(s);
    if u.len() <= max {
        return s.to_owned();
    }
    let mut cut = &u[..max - 1];
    if let Some(space) = cut.iter().rposition(|&x| x == u16::from(b' '))
        && space > max / 2
    {
        cut = &cut[..space];
    }
    format!("{}…", from_units(cut).trim_end())
}
