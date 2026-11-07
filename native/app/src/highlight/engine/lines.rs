//! The lines a code view draws, made from text and highlight spans without any widget: tabs expanded
//! to the next stop, trailing whitespace marked when asked, spans cut at line ends, word-level
//! emphasis merged into the runs. Plain data, so it is unit-tested without a window.

use std::ops::Range;

use unicode_width::UnicodeWidthChar;

use super::{Role, Span};

/// What a line is in a diff (a plain block is all `Context`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Context,
    Add,
    Remove,
}

/// A run of one look inside a displayed line (`start..end` are bytes of [`Line::text`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub start: u32,
    pub end: u32,
    pub role: Role,
    /// The words that changed inside a changed line: drawn on a stronger tint.
    pub emphasis: bool,
    /// A visible tab or trailing space (`→`, `·`).
    pub whitespace: bool,
}

/// One displayed line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    /// The text as drawn: tabs are spaces (or `→` and spaces when whitespace shows).
    pub text: String,
    pub runs: Vec<Run>,
    pub kind: Kind,
    /// Line numbers: `old` for removed and context lines of a diff, `new` for added and context
    /// lines; a plain block uses `new` only.
    pub old: Option<u32>,
    pub new: Option<u32>,
    /// The line is one a `file:line` reference points at.
    pub marked: bool,
}

/// How lines are made.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub tab_size: usize,
    pub whitespace: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            tab_size: 4,
            whitespace: false,
        }
    }
}

/// The lines of `text` (a `\n` ends one; a trailing `\n` does not start an empty one), coloured by
/// `spans` (sorted, byte offsets into `text`). Line numbers start at `first`.
pub fn lines(text: &str, spans: &[Span], first: u32, options: Options) -> Vec<Line> {
    let mut out = Vec::new();
    let mut at = 0usize;
    let mut span_at = 0usize;
    for (number, raw) in (first..).zip(text.split_inclusive('\n')) {
        let body = raw.strip_suffix('\n').unwrap_or(raw);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let range = at..at + body.len();
        while span_at < spans.len() && (spans[span_at].end as usize) <= range.start {
            span_at += 1;
        }
        let mut line = line_of(body, range.start, &spans[span_at..], options);
        line.new = Some(number);
        out.push(line);
        at += raw.len();
    }
    out
}

/// One line's text with the spans that touch it (offsets into the whole text, `base` the line's start).
pub fn line_of(body: &str, base: usize, spans: &[Span], options: Options) -> Line {
    // Break points: where a span starts or ends inside the line.
    let mut pieces: Vec<(Range<usize>, Role)> = Vec::new();
    let mut cursor = 0usize;
    for s in spans {
        let (s0, s1) = (s.start as usize, s.end as usize);
        if s0 >= base + body.len() {
            break;
        }
        let a = s0.saturating_sub(base).max(cursor);
        let b = (s1 - base.min(s1)).min(body.len());
        if a >= b {
            continue;
        }
        if a > cursor {
            pieces.push((cursor..a, Role::Plain));
        }
        pieces.push((a..b, s.role));
        cursor = b;
    }
    if cursor < body.len() {
        pieces.push((cursor..body.len(), Role::Plain));
    }
    let trailing = if options.whitespace {
        body.trim_end_matches([' ', '\t']).len()
    } else {
        body.len()
    };
    let mut text = String::with_capacity(body.len() + 8);
    let mut runs: Vec<Run> = Vec::with_capacity(pieces.len());
    let mut column = 0usize;
    for (range, role) in pieces {
        let piece = &body[range.clone()];
        let start = text.len();
        let mut plain_from = start;
        let flush = |_text: &str,
                     from: usize,
                     to: usize,
                     runs: &mut Vec<Run>,
                     role: Role,
                     whitespace: bool| {
            if from < to {
                push_run(
                    runs,
                    Run {
                        start: from as u32,
                        end: to as u32,
                        role,
                        emphasis: false,
                        whitespace,
                    },
                );
            }
        };
        for (i, ch) in piece.char_indices() {
            let abs = range.start + i;
            let in_trailing = options.whitespace && abs >= trailing;
            if ch == '\t' {
                flush(&text, plain_from, text.len(), &mut runs, role, false);
                let width = options.tab_size - column % options.tab_size;
                let from = text.len();
                if options.whitespace {
                    text.push('\u{2192}');
                    text.extend(std::iter::repeat_n(' ', width - 1));
                } else {
                    text.extend(std::iter::repeat_n(' ', width));
                }
                if options.whitespace {
                    flush(&text, from, text.len(), &mut runs, Role::Plain, true);
                } else {
                    flush(&text, from, text.len(), &mut runs, role, false);
                }
                column += width;
                plain_from = text.len();
            } else if ch == ' ' && in_trailing {
                flush(&text, plain_from, text.len(), &mut runs, role, false);
                let from = text.len();
                text.push('\u{00b7}');
                flush(&text, from, text.len(), &mut runs, Role::Plain, true);
                column += 1;
                plain_from = text.len();
            } else {
                text.push(ch);
                column += ch.width().unwrap_or(0);
            }
        }
        flush(&text, plain_from, text.len(), &mut runs, role, false);
    }
    Line {
        text,
        runs,
        kind: Kind::Context,
        old: None,
        new: None,
        marked: false,
    }
}

