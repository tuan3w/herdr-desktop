//! A [`Highlighter`] follows one block of code as it changes: the text of an AI reply that is still
//! streaming, a file being read. It keeps the last parse and the spans it gave, repaints only what the
//! change touched and splices the rest, so the spans before the change are the very same values and a
//! streamed block never recolours what was already drawn.

use std::ops::Range;
use std::time::Duration;

use super::lang::Lang;
use super::role::Span;
use super::tm::{self, Tm};
use super::ts::{self, Grammar, Parse};

/// How a block is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Syntax {
    /// Not coloured.
    Plain,
    /// A tree-sitter grammar with our queries.
    Tree(Lang),
    /// A TextMate grammar of the long tail, by the name it was found under.
    Text(String),
}

impl Syntax {
    /// The syntax for a block: its fence word, else the file it came from, else a cheap look at the
    /// text. A word nothing knows is plain, and so is `text`.
    pub fn resolve(fence: Option<&str>, path: Option<&str>, text: &str) -> Syntax {
        if let Some(lang) = Lang::detect(fence, path, text) {
            return if ts::supports(lang) {
                Syntax::Tree(lang)
            } else {
                Syntax::Text(tm::tm_name(lang).to_string())
            };
        }
        let candidates = [
            fence.map(super::lang::fence_word),
            path.and_then(|p| p.rsplit('/').next())
                .map(|f| f.rsplit_once('.').map_or(f, |(_, ext)| ext)),
        ];
        for name in candidates.into_iter().flatten() {
            if tm::find(name).is_some() {
                return Syntax::Text(name.to_string());
            }
        }
        Syntax::Plain
    }

    /// The name for the block's label: `TypeScript`, `Elixir`, or nothing for plain text.
    pub fn label(&self) -> Option<String> {
        match self {
            Syntax::Plain => None,
            Syntax::Tree(lang) => Some(lang.label().to_string()),
            Syntax::Text(name) => {
                Some(tm::find(name).map_or_else(|| name.clone(), |s| s.name.clone()))
            }
        }
    }
}

enum Engine {
    Plain,
    Tree {
        grammar: &'static Grammar,
        parse: Parse,
    },
    Text(Tm),
}

/// The longest a parse may take before it is cut off: far above any real block (2,000 lines parse in
/// under 20 ms), far below a hang.
const SLOW: Duration = Duration::from_millis(400);

/// What an update changed.
pub struct Update<'a> {
    /// Every span of the whole text, sorted, not overlapping.
    pub spans: &'a [Span],
    /// The bytes whose spans may differ from the last update's; before it, they are identical.
    pub dirty: Range<usize>,
}

/// The highlighter of one block.
pub struct Highlighter {
    engine: Engine,
    lang: Option<Lang>,
    text: String,
    spans: Vec<Span>,
}

impl Highlighter {
    pub fn new(syntax: &Syntax) -> Highlighter {
        let (engine, lang) = match syntax {
            Syntax::Plain => (Engine::Plain, None),
            Syntax::Tree(lang) => {
                match ts::grammar(*lang).and_then(|g| Parse::new(g).map(|p| (g, p))) {
                    Some((grammar, parse)) => (Engine::Tree { grammar, parse }, Some(*lang)),
                    None => (Engine::Plain, None),
                }
            }
            Syntax::Text(name) => match tm::find(name) {
                Some(syntax) => (Engine::Text(Tm::new(syntax)), None),
                None => (Engine::Plain, None),
            },
        };
        Highlighter {
            engine,
            lang,
            text: String::new(),
            spans: Vec::new(),
        }
    }

    /// Brings the spans up to date with `text`, which may be longer than the last text, shorter, or
    /// changed anywhere. A parse is cut off after `SLOW` (no spans for that text; the next one starts
    /// clean).
    pub fn update(&mut self, text: &str) -> Update<'_> {
        let dirty = self.run(text, SLOW).unwrap_or(0..0);
        Update {
            spans: &self.spans,
            dirty,
        }
    }

    /// As [`Highlighter::update`] for a caller that cannot wait: `None` when the text could not be read
    /// within `budget`, so it can try again off its thread.
    pub fn update_within(&mut self, text: &str, budget: Duration) -> Option<Update<'_>> {
        let dirty = self.run(text, budget)?;
        Some(Update {
            spans: &self.spans,
            dirty,
        })
    }

    fn run(&mut self, text: &str, budget: Duration) -> Option<Range<usize>> {
        let dirty = match &mut self.engine {
            Engine::Plain => 0..0,
            Engine::Text(tm) => {
                let (spans, dirty) = tm.update(text);
                self.spans = spans.to_vec();
                dirty
            }
            Engine::Tree { grammar, parse } => {
                let old_len = self.text.len();
                let Some((tree, dirty)) = parse.update(text, budget) else {
                    self.spans.clear();
                    self.text.clear();
                    return None;
                };
                if ts::injects(self.lang) {
                    self.spans = ts::paint_with_injections(grammar, tree, text);
                    0..text.len()
                } else {
                    let dirty = line_bounds(text, dirty);
                    let fresh = ts::paint(grammar, tree, text, dirty.clone());
                    splice(
                        &mut self.spans,
                        fresh,
                        &dirty,
                        text.len() as isize - old_len as isize,
                    );
                    dirty
                }
            }
        };
        self.text.clear();
        self.text.push_str(text);
        Some(dirty)
    }

    /// The spans of the last update.
    pub fn spans(&self) -> &[Span] {
        &self.spans
    }
}

/// `range` widened to whole lines of `text`.
fn line_bounds(text: &str, range: Range<usize>) -> Range<usize> {
    let start = text[..range.start.min(text.len())]
        .rfind('\n')
        .map_or(0, |i| i + 1);
    let end = text[range.end.min(text.len())..]
        .find('\n')
        .map_or(text.len(), |i| range.end.min(text.len()) + i);
    start..end
}

/// Replaces what `dirty` (in the new text) covers by `fresh`: spans that end before it stay, spans that
/// start after it move by `delta`, a span across an edge is cut at it.
fn splice(spans: &mut Vec<Span>, fresh: Vec<Span>, dirty: &Range<usize>, delta: isize) {
    let old_end = (dirty.end as isize - delta).max(0) as usize;
    let mut out: Vec<Span> = Vec::with_capacity(spans.len() + fresh.len());
    for s in spans.iter() {
        if (s.end as usize) <= dirty.start {
            out.push(*s);
        } else if (s.start as usize) < dirty.start {
            out.push(Span {
                end: dirty.start as u32,
                ..*s
            });
        }
    }
    for s in fresh {
        tm::push_span(&mut out, s);
    }
    for s in spans.iter() {
        if (s.start as usize) >= old_end {
            tm::push_span(
                &mut out,
                Span {
                    start: (s.start as isize + delta) as u32,
                    end: (s.end as isize + delta) as u32,
                    role: s.role,
                },
            );
        } else if (s.end as usize) > old_end {
            tm::push_span(
                &mut out,
                Span {
                    start: dirty.end as u32,
                    end: (s.end as isize + delta) as u32,
                    role: s.role,
                },
            );
        }
    }
    *spans = out;
}
