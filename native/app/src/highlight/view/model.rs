//! The two components: props, state, highlighting and the rows each one hands to the renderer.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nsh_core::{element::measure_text, prelude::*};

use super::palette::palette;
use super::render::{self, Body, Geometry, Layout, Row};
use crate::highlight::diff::{self, DiffOptions, Pair, Unified};
use crate::highlight::lines::{self, Kind, Options};
use crate::highlight::{Highlighter, Lang, Span, Syntax};

/// Lines of text above which highlighting never runs on the engine thread, and bytes above which it
/// is too much to do there even when the grammar is loaded.
const SYNC_BYTES: usize = 24 * 1024;

/// Code with colours, a gutter and marks: a fenced block, a command's output, a file.
///
/// The view draws the text it is given and nothing else (no header, no copy button: `CodeBlock` in
/// TSX has those). A screen reader hears a group named `label` holding the text. Selecting and
/// copying works across lines; line numbers and signs are not selectable. Colours are the theme's
/// `code-*` tokens. The language is the fence's word (`tsx`, `rust,no_run`), else found from
/// `path`, else from the text's first lines (a shebang, a diff, JSON); a text nothing recognises is
/// drawn plain.
#[derive(Clone, Copy, PartialEq, Props)]
pub struct CodeViewProps {
    /// The text, which may grow while it is drawn (a streaming reply): spans already known stay.
    pub code: Prop<SharedString>,
    /// A fence's info string or a language name; `None` finds it from `path` and the text.
    #[prop(default)]
    pub language: Prop<Option<SharedString>>,
    /// The file the text came from, when it did: its name finds the language.
    #[prop(default)]
    pub path: Prop<Option<SharedString>>,
    /// Show line numbers in a muted gutter.
    #[prop(default)]
    pub line_numbers: Prop<bool>,
    /// The number of the first line (default 1).
    #[prop(default = 1)]
    pub first_line: Prop<u32>,
    /// Wrap long lines (default: scroll sideways, with a fade at the edges).
    #[prop(default)]
    pub wrap: Prop<bool>,
    /// Show tabs as `→` and trailing spaces as `·`.
    #[prop(default)]
    pub whitespace: Prop<bool>,
    /// Lines to mark as a `file:line` reference points at them: `3`, `3,7-9`.
    #[prop(default)]
    pub marks: Prop<Option<SharedString>>,
    /// Show only the first N lines (0: all): the folded state of a long block.
    #[prop(default)]
    pub visible_lines: Prop<u32>,
    /// A block taller than this many points scrolls inside itself (0: as tall as its lines).
    #[prop(default)]
    pub max_height: Prop<f32>,
    /// Font size in points (default 13).
    #[prop(default = 13.0)]
    pub font_size: Prop<f32>,
    /// Columns a tab advances to (default 4).
    #[prop(default = 4)]
    pub tab_size: Prop<u32>,
    /// The text is still being written: the view follows its end while it is taller than `maxHeight`.
    #[prop(default)]
    pub follow: Prop<bool>,
    /// What screen readers say the block is, e.g. `Code, TypeScript, 41 lines`.
    pub label: Prop<SharedString>,
    /// The font family (default the theme's `font-mono`).
    #[prop(default)]
    pub font_family: Prop<Option<SharedString>>,
}

