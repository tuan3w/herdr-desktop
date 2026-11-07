//! A row as it is drawn: its styled runs cut at the edges of the links they hold, with the terminal
//! columns each piece covers, and the background boxes behind them.

use herdr_core::screen::{Link, Rgb, Row, Style};
use unicode_width::UnicodeWidthChar;

/// A piece of a row in one style, in at most one link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// The text, never empty.
    pub text: String,
    /// How its run is styled.
    pub style: Style,
    /// The terminal column it starts at (wide characters count two).
    pub col: u16,
    /// The columns it covers.
    pub cols: u16,
    /// Which of the row's links it is part of (an index into the links given to [`segments`]).
    pub link: Option<usize>,
}

/// `row`'s runs cut wherever a link starts or ends. `links` are the row's links, sorted and not
/// overlapping, as `detect_links` returns them.
pub fn segments(row: &Row, links: &[Link]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(row.runs.len());
    let mut col: u16 = 0;
    let mut next_link = 0;
    for run in &row.runs {
        let mut piece: Option<Segment> = None;
        for c in run.text.chars() {
            let width = c.width().unwrap_or(0) as u16;
            while links.get(next_link).is_some_and(|l| l.end_col <= col) {
                next_link += 1;
            }
            let link = links
                .get(next_link)
                .filter(|l| l.start_col <= col && col < l.end_col)
                .map(|_| next_link);
            match &mut piece {
                Some(open) if open.link == link => {
                    open.text.push(c);
                    open.cols += width;
                }
                _ => {
                    out.extend(piece.take());
                    piece = Some(Segment {
                        text: c.to_string(),
                        style: run.style,
                        col,
                        cols: width,
                        link,
                    });
                }
            }
            col = col.saturating_add(width);
        }
        out.extend(piece);
    }
    out
}

/// A box behind some cells of a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    /// First column.
    pub col: u16,
    /// Width in columns.
    pub cols: u16,
    /// Its colour.
    pub color: Rgb,
}

/// The backgrounds of `segments`: a span's own background covers only the ink of its glyphs, so the
/// cells' backgrounds are boxes behind the text, one per stretch of equal colour.
pub fn fills(segments: &[Segment], background: impl Fn(&Style) -> Option<Rgb>) -> Vec<Fill> {
    let mut out: Vec<Fill> = Vec::new();
    for segment in segments {
        let Some(color) = background(&segment.style) else {
            continue;
        };
        match out.last_mut() {
            Some(last) if last.color == color && last.col + last.cols == segment.col => {
                last.cols += segment.cols;
            }
            _ => out.push(Fill {
                col: segment.col,
                cols: segment.cols,
                color,
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use herdr_core::screen::{Color, LinkKind, Run, detect_links};

    use super::*;

    fn row(runs: &[(&str, Style)]) -> Row {
        Row::new(
            runs.iter()
                .map(|(text, style)| Run {
                    text: (*text).to_owned(),
                    style: *style,
                })
                .collect(),
        )
    }

    fn red() -> Style {
        Style {
            fg: Some(Color::Indexed(1)),
            ..Style::default()
        }
    }

    #[test]
    fn a_row_without_links_keeps_its_runs_and_columns() {
        let r = row(&[("ab", Style::default()), ("cd", red())]);
        let parts = segments(&r, &[]);
        assert_eq!(
            parts
                .iter()
                .map(|s| (s.text.as_str(), s.col, s.cols, s.link))
                .collect::<Vec<_>>(),
            [("ab", 0, 2, None), ("cd", 2, 2, None)]
        );
    }

    #[test]
    fn a_link_is_cut_out_of_its_run_and_keeps_the_runs_style() {
        let r = row(&[("see src/main.rs:42 now", red())]);
        let links = detect_links(&r.text());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].kind, LinkKind::Path);
        let parts = segments(&r, &links);
        assert_eq!(
            parts
                .iter()
                .map(|s| (s.text.as_str(), s.link))
                .collect::<Vec<_>>(),
            [("see ", None), ("src/main.rs:42", Some(0)), (" now", None)]
        );
        assert!(parts.iter().all(|s| s.style == red()));
        assert_eq!(parts.iter().map(|s| s.cols).sum::<u16>(), 22);
    }

    #[test]
    fn a_link_spanning_two_runs_is_two_segments_of_one_link() {
        let r = row(&[
            ("go to https://exa", Style::default()),
            ("mple.dev/a now", red()),
        ]);
        let links = detect_links(&r.text());
        assert_eq!(links.len(), 1);
        let parts = segments(&r, &links);
        let linked: Vec<&str> = parts
            .iter()
            .filter(|s| s.link == Some(0))
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(linked, ["https://exa", "mple.dev/a"]);
        assert_eq!(links[0].text, "https://example.dev/a");
    }

    #[test]
    fn wide_characters_take_two_columns_so_links_after_them_line_up() {
        let r = row(&[("日本 docs/a.md", Style::default())]);
        let links = detect_links(&r.text());
        let parts = segments(&r, &links);
        let linked = parts.iter().find(|s| s.link.is_some()).unwrap();
        assert_eq!(linked.text, "docs/a.md");
        assert_eq!(linked.col, 5, "two wide characters and a space");
    }

    #[test]
    fn backgrounds_merge_while_their_colour_and_columns_continue() {
        let blue = Style {
            bg: Some(Color::Rgb(0, 0, 200)),
            ..Style::default()
        };
        let r = row(&[("ab", blue), ("cd ", Style::default()), ("ef", blue)]);
        let parts = segments(&r, &[]);
        let boxes = fills(&parts, |s| s.bg.map(|_| Rgb::new(0, 0, 200)));
        assert_eq!(
            boxes,
            [
                Fill {
                    col: 0,
                    cols: 2,
                    color: Rgb::new(0, 0, 200)
                },
                Fill {
                    col: 5,
                    cols: 2,
                    color: Rgb::new(0, 0, 200)
                },
            ]
        );
    }

    #[test]
    fn a_link_inside_a_background_does_not_split_its_box() {
        let blue = Style {
            bg: Some(Color::Rgb(0, 0, 200)),
            ..Style::default()
        };
        let r = row(&[("open a/b.rs now", blue)]);
        let links = detect_links(&r.text());
        let parts = segments(&r, &links);
        assert!(parts.len() > 1);
        let boxes = fills(&parts, |s| s.bg.map(|_| Rgb::new(0, 0, 200)));
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].cols, 15);
    }
}
