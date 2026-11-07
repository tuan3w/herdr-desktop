//! Drawing rows: a gutter, a sign, the text as coloured spans, folds and hunk rows, in a plain column
//! or a virtual list, scrolling sideways with a fade at the edges or wrapping.

use std::rc::Rc;

use nsh_core::{EllipsizeMode, element::measure_text, prelude::*};
use unicode_width::UnicodeWidthChar;

use super::model::RowsRef;
use super::palette::{Colours, PaletteRef};
use crate::highlight::Role;
use crate::highlight::lines::{Kind, Line, Run};

/// What a row draws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Code(Line),
    Fold { id: u32, hidden: u32 },
    Hunk(String),
    Split(Option<Line>, Option<Line>),
}

/// The measurements one block is drawn with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub font_size: f32,
    pub line_height: f32,
    pub cell: f32,
    pub wrap: bool,
}

impl Geometry {
    pub fn new(font_size: f32, ratio: f32, wrap: bool) -> Geometry {
        let font_size = font_size.clamp(8.0, 40.0);
        Geometry {
            font_size,
            line_height: (font_size * 1.55).round(),
            cell: font_size * ratio.max(0.1),
            wrap,
        }
    }
}

/// How a diff lays its rows out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    Code,
    Unified,
    Split,
}

/// Everything the renderer needs from a component.
pub struct Body {
    pub rows: Memo<RowsRef>,
    pub geometry: Memo<Geometry>,
    pub palette: Memo<PaletteRef>,
    pub family: Memo<SharedString>,
    pub label: Prop<SharedString>,
    pub line_numbers: Memo<bool>,
    pub max_height: Memo<f32>,
    pub wrap: Memo<bool>,
    /// A memo, so a diff that turns into a new file (or the person choosing split) changes how its rows are drawn.
    pub layout: Memo<Layout>,
    pub on_fold: Option<Rc<dyn Fn(u32)>>,
    pub focus_row: Option<Memo<Option<usize>>>,
    pub list: ElementRef,
    /// Follow the end of the rows while they are taller than the view (a block still being written).
    pub follow: bool,
    /// The rows shown are a cut of more: fade the last of them.
    pub cut: Option<Memo<bool>>,
}

/// Rows above which a block is a virtual list instead of a plain column.
const VIRTUAL_ROWS: usize = 150;

/// The digits the widest line number needs.
fn digits(rows: &[Rc<Row>]) -> usize {
    let top = rows
        .iter()
        .filter_map(|r| match &**r {
            Row::Code(l) => Some(l.new.unwrap_or(0).max(l.old.unwrap_or(0))),
            Row::Split(a, b) => Some(
                a.iter()
                    .chain(b)
                    .map(|l| l.new.unwrap_or(0).max(l.old.unwrap_or(0)))
                    .max()
                    .unwrap_or(0),
            ),
            _ => None,
        })
        .max()
        .unwrap_or(0);
    top.max(9).to_string().len()
}

/// The columns a line takes: a tab advances to the next stop.
fn columns(line: &Line) -> usize {
    use crate::highlight::lines::TAB_STOP;
    line.text.chars().fold(0, |at, c| {
        if c == '\t' {
            at + TAB_STOP - at % TAB_STOP
        } else {
            at + c.width().unwrap_or(0)
        }
    })
}

/// The widest text of the rows, in cells.
fn widest(rows: &[Rc<Row>]) -> usize {
    rows.iter()
        .map(|r| match &**r {
            Row::Code(l) => columns(l),
            Row::Split(a, b) => a.iter().chain(b).map(columns).max().unwrap_or(0),
            Row::Hunk(h) => h.chars().count(),
            Row::Fold { .. } => 0,
        })
        .max()
        .unwrap_or(0)
}