/// A diff of two texts or a unified patch, syntax-highlighted on both sides, with the words that
/// changed marked, long unchanged stretches folded (press one to open it) and a `+`/`−` column and a
/// tint on every changed line, so colour is never the only signal. Give `old_text` and `new_text`,
/// or a `patch` (`git diff` output; one file, the first, is drawn: file headers are TSX's).
#[derive(Clone, Copy, PartialEq, Props)]
pub struct CodeDiffProps {
    /// The text before.
    #[prop(default)]
    pub old_text: Prop<SharedString>,
    /// The text after.
    #[prop(default)]
    pub new_text: Prop<SharedString>,
    /// A unified patch of one file, instead of two texts.
    #[prop(default)]
    pub patch: Prop<SharedString>,
    /// A language name; `None` finds it from `path`.
    #[prop(default)]
    pub language: Prop<Option<SharedString>>,
    /// The file the text came from: its name finds the language (a patch brings its own).
    #[prop(default)]
    pub path: Prop<Option<SharedString>>,
    /// `"unified"` (default) or `"split"`: old on the left, new on the right.
    #[prop(default)]
    pub layout: Prop<DiffLayout>,
    /// Unchanged lines kept around a change (default 3); the rest fold.
    #[prop(default = 3)]
    pub context: Prop<u32>,
    /// Wrap long lines (default: scroll sideways).
    #[prop(default)]
    pub wrap: Prop<bool>,
    /// Show tabs and trailing spaces.
    #[prop(default)]
    pub whitespace: Prop<bool>,
    /// A block taller than this many points scrolls inside itself (0: as tall as its rows).
    #[prop(default)]
    pub max_height: Prop<f32>,
    /// Font size in points (default 13).
    #[prop(default = 13.0)]
    pub font_size: Prop<f32>,
    /// Columns a tab advances to (default 4).
    #[prop(default = 4)]
    pub tab_size: Prop<u32>,
    /// What screen readers say the diff is, e.g. `Diff of src/auth.ts, 2 added, 1 removed`.
    pub label: Prop<SharedString>,
    /// The font family (default the theme's `font-mono`).
    #[prop(default)]
    pub font_family: Prop<Option<SharedString>>,
}

/// How a diff's two sides sit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum DiffLayout {
    /// One column: removed lines, then added ones.
    #[default]
    Unified,
    /// Two columns: the old text on the left, the new on the right.
    Split,
}

/// What a diff reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum CodeDiffEvent {
    /// The diff was read: its size, once and again when its text changes.
    Counts {
        /// Lines added.
        added: u32,
        /// Lines removed.
        removed: u32,
        /// How many groups of changes there are (what next-change keys step through).
        changes: u32,
    },
    /// A change was brought into view by `next_change`/`previous_change`.
    Change {
        /// Its index, from 0.
        index: u32,
    },
}

/// The methods of a [`CodeDiff`]'s ref.
pub struct CodeDiffApi {
    to_change: Rc<dyn Fn(i32) -> u32>,
}

#[methods]
impl CodeDiffApi {
    /// Moves to the next group of changes (wrapping) and returns its index.
    pub fn next_change(&self) -> u32 {
        (self.to_change)(1)
    }

    /// Moves to the previous group of changes (wrapping) and returns its index.
    pub fn previous_change(&self) -> u32 {
        (self.to_change)(-1)
    }
}

// ---- shared pieces --------------------------------------------------------------------------------

/// Rows compared by identity: a memo holding them notifies when a new list was made, and a row that
/// is the same `Rc` as before is not rebuilt.
#[derive(Clone)]
pub(super) struct RowsRef(pub Rc<Vec<Rc<Row>>>);

impl PartialEq for RowsRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// The language a view reads and the highlighter that follows its text.
type Current = (Syntax, Arc<Mutex<Highlighter>>);

/// What the highlighter last gave, with the text it was given.
#[derive(Clone)]
struct Coloured {
    text: Arc<str>,
    spans: Arc<Vec<Span>>,
}

impl PartialEq for Coloured {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.text, &other.text) && Arc::ptr_eq(&self.spans, &other.spans)
    }
}

/// Keeps the highlighter of one text and its latest spans; spans are valid for the prefix the new
/// text still shares with the one they were made for.
#[derive(Clone, Copy)]
struct Colouring {
    spans: Signal<Coloured>,
}

fn font_family(family: Option<SharedString>) -> SharedString {
    family
        .or_else(|| nsh_base::theme().font_mono.clone())
        .unwrap_or_else(|| "monospace".into())
}

fn css(family: &str, size: f32) -> String {
    match family {
        "monospace" | "ui-monospace" => format!("{size}px {family}"),
        _ => format!("{size}px \"{}\"", family.replace('"', "")),
    }
}

/// How wide one cell of the monospace face is per point of font size.
fn cell_ratio(family: &str) -> f32 {
    measure_text(&css(family, 100.0), "0000000000").0 / 10.0 / 100.0
}

