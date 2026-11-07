//! Following the end of the pane, and the pill that says there is more below.

/// Whether a view scrolled to `offset` (points from the top) of `content` points, `viewport` tall, is
/// at its end: within one row of it, or showing everything.
pub fn at_end(offset: f32, viewport: f32, content: f32, line_height: f32) -> bool {
    content - (offset + viewport) <= line_height.max(1.0)
}

/// What the pill over a pane that is scrolled away from its end says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pill {
    /// The agent is blocked on a question, below the fold or not.
    NeedsYou,
    /// Rows arrived below since the person scrolled away.
    NewLines(u32),
}

impl Pill {
    /// The pill for a pane scrolled away from its end (`None` at the end: following shows everything)
    /// with `unseen` rows below that were not seen. A blocked agent wins over a count.
    pub fn for_view(at_end: bool, unseen: u32, needs_you: bool) -> Option<Pill> {
        if at_end {
            None
        } else if needs_you {
            Some(Pill::NeedsYou)
        } else if unseen > 0 {
            Some(Pill::NewLines(unseen))
        } else {
            None
        }
    }

    /// Its text. Shape and words both say what it is: nothing here is a colour alone.
    pub fn label(self) -> String {
        match self {
            Pill::NeedsYou => "Needs you".to_owned(),
            Pill::NewLines(1) => "1 new line".to_owned(),
            Pill::NewLines(n) => format!("{n} new lines"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_within_a_row_of_its_end_is_at_the_end() {
        assert!(at_end(600.0, 400.0, 1000.0, 18.0), "exactly at the end");
        assert!(at_end(585.0, 400.0, 1000.0, 18.0), "a row short");
        assert!(!at_end(500.0, 400.0, 1000.0, 18.0), "scrolled up");
        assert!(
            at_end(0.0, 400.0, 300.0, 18.0),
            "content shorter than the view"
        );
    }

    #[test]
    fn the_pill_counts_unseen_rows_only_while_scrolled_away() {
        assert_eq!(Pill::for_view(true, 5, false), None);
        assert_eq!(Pill::for_view(false, 0, false), None);
        assert_eq!(Pill::for_view(false, 3, false), Some(Pill::NewLines(3)));
        assert_eq!(Pill::NewLines(3).label(), "3 new lines");
        assert_eq!(Pill::NewLines(1).label(), "1 new line");
    }

    #[test]
    fn a_blocked_agent_takes_the_pill_even_with_nothing_new() {
        assert_eq!(Pill::for_view(false, 0, true), Some(Pill::NeedsYou));
        assert_eq!(Pill::for_view(false, 9, true), Some(Pill::NeedsYou));
        assert_eq!(
            Pill::for_view(true, 0, true),
            None,
            "at the end the question is on screen"
        );
        assert_eq!(Pill::NeedsYou.label(), "Needs you");
    }
}
