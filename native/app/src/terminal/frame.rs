//! What the emulator thread hands the view: one immutable [`Frame`] per update, rows shared between frames whenever a row
//! did not change (the view rebinds only rows whose `Arc` is new, as `PaneScreen` does).

use std::sync::Arc;

use herdr_core::screen::{Link, Row, Run, Style};

/// How the cursor is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    /// A filled cell.
    Block,
    /// A line at the left edge of the cell.
    Bar,
    /// A line under the cell.
    Underline,
}

/// The cursor in the viewport: where it is and how the program asked for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
    pub shape: CursorShape,
    /// The program asked for a blinking cursor (the view blinks it only when the app allows motion).
    pub blink: bool,
}

/// Where the viewport is in the scrollback.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Scroll {
    /// Rows in the scrollback and on the screen.
    pub total: usize,
    /// The first row the viewport shows.
    pub offset: usize,
    /// Rows the viewport shows.
    pub len: usize,
}

impl Scroll {
    /// Whether the viewport shows the end (the screen itself, not the history).
    pub fn at_end(&self) -> bool {
        self.offset + self.len >= self.total
    }
}

/// How the program ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// It returned a status.
    Code(i32),
    /// A signal ended it.
    Signal(i32),
}

impl Exit {
    /// Words for the person: `Exited with status 2`, `Ended by signal 9`.
    pub fn words(&self) -> String {
        match self {
            Exit::Code(0) => "The program ended".to_owned(),
            Exit::Code(code) => format!("The program ended with status {code}"),
            Exit::Signal(sig) => format!("The program was ended by signal {sig}"),
        }
    }
}

/// A hyperlink (OSC 8) in one row of the viewport.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowLink {
    pub row: u16,
    pub link: Link,
}

/// The viewport at one moment.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    /// Counts up with every published frame.
    pub rev: u64,
    pub cols: u16,
    /// The viewport's rows, top to bottom; a row equal to the previous frame's is the same `Arc`. The selection is part of
    /// the rows' styles (inverse).
    pub rows: Vec<Arc<Row>>,
    pub links: Vec<RowLink>,
    pub cursor: Option<Cursor>,
    pub scroll: Scroll,
    /// The window title the program set (OSC 0 and 2).
    pub title: Arc<str>,
    /// Counts bells (BEL): a change is a ring.
    pub bells: u64,
    /// The program asked for mouse events: the view sends them instead of selecting (Shift selects anyway).
    pub mouse_tracking: bool,
    /// The alternate screen is up (vim, htop, less): no scrollback of its own.
    pub alt_screen: bool,
    /// Something is selected.
    pub selection: bool,
    /// The program has ended; `None` while it runs.
    pub exit: Option<Exit>,
    /// Text a program asked the clipboard to hold (OSC 52), once; the view decides.
    pub clipboard: Option<Arc<str>>,
}

impl Frame {
    /// The viewport as plain text, rows joined by newlines, trailing blanks trimmed.
    pub fn text(&self) -> String {
        self.rows
            .iter()
            .map(|r| r.text().trim_end().to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `row` with the cell at column `col` drawn inverted: the block cursor. Runs are cut at the cell so the rest of the row
/// keeps its style; a column past the end of the text is padded with blanks.
pub fn with_block_cursor(row: &Row, col: u16) -> Row {
    use unicode_width::UnicodeWidthChar;
    let mut runs: Vec<Run> = Vec::with_capacity(row.runs.len() + 2);
    let mut at: u16 = 0;
    let mut done = false;
    for run in &row.runs {
        if done {
            runs.push(run.clone());
            continue;
        }
        let (mut before, mut cell, mut after) = (String::new(), String::new(), String::new());
        for c in run.text.chars() {
            let w = c.width().unwrap_or(0) as u16;
            if cell.is_empty() && at + w > col && at <= col && after.is_empty() {
                cell.push(c);
            } else if cell.is_empty() && after.is_empty() {
                before.push(c);
            } else {
                after.push(c);
            }
            at = at.saturating_add(w);
        }
        if cell.is_empty() {
            runs.push(run.clone());
            continue;
        }
        done = true;
        let flip = |style: Style| Style {
            inverse: !style.inverse,
            ..style
        };
        if !before.is_empty() {
            runs.push(Run {
                text: before,
                style: run.style,
            });
        }
        runs.push(Run {
            text: cell,
            style: flip(run.style),
        });
        if !after.is_empty() {
            runs.push(Run {
                text: after,
                style: run.style,
            });
        }
    }
    if !done {
        let blanks = col.saturating_sub(at);
        if blanks > 0 {
            runs.push(Run {
                text: " ".repeat(usize::from(blanks)),
                style: Style::default(),
            });
        }
        runs.push(Run {
            text: " ".to_owned(),
            style: Style {
                inverse: true,
                ..Style::default()
            },
        });
    }
    Row::new(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(parts: &[(&str, bool)]) -> Row {
        Row::new(
            parts
                .iter()
                .map(|(text, bold)| Run {
                    text: (*text).to_owned(),
                    style: Style {
                        bold: *bold,
                        ..Style::default()
                    },
                })
                .collect(),
        )
    }

    fn shown(row: &Row) -> Vec<(String, bool, bool)> {
        row.runs
            .iter()
            .map(|r| (r.text.clone(), r.style.bold, r.style.inverse))
            .collect()
    }

    #[test]
    fn the_block_inverts_one_cell_and_keeps_the_rest_of_the_runs() {
        let r = with_block_cursor(&row(&[("ab", false), ("cd", true)]), 1);
        assert_eq!(
            shown(&r),
            [
                ("a".to_owned(), false, false),
                ("b".to_owned(), false, true),
                ("cd".to_owned(), true, false)
            ]
        );
        let r = with_block_cursor(&row(&[("ab", false), ("cd", true)]), 2);
        assert_eq!(
            shown(&r),
            [
                ("ab".to_owned(), false, false),
                ("c".to_owned(), true, true),
                ("d".to_owned(), true, false)
            ]
        );
    }

    #[test]
    fn past_the_text_the_cursor_is_a_padded_blank_cell() {
        let r = with_block_cursor(&row(&[("ab", false)]), 4);
        assert_eq!(r.text(), "ab   ");
        assert!(r.runs.last().unwrap().style.inverse);
        let empty = with_block_cursor(&Row::new(vec![]), 0);
        assert_eq!(shown(&empty), [(" ".to_owned(), false, true)]);
    }

    #[test]
    fn a_wide_character_is_inverted_whole_whatever_half_the_cursor_is_on() {
        for col in [1u16, 2] {
            let r = with_block_cursor(&row(&[("a日b", false)]), col);
            assert_eq!(
                shown(&r),
                [
                    ("a".to_owned(), false, false),
                    ("日".to_owned(), false, true),
                    ("b".to_owned(), false, false)
                ],
                "col {col}"
            );
        }
    }
}