/// Starts highlighting `code` for the language the props name, keeping `colouring` current: on the
/// spot when that is cheap, else on a blocking thread (a newer text makes an older result obsolete).
fn colour(
    code: Memo<SharedString>,
    syntax_of: impl Fn() -> (Option<SharedString>, Option<SharedString>) + 'static,
) -> Colouring {
    let colouring = Colouring {
        spans: signal(Coloured {
            text: Arc::from(""),
            spans: Arc::new(Vec::new()),
        }),
    };
    let state: Rc<RefCell<Option<Current>>> = Rc::new(RefCell::new(None));
    let generation = Rc::new(std::cell::Cell::new(0u64));
    let syntax_of = Rc::new(syntax_of);
    effect(move || {
        let text = code.get();
        let (language, path) = syntax_of();
        let quick = Lang::detect(language.as_deref(), path.as_deref(), &text);
        let mut slot = state.borrow_mut();
        // A different language starts a new highlighter; a growing text keeps the one it has.
        let wanted = quick.map(Syntax::Tree);
        let stale = match (&*slot, &wanted) {
            (Some((have, _)), Some(want)) => have != want,
            (None, _) => true,
            (Some((have, _)), None) => matches!(have, Syntax::Tree(_)),
        };
        if stale {
            let syntax = wanted
                .unwrap_or_else(|| Syntax::resolve(language.as_deref(), path.as_deref(), &text));
            *slot = Some((
                syntax.clone(),
                Arc::new(Mutex::new(Highlighter::new(&syntax))),
            ));
        }
        let Some((syntax, highlighter)) = slot.clone() else {
            return;
        };
        drop(slot);
        let now = generation.get() + 1;
        generation.set(now);
        let cheap = matches!(syntax, Syntax::Tree(lang) if crate::highlight::loaded(lang))
            && text.len() <= SYNC_BYTES;
        let text_arc: Arc<str> = Arc::from(&*text);
        // Cheap blocks are read on the spot, but never for long: a text that takes more than 8 ms
        // (or a grammar that loops on it) goes to the blocking thread like any other.
        let quick = if cheap {
            highlighter.lock().ok().and_then(|mut h| {
                h.update_within(&text, Duration::from_millis(8))
                    .map(|u| u.spans.to_vec())
            })
        } else {
            None
        };
        if matches!(syntax, Syntax::Plain) {
            colouring.spans.set(Coloured {
                text: text_arc,
                spans: Arc::new(Vec::new()),
            });
        } else if let Some(spans) = quick {
            colouring.spans.set(Coloured {
                text: text_arc,
                spans: Arc::new(spans),
            });
        } else {
            let generation = generation.clone();
            spawn(async move {
                let source = text_arc.clone();
                let job = blocking(move || {
                    highlighter
                        .lock()
                        .map(|mut h| h.update(&source).spans.to_vec())
                        .unwrap_or_default()
                })
                .await;
                if let Ok(spans) = job
                    && generation.get() == now
                {
                    colouring.spans.set(Coloured {
                        text: text_arc,
                        spans: Arc::new(spans),
                    });
                }
            });
        }
    });
    colouring
}

/// The spans of `colouring` that still describe the start of `text`.
fn valid_spans(coloured: &Coloured, text: &str) -> Vec<Span> {
    let shared = coloured
        .text
        .as_bytes()
        .iter()
        .zip(text.as_bytes())
        .take_while(|(a, b)| a == b)
        .count();
    // A span that ends in the last shared bytes may continue differently in the new text: keep only
    // those that end before the last line of the shared part ends.
    let cut = if shared == text.len() && shared == coloured.text.len() {
        shared
    } else {
        text[..shared].rfind('\n').map_or(0, |i| i + 1)
    };
    coloured
        .spans
        .iter()
        .filter(|s| (s.end as usize) <= cut)
        .copied()
        .collect()
}

