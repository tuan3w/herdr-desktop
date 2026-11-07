//! `pane.read` text to [`Screen`] rows through `vte`.
//!
//! A row is built in reusable scratch buffers and compared with the row at the same index of the
//! previous screen before anything is allocated for it, so a re-read of an unchanged screen costs
//! no allocation per row.

use std::sync::Arc;

use unicode_width::UnicodeWidthStr;
use vte::{Params, Parser, Perform};

use super::{Color, Row, RowHasher, Run, Screen, Style};

/// Parses `format=ansi` text; see [`Screen::parse`].
pub(super) fn parse_ansi(text: &str, prev: Option<&Screen>) -> Screen {
    let mut parser = Parser::new();
    build(text, prev, |builder, line| {
        parser.advance(builder, line.as_bytes());
        // CAN aborts an unterminated escape string, so a stray OSC cannot swallow the rows
        // below it (vte would otherwise stay inside it across the line feed).
        parser.advance(builder, &[0x18]);
    })
}

/// Parses `format=text` text; see [`Screen::parse_text`].
pub(super) fn parse_plain(text: &str, prev: Option<&Screen>) -> Screen {
    build(text, prev, |builder, line| {
        for c in line.chars() {
            match c {
                '\t' => builder.put(' '),
                c if c.is_control() => {}
                c => builder.put(c),
            }
        }
    })
}

/// Splits `text` at line feeds and has `feed` draw each line into a builder. A trailing line feed
/// does not start another line, and text after the last line feed is a row only if it showed
/// something (a tail of bare escape sequences is not a row).
fn build(text: &str, prev: Option<&Screen>, mut feed: impl FnMut(&mut Builder, &str)) -> Screen {
    let mut builder = Builder::new(prev);
    let mut rest = text;
    loop {
        let (line, next) = match rest.split_once('\n') {
            Some((line, next)) => (line, Some(next)),
            None => (rest, None),
        };
        if next.is_none() && line.is_empty() {
            break;
        }
        builder.begin_line();
        feed(&mut builder, line);
        let keep = next.is_some() || builder.shown;
        builder.end_line(keep);
        match next {
            Some(next) => rest = next,
            None => break,
        }
    }
    builder.finish()
}

/// One line's runs while it is being drawn: a style and where its text ends in the line buffer.
struct Span {
    style: Style,
    end: usize,
}

/// Draws lines, owns the SGR state that carries from line to line, and collects the rows.
struct Builder<'p> {
    prev: Option<&'p Screen>,
    rows: Vec<Arc<Row>>,
    cols: usize,
    /// The SGR state; persists across lines like in a terminal.
    style: Style,
    /// The last span's style is `style`, so printing extends it instead of comparing styles.
    span_open: bool,
    text: String,
    spans: Vec<Span>,
    /// Something was drawn on the current line (even if padding trimming empties it).
    shown: bool,
    /// A lone CR was seen: the next text replaces the line so far (progress meters redraw this way).
    carriage_return: bool,
}

impl<'p> Builder<'p> {
    fn new(prev: Option<&'p Screen>) -> Self {
        Builder {
            prev,
            rows: Vec::with_capacity(prev.map_or(0, |p| p.rows.len())),
            cols: 0,
            style: Style::default(),
            span_open: false,
            text: String::with_capacity(256),
            spans: Vec::with_capacity(16),
            shown: false,
            carriage_return: false,
        }
    }

    fn begin_line(&mut self) {
        self.text.clear();
        self.spans.clear();
        self.span_open = false;
        self.shown = false;
        self.carriage_return = false;
    }

    /// Draws one character in the current style.
    fn put(&mut self, c: char) {
        if self.carriage_return {
            self.text.clear();
            self.spans.clear();
            self.span_open = false;
            self.carriage_return = false;
        }
        self.shown = true;
        self.text.push(c);
        let end = self.text.len();
        if self.span_open
            && let Some(span) = self.spans.last_mut()
        {
            span.end = end;
            return;
        }
        match self.spans.last_mut() {
            Some(span) if span.style == self.style => span.end = end,
            _ => self.spans.push(Span {
                style: self.style,
                end,
            }),
        }
        self.span_open = true;
    }

    /// Finishes the line: trims padding, widens `cols`, and appends the row when `keep`.
    fn end_line(&mut self, keep: bool) {
        if !keep {
            return;
        }
        // Width is taken before trimming: the pane width includes herdr's padding.
        self.cols = self.cols.max(self.text.width());
        self.trim_padding();
        let index = self.rows.len();
        let reused = self
            .prev
            .and_then(|prev| prev.rows.get(index))
            .filter(|row| self.same_as(row));
        let row = match reused {
            Some(row) => Arc::clone(row),
            None => Arc::new(self.materialize()),
        };
        self.rows.push(row);
    }

    /// herdr pads lines to the pane width. Padding is only invisible on the default background,
    /// so runs that paint blanks keep it.
    fn trim_padding(&mut self) {
        while let Some(span) = self.spans.last() {
            if span.style.paints_blanks() {
                return;
            }
            let start = match self.spans.len() {
                1 => 0,
                n => self.spans[n - 2].end,
            };
            let kept = self.text[start..span.end].trim_end_matches(' ').len() + start;
            if kept == span.end {
                return;
            }
            self.text.truncate(kept);
            if kept == start {
                self.spans.pop();
            } else if let Some(last) = self.spans.last_mut() {
                last.end = kept;
                return;
            }
        }
    }