pub fn body(b: Body) -> impl IntoElement {
    let Body {
        rows,
        geometry,
        palette,
        family,
        label,
        line_numbers,
        max_height,
        wrap,
        layout,
        on_fold,
        focus_row,
        list,
        follow,
        cut,
    } = b;
    let shown_digits = computed(move || {
        if layout.get() == Layout::Code && !line_numbers.get() {
            0
        } else {
            rows.with(|r| digits(&r.0))
        }
    });
    let (view_w, scroll_x, scroll_max) = (signal(0.0_f32), signal(0.0_f32), signal(0.0_f32));
    // The width of the text column in points: what a row that does not wrap needs.
    let content_w = computed(move || {
        let g = geometry.get();
        let gutter = gutter_width(layout.get(), shown_digits.get(), g.cell);
        gutter + rows.with(|r| widest(&r.0)) as f32 * g.cell + 2.0 * PAD_X
    });
    let scrolls = computed(move || {
        !wrap.get() && layout.get() != Layout::Split && content_w.get() > view_w.get() + 1.0
    });

    // A list builds a cell's content once and moves the cell to another row by changing its position,
    // so a row reads its index through `index` (a position, or a fixed number in a plain column).
    let row_at: Rc<dyn Fn(Index) -> AnyElement> = Rc::new(move |index: Index| {
        let at = index.clone();
        let row = computed(move || {
            let i = at();
            rows.with(|r| r.0.get(i).cloned())
        });
        row_view(
            row,
            index,
            geometry,
            palette,
            shown_digits,
            layout,
            on_fold.clone(),
            focus_row,
        )
        .into_element()
    });
    let count = computed(move || rows.with(|r| r.0.len()));

    // A block that fits its cap is a plain column (every row mounted, natural height); one that does
    // not, or that follows its end, is a virtual list with a height of its own. The memo changes only
    // when the block crosses from one to the other, so a growing block keeps its list.
    let lh = move || geometry.get().line_height;
    let cap = move || {
        let cap = max_height.get();
        if cap > 0.0 {
            cap
        } else {
            VIRTUAL_ROWS as f32 * lh()
        }
    };
    let virtual_mode = computed(move || follow || count.get() as f32 * lh() > cap());
    let make_list: Rc<dyn Fn() -> AnyElement> = Rc::new(move || {
        let row_at = row_at.clone();
        dynamic(move || {
            if virtual_mode.get() {
                let row_at = row_at.clone();
                let height = move || (count.get() as f32 * lh()).min(cap());
                let list_view = virtual_list(
                    move || count.get(),
                    move |at: Position| row_at(Rc::new(move || at.index())),
                )
                .estimated_item_size(move || Points(lh()))
                .element_ref(&list)
                .selectable(true)
                .size_full();
                let list_view = if follow {
                    list_view
                        .follow_end(move || Points(lh()))
                        .initial_scroll_index(count.get_untracked().saturating_sub(1))
                } else {
                    list_view
                };
                view()
                    .h(move || Length::from(Points(height())))
                    .child(list_view)
                    .into_element()
            } else {
                let row_at = row_at.clone();
                let column = dynamic(move || {
                    let n = count.get();
                    view().flex_col().w_full().children(
                        (0..n)
                            .map(|i| row_at(Rc::new(move || i)))
                            .collect::<Vec<_>>(),
                    )
                });
                // One selectable area, as the virtual list is: without it each line's text selects alone and a drag
                // across lines copies only the first one.
                view()
                    .w_full()
                    .flex_col()
                    .selectable(true)
                    .child(column)
                    .into_element()
            }
        })
        .into_element()
    });

    let sideways = dynamic(move || {
        if scrolls.get() {
            scroll()
                .horizontal()
                .size_full()
                .on_scroll(move |e: &ScrollEvent| {
                    scroll_x.set(e.offset.x.0);
                    scroll_max.set((e.content_size.width.0 - e.size.width.0).max(0.0));
                })
                .child(
                    view()
                        .w(move || Length::from(Points(content_w.get())))
                        .flex_shrink_0()
                        .child(make_list()),
                )
                .into_element()
        } else {
            view().w_full().child(make_list()).into_element()
        }
    });

    let fade = move |left: bool| {
        let visible = move || {
            if !scrolls.get() {
                return 0.0_f32;
            }
            if left {
                if scroll_x.get() > 1.0 { 1.0 } else { 0.0 }
            } else if scroll_x.get() < scroll_max.get() - 1.0 {
                1.0
            } else {
                0.0
            }
        };
        let mut v = view()
            .absolute()
            .top_0()
            .bottom_0()
            .w(px(28.0))
            .pointer_events(PointerEvents::None)
            .opacity(visible);
        v = if left {
            v.left_0().bg_linear_to_r()
        } else {
            v.right_0().bg_linear_to_l()
        };
        v.gradient_from(move || palette.get().0.bg)
            .gradient_to(move || palette.get().0.transparent)
    };
    let fade_bottom = cut.map(|cut| {
        view()
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .h(px(48.0))
            .pointer_events(PointerEvents::None)
            .opacity(move || if cut.get() { 1.0_f32 } else { 0.0 })
            .bg_linear_to_t()
            .gradient_from(move || palette.get().0.bg)
            .gradient_to(move || palette.get().0.transparent)
    });
    let fade_left = fade(true);
    let fade_right = fade(false);
    // `bg_linear_to_l` runs from the right edge to the left: its `from` is the colour at the edge.

    view()
        .role(AccessibilityRole::Group)
        .label(label)
        .w_full()
        .min_w(px(0.0))
        .overflow_hidden()
        .rounded_md()
        .bg(move || palette.get().0.bg)
        .font_family(move || family.get())
        .text_size(move || Length::from(Points(geometry.get().font_size)))
        .text_color(move || palette.get().0.role(Role::Plain))
        .on_layout(move |b: &Bounds<Points>| view_w.set(b.size.width.0))
        .child(view().w_full().pt(px(2.0)).pb(px(10.0)).child(sideways))
        .child(fade_left)
        .child(fade_right)
        .children(fade_bottom)
}