/// A new list of rows that reuses the `Rc` of every row equal to the one at its place before.
fn reuse(previous: &RefCell<Rc<Vec<Rc<Row>>>>, fresh: Vec<Row>) -> RowsRef {
    let old = previous.borrow().clone();
    let rows: Vec<Rc<Row>> = fresh
        .into_iter()
        .enumerate()
        .map(|(i, row)| match old.get(i) {
            Some(same) if **same == row => same.clone(),
            _ => Rc::new(row),
        })
        .collect();
    let rows = Rc::new(rows);
    *previous.borrow_mut() = rows.clone();
    RowsRef(rows)
}

// ---- CodeView -------------------------------------------------------------------------------------

/// Code with colours, a gutter and marks.
#[component]
pub fn CodeView(props: CodeViewProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let code = computed(move || props.code.get());
    let colouring = colour(code, move || (props.language.get(), props.path.get()));
    let family = computed(move || font_family(props.font_family.get()));
    let ratio = computed(move || cell_ratio(&family.get()));
    let geometry =
        computed(move || Geometry::new(props.font_size.get(), ratio.get(), props.wrap.get()));

    let previous = RefCell::new(Rc::new(Vec::new()));
    let previous = Rc::new(previous);
    let rows = computed(move || {
        let text = code.get();
        let coloured = colouring.spans.get();
        let spans = valid_spans(&coloured, &text);
        let options = Options {
            tab_size: props.tab_size.get().max(1) as usize,
            whitespace: props.whitespace.get(),
        };
        let mut all = lines::lines(&text, &spans, props.first_line.get().max(1), options);
        let marks: HashSet<u32> = props
            .marks
            .get()
            .map(|m| lines::parse_marks(&m).into_iter().collect())
            .unwrap_or_default();
        if !marks.is_empty() {
            for line in &mut all {
                line.marked = line.new.is_some_and(|n| marks.contains(&n));
            }
        }
        let limit = props.visible_lines.get() as usize;
        if limit > 0 && all.len() > limit {
            all.truncate(limit);
        }
        reuse(&previous, all.into_iter().map(Row::Code).collect())
    });
    render::body(Body {
        rows,
        geometry,
        palette: computed(palette),
        family,
        label: props.label,
        line_numbers: computed(move || props.line_numbers.get()),
        max_height: computed(move || props.max_height.get()),
        wrap: computed(move || props.wrap.get()),
        layout: Layout::Code,
        on_fold: None,
        focus_row: None,
        list: element_ref(),
        follow: props.follow.get_untracked(),
        cut: Some(computed(move || {
            let limit = props.visible_lines.get() as usize;
            limit > 0 && code.get().split_inclusive('\n').count() > limit
        })),
    })
}

// ---- CodeDiff -------------------------------------------------------------------------------------