    /// Whether the line in the scratch buffers is exactly `row`.
    fn same_as(&self, row: &Row) -> bool {
        if row.runs.len() != self.spans.len() {
            return false;
        }
        let mut start = 0;
        for (run, span) in row.runs.iter().zip(&self.spans) {
            if run.style != span.style || run.text != self.text[start..span.end] {
                return false;
            }
            start = span.end;
        }
        true
    }

    fn hash(&self) -> u64 {
        let mut hasher = RowHasher::new();
        let mut start = 0;
        for span in &self.spans {
            hasher.run(&span.style, &self.text[start..span.end]);
            start = span.end;
        }
        hasher.finish()
    }

    fn materialize(&self) -> Row {
        let mut start = 0;
        let runs = self
            .spans
            .iter()
            .map(|span| {
                let run = Run {
                    text: self.text[start..span.end].to_owned(),
                    style: span.style,
                };
                start = span.end;
                run
            })
            .collect();
        Row {
            runs,
            hash: self.hash(),
        }
    }

    fn finish(self) -> Screen {
        Screen {
            cols: u16::try_from(self.cols).unwrap_or(u16::MAX),
            rows: self.rows,
        }
    }

    /// Applies one SGR sequence to the current style.
    fn sgr(&mut self, params: &Params) {
        let mut groups: [&[u16]; 32] = [&[]; 32];
        let mut count = 0;
        for group in params.iter().take(32) {
            groups[count] = group;
            count += 1;
        }
        let groups = &groups[..count];
        let before = self.style;
        if groups.is_empty() {
            self.style = Style::default();
        }
        let mut k = 0;
        while k < groups.len() {
            let group = groups[k];
            let code = group.first().copied().unwrap_or(0);
            k += 1;
            match code {
                38 | 48 => {
                    let (color, used) = extended_color(group, &groups[k..]);
                    k += used;
                    if let Some(color) = color {
                        if code == 38 {
                            self.style.fg = Some(color);
                        } else {
                            self.style.bg = Some(color);
                        }
                    }
                }
                _ => self.simple_code(code, group),
            }
        }
        if self.style != before {
            self.span_open = false;
        }
    }

    fn simple_code(&mut self, code: u16, group: &[u16]) {
        let style = &mut self.style;
        match code {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            // `4:0` is the colon form of "underline off".
            4 => style.underline = group.get(1) != Some(&0),
            7 => style.inverse = true,
            8 => style.hidden = true,
            9 => style.strike = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            28 => style.hidden = false,
            29 => style.strike = false,
            30..=37 => style.fg = Some(Color::Indexed((code - 30) as u8)),
            39 => style.fg = None,
            40..=47 => style.bg = Some(Color::Indexed((code - 40) as u8)),
            49 => style.bg = None,
            90..=97 => style.fg = Some(Color::Indexed((code - 90) as u8 + 8)),
            100..=107 => style.bg = Some(Color::Indexed((code - 100) as u8 + 8)),
            _ => {}
        }
    }
}

/// The colour introduced by a `38`/`48` parameter and how many following parameters it consumed.
///
/// The colon form (`38:2::r:g:b`) keeps its arguments inside `group`; the semicolon form
/// (`38;2;r;g;b`) spreads them over the next parameters. An incomplete or out-of-range colour
/// leaves the current one untouched.
fn extended_color(group: &[u16], following: &[&[u16]]) -> (Option<Color>, usize) {
    if group.len() > 1 {
        return (color_args(&group[1..]), 0);
    }
    let first = |i: usize| following.get(i).and_then(|g| g.first().copied());
    let wanted = match first(0) {
        Some(5) => 2,
        Some(2) => 4,
        _ => 0,
    };
    if wanted == 0 || following.len() < wanted {
        return (None, following.len().min(wanted.max(1)));
    }
    let mut args = [0u16; 4];
    for (i, arg) in args.iter_mut().enumerate().take(wanted) {
        *arg = first(i).unwrap_or(0);
    }
    (color_args(&args[..wanted]), wanted)
}

/// A colour from `[mode, args…]`; the `2` form may carry an (usually empty) colour-space id.
fn color_args(args: &[u16]) -> Option<Color> {
    match args {
        [5, n, ..] => u8::try_from(*n).ok().map(Color::Indexed),
        [2, rest @ ..] if rest.len() >= 3 => {
            let [r, g, b] = if rest.len() >= 4 {
                [rest[1], rest[2], rest[3]]
            } else {
                [rest[0], rest[1], rest[2]]
            };
            Some(Color::Rgb(
                u8::try_from(r).ok()?,
                u8::try_from(g).ok()?,
                u8::try_from(b).ok()?,
            ))
        }
        _ => None,
    }
}

impl Perform for Builder<'_> {
    fn print(&mut self, c: char) {
        // DEL and the C1 controls (which arrive as characters once decoded) are not text.
        if !c.is_control() {
            self.put(c);
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.carriage_return = true,
            b'\t' => self.put(' '),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        // Private (`?`, `>`...) and intermediate forms are other sequences that happen to end in `m`.
        if action == 'm' && intermediates.is_empty() && !ignore {
            self.sgr(params);
        }
    }
}
