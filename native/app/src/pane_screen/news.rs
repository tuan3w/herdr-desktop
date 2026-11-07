//! What is new on a pane between two reads, and the rules for telling the person about it: the
//! `N new lines` count, the polite output announcement (at most one per window, at most 200
//! characters) and the assertive `needs you` announcement.

use std::sync::Arc;

use herdr_core::screen::{Row, Screen};

/// The longest stretch of new text a polite announcement carries.
pub const ANNOUNCE_CHARS: usize = 200;

/// The rows of `next` that were not on `prev`, in order, blank rows left out.
///
/// A terminal scrolls (every row moves up), redraws in place (a spinner line changes) or both; the
/// scroll is found as the shift of `prev` against `next` that leaves the fewest rows unexplained, so
/// a screen that merely scrolled by two lines has two new rows, not a whole new screen. The very
/// first read (an empty `prev`) is the baseline, not news.
pub fn new_rows(prev: &Screen, next: &Screen) -> Vec<Arc<Row>> {
    if prev.rows.is_empty() {
        return Vec::new();
    }
    let (old, new) = (&prev.rows, &next.rows);
    let same = |i: usize, j: usize| Arc::ptr_eq(&old[i], &new[j]) || old[i].hash == new[j].hash;
    // `shift` rows scrolled off the top: old row `i` is now new row `i - shift`.
    let mut best: Option<(usize, usize)> = None;
    for shift in 0..old.len().min(new.len() + 1) {
        let overlap = (old.len() - shift).min(new.len());
        let moved = (0..overlap).filter(|&k| !same(shift + k, k)).count();
        let appended = new.len() - overlap;
        let cost = moved + appended;
        if best.is_none_or(|(c, _)| cost < c) {
            best = Some((cost, shift));
            if cost == 0 {
                break;
            }
        }
    }
    let Some((_, shift)) = best else {
        return Vec::new();
    };
    let overlap = (old.len() - shift).min(new.len());
    (0..new.len())
        .filter(|&j| j >= overlap || !same(shift + j, j))
        .map(|j| new[j].clone())
        .filter(|row| !row.text().trim().is_empty())
        .collect()
}