const PAD_X: f32 = 12.0;

/// Width of the gutter(s) and sign of a row, in points.
fn gutter_width(layout: Layout, digits: usize, cell: f32) -> f32 {
    let number = if digits == 0 {
        0.0
    } else {
        (digits as f32 + 2.0) * cell
    };
    match layout {
        Layout::Code => number,
        Layout::Unified => 2.0 * number.max(5.0 * cell) + 2.0 * cell,
        Layout::Split => number + 2.0 * cell,
    }
}

#[allow(clippy::too_many_arguments)]
fn row_view(
    row: Memo<Option<Rc<Row>>>,
    index: Index,
    geometry: Memo<Geometry>,
    palette: Memo<PaletteRef>,
    digits: Memo<usize>,
    layout: Memo<Layout>,
    on_fold: Option<Rc<dyn Fn(u32)>>,
    focus_row: Option<Memo<Option<usize>>>,
) -> impl IntoElement {
    dynamic(move || {
        let (g, pal, digits) = (geometry.get(), palette.get().0, digits.get());
        let layout = layout.get();
        let focused = focus_row.is_some_and(|f| f.get() == Some(index()));
        match row.get().as_deref() {
            None => view().into_element(),
            Some(Row::Code(line)) => code_row(line, g, &pal, digits, layout, focused),
            Some(Row::Split(old, new)) => {
                split_row(old.as_ref(), new.as_ref(), g, &pal, digits, focused)
            }
            // A new file drawn as plain code has one hunk, which says nothing the header does not.
            Some(Row::Hunk(_)) if layout == Layout::Code => view().into_element(),
            Some(Row::Hunk(text)) => note_row(text.clone(), g, &pal, pal.hunk_bg, None),
            Some(Row::Fold { id, hidden }) => {
                let label = format!(
                    "{hidden} unchanged line{}",
                    if *hidden == 1 { "" } else { "s" }
                );
                note_row(
                    label,
                    g,
                    &pal,
                    pal.hunk_bg,
                    on_fold.clone().map(|f| (f, *id)),
                )
            }
        }
    })
}

fn row_bg(kind: Kind, marked: bool, pal: &Colours) -> Option<AdaptiveColor> {
    match kind {
        Kind::Add => Some(pal.add_bg),
        Kind::Remove => Some(pal.remove_bg),
        Kind::Context if marked => Some(pal.line_bg),
        Kind::Context => None,
    }
}