fn push_run(runs: &mut Vec<Run>, run: Run) {
    if let Some(last) = runs.last_mut()
        && last.end == run.start
        && last.role == run.role
        && last.emphasis == run.emphasis
        && last.whitespace == run.whitespace
    {
        last.end = run.end;
        return;
    }
    runs.push(run);
}

/// Marks byte ranges of a line's displayed text as changed words: the runs are cut at their edges.
pub fn emphasise(line: &mut Line, ranges: &[Range<usize>]) {
    if ranges.is_empty() {
        return;
    }
    let mut out: Vec<Run> = Vec::with_capacity(line.runs.len() + ranges.len() * 2);
    // Plain stretches between runs also need a run so that a changed word can be tinted.
    let mut covered = 0u32;
    let mut all: Vec<Run> = Vec::new();
    for run in &line.runs {
        if run.start > covered {
            all.push(Run {
                start: covered,
                end: run.start,
                role: Role::Plain,
                emphasis: false,
                whitespace: false,
            });
        }
        all.push(*run);
        covered = run.end;
    }
    if (covered as usize) < line.text.len() {
        all.push(Run {
            start: covered,
            end: line.text.len() as u32,
            role: Role::Plain,
            emphasis: false,
            whitespace: false,
        });
    }
    for run in all {
        let mut start = run.start as usize;
        let end = run.end as usize;
        for r in ranges {
            if r.end <= start || r.start >= end {
                continue;
            }
            let (a, b) = (r.start.max(start), r.end.min(end));
            if a > start {
                push_run(
                    &mut out,
                    Run {
                        start: start as u32,
                        end: a as u32,
                        ..run
                    },
                );
            }
            push_run(
                &mut out,
                Run {
                    start: a as u32,
                    end: b as u32,
                    emphasis: true,
                    ..run
                },
            );
            start = b;
        }
        if start < end {
            push_run(
                &mut out,
                Run {
                    start: start as u32,
                    end: end as u32,
                    ..run
                },
            );
        }
    }
    line.runs = out;
}

/// The widest line in columns (what a horizontal scroll must hold).
pub fn max_columns(lines: &[Line]) -> usize {
    lines
        .iter()
        .map(|l| {
            l.text
                .chars()
                .map(|c| c.width().unwrap_or(0))
                .sum::<usize>()
        })
        .max()
        .unwrap_or(0)
}

/// `3,7-9` as line numbers; anything that is not a number or a range is ignored.
pub fn parse_marks(spec: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        match part.split_once('-') {
            Some((a, b)) => {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                    out.extend(a..=b.min(a.saturating_add(10_000)));
                }
            }
            None => out.extend(part.parse::<u32>()),
        }
    }
    out
}