/// The text of `rows` as one announcement: their trimmed text joined by spaces, cut to its last
/// [`ANNOUNCE_CHARS`] characters (the end is what the agent just wrote). `None` when there is none.
pub fn announcement(rows: &[Arc<Row>]) -> Option<String> {
    let text = rows
        .iter()
        .map(|row| row.text().trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    last_chars(&text, ANNOUNCE_CHARS)
}

fn last_chars(text: &str, count: usize) -> Option<String> {
    let total = text.chars().count();
    let kept: String = text.chars().skip(total.saturating_sub(count)).collect();
    let kept = kept.trim();
    (!kept.is_empty()).then(|| kept.to_owned())
}

/// Paces polite output announcements: the first one goes out at once, whatever arrives while the
/// window is open is held (only its last [`ANNOUNCE_CHARS`] characters) and goes out when the window
/// closes. The component drives the window with a timer; this holds no clock.
#[derive(Debug, Default)]
pub struct OutputGate {
    cooling: bool,
    held: String,
}

impl OutputGate {
    /// New text arrived. `Some(text)` is to be announced now and opens a window (the caller starts
    /// its timer and calls [`OutputGate::window_closed`] when it ends); `None` when the window is
    /// open (the text is held) or the text is empty.
    pub fn push(&mut self, text: &str) -> Option<String> {
        if self.cooling {
            if !self.held.is_empty() {
                self.held.push(' ');
            }
            self.held.push_str(text);
            self.held = last_chars(&self.held, ANNOUNCE_CHARS).unwrap_or_default();
            return None;
        }
        let now = last_chars(text, ANNOUNCE_CHARS)?;
        self.cooling = true;
        Some(now)
    }

    /// The window ended. `Some(text)` is what was held: announce it, and a new window opens (the
    /// caller starts the timer again); `None` means nothing waited and the gate is open.
    pub fn window_closed(&mut self) -> Option<String> {
        if self.held.is_empty() {
            self.cooling = false;
            return None;
        }
        Some(std::mem::take(&mut self.held))
    }
}

/// Says when a pane starts needing the person: once per question, not per read.
#[derive(Debug, Default)]
pub struct AttentionWatch {
    last: Option<String>,
}

impl AttentionWatch {
    /// A watch that treats `current` as already known: opening a pane that is blocked already is not a
    /// change (the person opened it, and the answer dock is in front of them).
    pub fn starting_at(current: Option<&str>) -> AttentionWatch {
        AttentionWatch {
            last: current.map(str::to_owned),
        }
    }

    /// The question to announce, when `attention` is one not announced yet.
    pub fn changed(&mut self, attention: Option<&str>) -> Option<String> {
        if self.last.as_deref() == attention {
            return None;
        }
        self.last = attention.map(str::to_owned);
        self.last.clone()
    }
}

#[cfg(test)]
mod tests {
    use herdr_core::screen::Screen;

    use super::*;

    /// A screen of plain rows, reusing the rows of `prev` that did not change (as the parser does).
    fn screen(rows: &[&str], prev: Option<&Screen>) -> Screen {
        Screen::parse_text(&rows.join("\n"), prev)
    }

    fn texts(rows: &[Arc<Row>]) -> Vec<String> {
        rows.iter().map(|r| r.text()).collect()
    }

    #[test]
    fn the_first_read_is_not_news() {
        let first = screen(&["a", "b"], None);
        assert!(new_rows(&Screen::default(), &first).is_empty());
    }

    #[test]
    fn rows_appended_to_a_growing_scrollback_are_new() {
        let before = screen(&["one", "two"], None);
        let after = screen(&["one", "two", "three", "four"], Some(&before));
        assert_eq!(texts(&new_rows(&before, &after)), ["three", "four"]);
    }

    #[test]
    fn a_scrolled_screen_has_only_the_rows_that_came_in() {
        let before = screen(&["a", "b", "c", "d"], None);
        let after = screen(&["c", "d", "e", "f"], Some(&before));
        assert_eq!(texts(&new_rows(&before, &after)), ["e", "f"]);
    }

    #[test]
    fn a_line_rewritten_in_place_is_one_new_row() {
        let before = screen(&["header", "spinner |", "footer"], None);
        let after = screen(&["header", "spinner /", "footer"], Some(&before));
        assert_eq!(texts(&new_rows(&before, &after)), ["spinner /"]);
    }

    #[test]
    fn an_unchanged_screen_has_nothing_new() {
        let before = screen(&["a", "b"], None);
        let after = screen(&["a", "b"], Some(&before));
        assert!(new_rows(&before, &after).is_empty());
    }

    #[test]
    fn a_full_redraw_is_all_new_and_blank_rows_are_not_counted() {
        let before = screen(&["a", "b"], None);
        let after = screen(&["x", "", "y"], Some(&before));
        assert_eq!(texts(&new_rows(&before, &after)), ["x", "y"]);
    }

    #[test]
    fn an_announcement_carries_the_end_of_the_new_text() {
        let before = screen(&["x"], None);
        let long = "word ".repeat(100);
        let after = screen(&["x", "first line", &long, "last words"], Some(&before));
        let said = announcement(&new_rows(&before, &after)).unwrap();
        assert!(said.chars().count() <= ANNOUNCE_CHARS);
        assert!(said.ends_with("last words"), "{said}");
        assert_eq!(announcement(&[]), None);
    }

    #[test]
    fn the_first_output_is_announced_at_once_and_a_burst_waits_for_the_window() {
        let mut gate = OutputGate::default();
        assert_eq!(gate.push("building").as_deref(), Some("building"));
        assert_eq!(gate.push("compiling a"), None);
        assert_eq!(gate.push("compiling b"), None);
        assert_eq!(
            gate.window_closed().as_deref(),
            Some("compiling a compiling b"),
            "what arrived in the window goes out together when it closes"
        );
        assert_eq!(
            gate.push("linking"),
            None,
            "the window reopened for what was just said"
        );
        assert_eq!(gate.window_closed().as_deref(), Some("linking"));
        assert_eq!(
            gate.window_closed(),
            None,
            "a quiet window leaves the gate open"
        );
        assert_eq!(gate.push("done").as_deref(), Some("done"));
    }

    #[test]
    fn held_text_is_capped_like_a_single_announcement() {
        let mut gate = OutputGate::default();
        gate.push("first");
        for _ in 0..100 {
            gate.push("filler words here");
        }
        gate.push("the end");
        let held = gate.window_closed().unwrap();
        assert!(held.chars().count() <= ANNOUNCE_CHARS);
        assert!(held.ends_with("the end"));
    }

    #[test]
    fn a_pane_that_starts_needing_you_is_announced_once_per_question() {
        let mut watch = AttentionWatch::starting_at(None);
        assert_eq!(watch.changed(None), None);
        assert_eq!(
            watch.changed(Some("Run rm -rf build?")).as_deref(),
            Some("Run rm -rf build?")
        );
        assert_eq!(
            watch.changed(Some("Run rm -rf build?")),
            None,
            "the same question is not repeated"
        );
        assert_eq!(
            watch.changed(Some("Push to origin?")).as_deref(),
            Some("Push to origin?")
        );
        assert_eq!(watch.changed(None), None, "answered: nothing to say");
        assert_eq!(
            watch.changed(Some("Push to origin?")).as_deref(),
            Some("Push to origin?")
        );
    }

    #[test]
    fn a_pane_opened_while_blocked_is_not_announced_again() {
        let mut watch = AttentionWatch::starting_at(Some("Continue?"));
        assert_eq!(watch.changed(Some("Continue?")), None);
        assert_eq!(
            watch.changed(Some("Delete it?")).as_deref(),
            Some("Delete it?")
        );
    }
}