fn gutter_text(n: Option<u32>, width: f32, g: Geometry, pal: &Colours) -> AnyElement {
    text(n.map(|n| n.to_string()).unwrap_or_default())
        .select_none()
        .w(Length::from(Points(width)))
        .flex_shrink_0()
        .text_right()
        .pr(px(g.cell * 1.5))
        .text_color(pal.gutter)
        .into_element()
}

fn sign_text(kind: Kind, g: Geometry, pal: &Colours) -> AnyElement {
    let (glyph, color) = match kind {
        Kind::Add => ("+", pal.role(Role::DiffAdd)),
        Kind::Remove => ("\u{2212}", pal.role(Role::DiffRemove)),
        Kind::Context => (" ", pal.gutter),
    };
    text(glyph)
        .select_none()
        .w(Length::from(Points(g.cell * 2.0)))
        .flex_shrink_0()
        .text_color(color)
        .into_element()
}

/// A line's text as one coloured span per run.
fn code_text(line: &Line, g: Geometry, pal: &Colours) -> AnyElement {
    let spans: Vec<AnyElement> = if line.runs.is_empty() {
        vec![text(line.text.clone()).into_element()]
    } else {
        let mut out = Vec::with_capacity(line.runs.len() + 1);
        let mut at = 0usize;
        let push_plain = |out: &mut Vec<AnyElement>, from: usize, to: usize| {
            if from < to {
                out.push(text(line.text[from..to].to_string()).into_element());
            }
        };
        for run in &line.runs {
            push_plain(&mut out, at, run.start as usize);
            out.push(run_span(
                &line.text[run.start as usize..run.end as usize],
                run,
                line.kind,
                pal,
            ));
            at = run.end as usize;
        }
        push_plain(&mut out, at, line.text.len());
        out
    };
    let mut t = text("")
        .select_text()
        .flex_1()
        .min_w(px(0.0))
        .children(spans);
    if !g.wrap {
        t = t.number_of_lines(1u32).text_overflow(EllipsizeMode::Clip);
    }
    t.into_element()
}

fn run_span(piece: &str, run: &Run, kind: Kind, pal: &Colours) -> AnyElement {
    let color = if run.whitespace {
        pal.whitespace
    } else {
        pal.role(run.role)
    };
    let mut t = text(piece.to_string()).text_color(color);
    if run.role.bold() {
        t = t.font_weight(FontWeight::MEDIUM);
    }
    if run.role.italic() {
        t = t.italic();
    }
    if run.role.underline() {
        t = t.underline();
    }
    if run.emphasis {
        t = t.bg(if kind == Kind::Remove {
            pal.remove_word
        } else {
            pal.add_word
        });
    }
    t.into_element()
}

fn code_row(
    line: &Line,
    g: Geometry,
    pal: &Colours,
    digits: usize,
    layout: Layout,
    focused: bool,
) -> AnyElement {
    let mut row = view()
        .flex_row()
        .w_full()
        .min_h(Length::from(Points(g.line_height)))
        .items_start()
        .pl(px(PAD_X * 0.5))
        .pr(px(PAD_X));
    // Plain code (`Layout::Code`, also a new file's diff) says nothing about added or removed: the file is
    // announced once, in the header, so no tint, no bar and no sign repeat it on every row.
    let kind = if layout == Layout::Code {
        Kind::Context
    } else {
        line.kind
    };
    if let Some(bg) = row_bg(kind, line.marked, pal) {
        row = row.bg(bg);
    }
    let number = (digits as f32 + 2.0) * g.cell;
    match layout {
        Layout::Code => {
            if digits > 0 {
                row = row.child(gutter_text(line.new, number, g, pal));
            }
        }
        Layout::Unified => {
            let width = number.max(5.0 * g.cell);
            row = row
                .child(gutter_text(line.old, width, g, pal))
                .child(gutter_text(line.new, width, g, pal))
                .child(sign_text(line.kind, g, pal));
        }
        Layout::Split => unreachable!("split rows are drawn by split_row"),
    }
    if layout == Layout::Code && digits == 0 {
        row = row.pl(px(PAD_X));
    }
    row = row.child(code_text(line, g, pal));
    row.with_bar(kind, focused, pal)
}

