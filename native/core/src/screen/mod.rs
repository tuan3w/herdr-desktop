//! `screen`: what a pane looks like. `pane.read format=ansi` text becomes rows of styled runs that
//! keep their identity between reads, plus the helpers that make those rows readable and useful:
//! contrast correction and link detection.
//!
//! The model is a mirror, not an emulator: herdr sends finished rows (no cursor, no mouse), so the
//! parser only understands text, line breaks and SGR styling and ignores every other escape
//! sequence without leaking its payload as text.

mod contrast;
mod links;
mod parse;

use std::sync::Arc;

use unicode_width::UnicodeWidthStr;

pub use contrast::{Rgb, contrast_ratio, indexed_cube_rgb, indexed_rgb, min_contrast_fg};
pub use links::{Link, LinkKind, detect_links, looks_like_slash_command};

/// A terminal colour as herdr sends it: a palette index (the first 16 come from the theme when
/// drawn) or a 24-bit value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Color {
    /// An entry of the 256-colour palette.
    Indexed(u8),
    /// A 24-bit colour.
    Rgb(u8, u8, u8),
}

/// The SGR attributes of a run. `fg`/`bg` of `None` mean the terminal default; `inverse` is kept
/// as a flag (not resolved) because the default colours are the theme's, not ours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Style {
    /// Foreground colour.
    pub fg: Option<Color>,
    /// Background colour.
    pub bg: Option<Color>,
    /// SGR 1.
    pub bold: bool,
    /// SGR 2.
    pub dim: bool,
    /// SGR 3.
    pub italic: bool,
    /// SGR 4.
    pub underline: bool,
    /// SGR 9.
    pub strike: bool,
    /// SGR 7: foreground and background swap.
    pub inverse: bool,
    /// SGR 8: the text is not drawn (it stays in the row so copy and search see what herdr sent).
    pub hidden: bool,
}

impl Style {
    /// Whether blanks in this style are visible on their own (a background, an inverted cell, an
    /// underline or a strike-through). Such padding must not be trimmed from the end of a row.
    pub fn paints_blanks(&self) -> bool {
        self.bg.is_some() || self.inverse || self.underline || self.strike
    }

    /// The style packed into one word for hashing: flags in the low nine bits, then both colours.
    fn bits(&self) -> u64 {
        fn color(c: Option<Color>) -> u64 {
            match c {
                None => 0,
                Some(Color::Indexed(n)) => 1 | (u64::from(n) << 2),
                Some(Color::Rgb(r, g, b)) => {
                    2 | (u64::from(r) << 2) | (u64::from(g) << 10) | (u64::from(b) << 18)
                }
            }
        }
        u64::from(self.bold)
            | u64::from(self.dim) << 1
            | u64::from(self.italic) << 2
            | u64::from(self.underline) << 3
            | u64::from(self.strike) << 4
            | u64::from(self.inverse) << 5
            | u64::from(self.hidden) << 6
            | color(self.fg) << 7
            | color(self.bg) << 35
    }
}

/// A stretch of text in one style. Adjacent runs of a row always differ in style.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    /// The text; never contains a line break or a control character.
    pub text: String,
    /// How it is drawn.
    pub style: Style,
}

/// One screen row. Trailing default-style blanks are already trimmed (herdr pads rows to the pane
/// width); the pane width is [`Screen::cols`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// The styled text, left to right.
    pub runs: Vec<Run>,
    /// A fingerprint of the runs. Equal rows have equal hashes; a consumer that finds equal
    /// hashes may still compare the runs when a collision would matter.
    pub hash: u64,
}

impl Row {
    /// A row of `runs`, fingerprint included.
    pub fn new(runs: Vec<Run>) -> Row {
        let mut hasher = RowHasher::new();
        for run in &runs {
            hasher.run(&run.style, &run.text);
        }
        Row {
            runs,
            hash: hasher.finish(),
        }
    }

    /// The row as plain text, without styling.
    pub fn text(&self) -> String {
        self.runs.iter().map(|run| run.text.as_str()).collect()
    }

    /// Terminal cells the row's text occupies (wide characters count two, combining marks none).
    pub fn columns(&self) -> usize {
        self.runs.iter().map(|run| run.text.width()).sum()
    }
}

/// A pane screen: the rows of one `pane.read`, top to bottom.
#[derive(Clone, Debug, Default)]
pub struct Screen {
    /// The pane width in cells: the widest row before its padding was trimmed.
    pub cols: u16,
    /// The rows. A row that did not change since the previous parse is the same `Arc`, so a
    /// consumer can compare with [`Arc::ptr_eq`] (or `hash`) and rebind only what changed.
    pub rows: Vec<Arc<Row>>,
}

impl Screen {
    /// Parses `pane.read format=ansi` output. Rows end at LF (a CR before it is harmless); SGR
    /// state carries from row to row exactly as it does in a terminal. Every row equal to the
    /// row at the same index of `prev` is that row's `Arc`.
    pub fn parse(ansi: &str, prev: Option<&Screen>) -> Screen {
        parse::parse_ansi(ansi, prev)
    }

    /// Parses `pane.read format=text` output: one default-style run per row, control characters
    /// dropped. Rows are reused from `prev` like in [`Screen::parse`].
    pub fn parse_text(text: &str, prev: Option<&Screen>) -> Screen {
        parse::parse_plain(text, prev)
    }

    /// Every row as plain text, the shape the prompt detector reads.
    pub fn text_rows(&self) -> Vec<String> {
        self.rows.iter().map(|row| row.text()).collect()
    }

    /// The links in every row (`https://` URLs and file paths), top to bottom.
    pub fn links(&self) -> Vec<Link> {
        let mut found = Vec::new();
        for (index, row) in self.rows.iter().enumerate() {
            if !row.runs.is_empty() {
                found.extend(links::detect_row(&row.text(), index));
            }
        }
        found
    }
}

/// The 64-bit fingerprint of a row, computed over runs without building the row (the parser
/// compares a candidate to the previous row before allocating anything for it).
pub(crate) struct RowHasher(u64);

impl RowHasher {
    const K: u64 = 0x517c_c1b7_2722_0a95;

    pub(crate) fn new() -> RowHasher {
        RowHasher(0)
    }

    fn mix(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(Self::K);
    }

    /// Adds one run. The length goes in too, so moving a boundary between runs changes the hash.
    pub(crate) fn run(&mut self, style: &Style, text: &str) {
        self.mix(style.bits());
        self.mix(text.len() as u64);
        let (chunks, tail) = text.as_bytes().as_chunks::<8>();
        for chunk in chunks {
            self.mix(u64::from_le_bytes(*chunk));
        }
        if !tail.is_empty() {
            let mut word = [0u8; 8];
            word[..tail.len()].copy_from_slice(tail);
            self.mix(u64::from_le_bytes(word));
        }
    }

    pub(crate) fn finish(&self) -> u64 {
        self.0
    }
}