/// A diff of two texts or a patch.
#[component(methods = CodeDiffApi)]
pub fn CodeDiff(props: CodeDiffProps, cx: Scope<CodeDiffEvent>) -> impl IntoElement {
    let family = computed(move || font_family(props.font_family.get()));
    let ratio = computed(move || cell_ratio(&family.get()));
    let geometry = computed(move || {
        Geometry::new(
            props.font_size.get(),
            ratio.get(),
            props.wrap.get() && props.layout.get() == DiffLayout::Unified
                || props.layout.get() == DiffLayout::Split,
        )
    });
    let expanded: Signal<HashSet<u32>> = signal(HashSet::new());
    let focus: Signal<Option<usize>> = signal(None);
    let current: Signal<Option<usize>> = signal(None);
    let list = element_ref();
    let previous = Rc::new(RefCell::new(Rc::new(Vec::new())));

    // The diff itself: highlighting both sides is the expensive part, so a change of text recomputes
    // it, and opening a fold only re-folds.
    let unified = computed(move || {
        let (old, new, patch) = (
            props.old_text.get(),
            props.new_text.get(),
            props.patch.get(),
        );
        let options = DiffOptions {
            lines: Options {
                tab_size: props.tab_size.get().max(1) as usize,
                whitespace: props.whitespace.get(),
            },
            context: props.context.get() as usize,
        };
        let open = expanded.get();
        let syntax = || {
            Syntax::resolve(
                props.language.get().as_deref(),
                props.path.get().as_deref(),
                &new,
            )
        };
        let mut u = if !patch.is_empty() {
            diff::patch(&patch, options)
                .into_iter()
                .next()
                .map(|(_, u)| u)
                .unwrap_or_default()
        } else {
            diff::between(&old, &new, &syntax(), options, &open)
        };
        // Patch rows have hunk rows between changes; folds there are the hunks themselves.
        u.changes.retain(|i| *i < u.rows.len());
        UnifiedRef(Rc::new(u))
    });
    effect(move || {
        let u = unified.get().0;
        cx.emit(CodeDiffEvent::Counts {
            added: u.added,
            removed: u.removed,
            changes: u.changes.len() as u32,
        });
    });
    let rows = computed(move || {
        let u = unified.get().0;
        let fresh: Vec<Row> = match props.layout.get() {
            DiffLayout::Unified => u
                .rows
                .iter()
                .map(|r| match r {
                    diff::Row::Line(l) => Row::Code(l.clone()),
                    diff::Row::Fold { id, hidden } => Row::Fold {
                        id: *id,
                        hidden: *hidden,
                    },
                    diff::Row::Hunk(h) => Row::Hunk(h.clone()),
                })
                .collect(),
            DiffLayout::Split => diff::split(&u.rows)
                .into_iter()
                .map(|p| match p {
                    Pair::Lines(a, b) => Row::Split(a, b),
                    Pair::Fold { id, hidden } => Row::Fold { id, hidden },
                    Pair::Hunk(h) => Row::Hunk(h),
                })
                .collect(),
        };
        // Which row each change starts at differs between the layouts: remember it for the keys.
        let at = match props.layout.get() {
            DiffLayout::Unified => u.changes.clone(),
            DiffLayout::Split => split_change_rows(&u),
        };
        CHANGES.with(|c| *c.borrow_mut() = at);
        reuse(&previous, fresh)
    });

    cx.methods(CodeDiffApi {
        to_change: Rc::new(move |step| {
            let rows_of = CHANGES.with(|c| c.borrow().clone());
            if rows_of.is_empty() {
                return 0;
            }
            let n = rows_of.len() as i32;
            let next = match current.get_untracked() {
                None => {
                    if step > 0 {
                        0
                    } else {
                        n - 1
                    }
                }
                Some(i) => (i as i32 + step).rem_euclid(n),
            } as usize;
            current.set(Some(next));
            focus.set(Some(rows_of[next]));
            list.scroll_to_index(rows_of[next] as u32, Percentage(0.0), Points(0.0), false);
            cx.emit(CodeDiffEvent::Change { index: next as u32 });
            next as u32
        }),
    });

    render::body(Body {
        rows,
        geometry,
        palette: computed(palette),
        family,
        label: props.label,
        line_numbers: computed(|| true),
        max_height: computed(move || props.max_height.get()),
        wrap: computed(move || props.wrap.get() || props.layout.get() == DiffLayout::Split),
        layout: match props.layout.get_untracked() {
            DiffLayout::Unified => Layout::Unified,
            DiffLayout::Split => Layout::Split,
        },
        on_fold: Some(Rc::new(move |id| {
            expanded.update(|set| {
                set.insert(id);
            })
        })),
        focus_row: Some(computed(move || focus.get())),
        list,
        follow: false,
        cut: None,
    })
}

thread_local! {
    /// The row each group of changes starts at, as the current layout lays them out.
    static CHANGES: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
struct UnifiedRef(Rc<Unified>);

impl PartialEq for UnifiedRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// Where each change starts once removed and added lines sit side by side.
fn split_change_rows(u: &Unified) -> Vec<usize> {
    let pairs = diff::split(&u.rows);
    let mut out = Vec::new();
    let mut in_change = false;
    for (i, p) in pairs.iter().enumerate() {
        let changed = matches!(p, Pair::Lines(a, b) if a.as_ref().is_some_and(|l| l.kind != Kind::Context) || b.as_ref().is_some_and(|l| l.kind != Kind::Context));
        if changed && !in_change {
            out.push(i);
        }
        in_change = changed;
    }
    out
}