fn split_row(
    old: Option<&Line>,
    new: Option<&Line>,
    g: Geometry,
    pal: &Colours,
    digits: usize,
    focused: bool,
) -> AnyElement {
    let side = |line: Option<&Line>, number: fn(&Line) -> Option<u32>| -> AnyElement {
        let mut half = view()
            .flex_row()
            .flex_1()
            .min_w(px(0.0))
            .min_h(Length::from(Points(g.line_height)))
            .items_start()
            .pl(px(PAD_X * 0.5));
        match line {
            Some(l) => {
                if let Some(bg) = row_bg(l.kind, l.marked, pal) {
                    half = half.bg(bg);
                }
                half = half
                    .child(gutter_text(
                        number(l),
                        (digits as f32 + 2.0) * g.cell,
                        g,
                        pal,
                    ))
                    .child(sign_text(l.kind, g, pal))
                    .child(code_text(l, g, pal));
            }
            None => {
                half = half.bg(pal.hunk_bg);
            }
        }
        half.into_element()
    };
    let row = view()
        .flex_row()
        .w_full()
        .child(side(old, |l| l.old))
        .child(view().w(px(1.0)).bg(pal.border))
        .child(side(new, |l| l.new));
    let _ = focused;
    row.into_element()
}

/// A row that is a note: `@@ … @@` of a patch, or `N unchanged lines` (a button).
fn note_row(
    label: String,
    g: Geometry,
    pal: &Colours,
    bg: AdaptiveColor,
    press: Option<FoldPress>,
) -> AnyElement {
    let mut row = view()
        .flex_row()
        .w_full()
        .min_h(Length::from(Points(g.line_height)))
        .items_center()
        .pl(px(PAD_X))
        .bg(bg)
        .child(
            text(label.clone())
                .select_none()
                .text_color(pal.gutter)
                .number_of_lines(1u32)
                .text_overflow(EllipsizeMode::Clip),
        );
    if let Some((f, id)) = press {
        row = row
            .cursor_pointer()
            .on_press(move || f(id))
            .role(AccessibilityRole::Button)
            .label(format!("Show {label}"));
    }
    row.into_element()
}

/// The index of the row a cell shows, read where it is used so that a recycled cell follows its row.
type Index = Rc<dyn Fn() -> usize>;

/// What pressing a fold does and which fold it is.
type FoldPress = (Rc<dyn Fn(u32)>, u32);

trait WithBar {
    fn with_bar(self, kind: Kind, focused: bool, pal: &Colours) -> AnyElement;
}

impl WithBar for View {
    /// A 2 pt bar at the left edge of a changed line (a second cue next to the tint and the sign) and of
    /// the line a change key moved to.
    fn with_bar(self, kind: Kind, focused: bool, pal: &Colours) -> AnyElement {
        let color = match (kind, focused) {
            (Kind::Add, _) => Some(pal.role(Role::DiffAdd)),
            (Kind::Remove, _) => Some(pal.role(Role::DiffRemove)),
            (Kind::Context, true) => Some(pal.role(Role::DiffMeta)),
            _ => None,
        };
        match color {
            Some(c) => self
                .relative()
                .child(
                    view()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(px(2.0))
                        .bg(c),
                )
                .into_element(),
            None => self.into_element(),
        }
    }
}

#[allow(dead_code)]
fn unused() {
    let _ = measure_text;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_code_has_one_number_column_where_a_diff_has_two_and_a_sign() {
        let (code, unified) = (
            gutter_width(Layout::Code, 3, 8.0),
            gutter_width(Layout::Unified, 3, 8.0),
        );
        assert_eq!(code, 5.0 * 8.0);
        assert!(
            unified > 2.0 * code,
            "{unified} is not two columns and a sign"
        );
    }
}
