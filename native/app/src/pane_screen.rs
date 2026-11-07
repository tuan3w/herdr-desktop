//! `PaneScreen`: a read-only mirror of one herdr pane, drawn natively.
//!
//! herdr's `pane.read format=ansi` has no cursor and no mouse, so this is not a terminal: it shows the
//! rows the engine's [`PaneFeed`] holds and nothing else. Keys go to the pane through `Herdr.sendKeys`,
//! never through this view. The drawing follows nsh `main`'s `Terminal` (Apache-2.0,
//! see `NOTICE`): a virtualized list of one-row views, the cells' backgrounds as boxes behind the
//! text because a span's background covers only the glyphs' ink, the cell width measured from the
//! font. Rows are shared `Arc`s: a row whose `Arc` did not change since it was drawn is not touched,
//! so one new line in a 50-row screen rebinds one row.

mod follow;
pub(crate) mod ink;
mod layout;
mod news;
pub(crate) mod segments;
#[cfg(test)]
mod tests;

use std::{cell::RefCell, rc::Rc, sync::Arc, time::Duration};

use herdr_core::screen::{LinkKind, Rgb, Row, Screen, detect_links};
use nsh_base::{button, theme};
use nsh_core::{EllipsizeMode, element::measure_text, prelude::*};

use self::{
    follow::Pill,
    ink::{Ink, Palette, Resolved},
    news::{AttentionWatch, OutputGate},
    segments::{Fill, Segment, fills, segments},
};
use crate::feed::{self, FeedState, PaneFeed, PaneSource};
use crate::metrics;

/// How long after a polite output announcement the next one waits.
const ANNOUNCE_WINDOW: Duration = Duration::from_secs(2);

/// How long after the first rows and size a pane waits before it jumps to its end: the list has laid out by then.
const OPEN_SETTLE: Duration = Duration::from_millis(30);

/// How much of the pane the view shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum PaneContent {
    /// The pane's live screen.
    #[default]
    Visible,
    /// The scrollback, up to 1000 rows, ending with the live screen.
    Recent,
}

/// What a pressed link opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PaneLinkKind {
    /// An `http://` or `https://` address.
    Url,
    /// A file path on the machine the pane runs on.
    Path,
}

impl From<LinkKind> for PaneLinkKind {
    fn from(kind: LinkKind) -> Self {
        match kind {
            LinkKind::Url => PaneLinkKind::Url,
            LinkKind::Path => PaneLinkKind::Path,
        }
    }
}

/// A link in the pane's text.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PaneLink {
    /// What it opens.
    pub kind: PaneLinkKind,
    /// The URL, or the path without its `:line:col` suffix.
    pub target: String,
    /// The text as displayed.
    pub text: String,
    /// The line the text points at (1-based), when it gave one.
    pub line: Option<u32>,
    /// The column the text points at (1-based), when it gave one.
    pub col: Option<u32>,
    /// The row it is on, from the top of what the view shows (0-based).
    pub row: u32,
}

/// A read-only view of one herdr pane: its rows with colours, bold, italic, underline, links and
/// wide characters, following the end while you are at the end. It has no cursor and takes no keys.
/// The pane's columns fill the width (see `layout::plan`). Colours are the theme's `term-*` tokens,
/// each foreground lifted to `minContrast` against the cell behind it. Screen readers hear a group
/// named `label` holding the rows as text, and an assertive announcement when the agent in the pane
/// needs you.
#[derive(Clone, Copy, PartialEq, Props)]
pub struct PaneScreenProps {
    /// The machine the pane runs on: its id in `Herdr.machines()`.
    pub machine: Prop<SharedString>,
    /// The pane's id on that machine (`w1:p2`).
    pub pane: Prop<SharedString>,
    /// `"visible"` (default) shows the live screen, `"recent"` the scrollback.
    #[prop(default)]
    pub source: Prop<PaneContent>,
    /// The WCAG contrast every foreground reaches against its background: 1 leaves the colours as
    /// the agent sent them, 7 is the strictest (default 4.5).
    #[prop(default = 4.5)]
    pub min_contrast: Prop<f32>,
    /// What screen readers say the pane is, e.g. `Terminal, build agent on laptop`.
    pub label: Prop<SharedString>,
    /// The font family (default the theme's `font-mono`, else the system's monospaced font).
    pub font_family: Prop<Option<SharedString>>,
    /// The font size in points the pane's columns are scaled from: they fill the width (9 pt at the
    /// smallest, then the view scrolls sideways; never past twice this size). Default 13.
    #[prop(default = 13.0)]
    pub font_size: Prop<f32>,
    /// Have screen readers read new output: at most one polite announcement every two seconds, of
    /// the last 200 characters written (default off). The agent needing you is always announced.
    #[prop(default)]
    pub announce_output: Prop<bool>,
}

/// The events of a [`PaneScreen`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum PaneScreenEvent {
    /// A link in the text was pressed.
    Link {
        /// What it opens.
        kind: PaneLinkKind,
        /// The URL, or the path without its `:line:col` suffix.
        target: SharedString,
        /// The line the text points at (1-based), when it gave one.
        line: Option<u32>,
        /// The column the text points at (1-based), when it gave one.
        col: Option<u32>,
    },
    /// The cells that fit the view changed (first once it is laid out): the columns and rows at the
    /// size the text is drawn at.
    Cells {
        /// Columns that fit.
        cols: u32,
        /// Rows that fit.
        rows: u32,
    },
    /// The view reached the end of the pane or left it: only at the end does it follow new output.
    ScrollState {
        /// Whether the view shows the end.
        at_end: bool,
    },
}

/// The methods of a [`PaneScreen`]'s ref.
pub struct PaneScreenApi {
    links: Rc<dyn Fn() -> Vec<PaneLink>>,
    to_end: Rc<dyn Fn()>,
    rows: Rc<dyn Fn() -> Vec<String>>,
    to_row: Rc<dyn Fn(u32)>,
}

#[methods]
impl PaneScreenApi {
    /// Every link in the rows the view shows, top to bottom: what a keyboard user picks from, since
    /// a press needs a pointer.
    pub fn links(&self) -> Vec<PaneLink> {
        (self.links)()
    }

    /// The plain text of every row the view shows, top to bottom: the same rows, with the same
    /// indices, as `row` of `links()`. What search reads.
    pub fn rows(&self) -> Vec<String> {
        (self.rows)()
    }

    /// Scrolls so `row` (an index into `rows()`) is at the top of the view and stops following new
    /// output; the next scroll event puts the view back at the end if `row` was within the last
    /// screenful.
    pub fn scroll_to_row(&self, row: u32) {
        (self.to_row)(row);
    }

    /// Scrolls to the end of the pane and follows it again.
    pub fn scroll_to_end(&self) {
        (self.to_end)();
    }
}

/// A screen compared by identity: unchanged reads are the same `Arc`, and a signal or memo holding
/// one notifies only when the read produced a new one.
#[derive(Clone)]
struct ScreenRef(Arc<Screen>);

impl PartialEq for ScreenRef {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// A row compared by identity (`None`: past the end of the screen).
#[derive(Clone)]
struct RowRef(Option<Arc<Row>>);

impl PartialEq for RowRef {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

/// An open feed, compared by identity.
#[derive(Clone)]
struct FeedHandle(Option<Rc<dyn PaneFeed>>);

impl PartialEq for FeedHandle {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Rc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

/// The colours of one palette and contrast setting, compared by identity.
#[derive(Clone)]
struct InkRef(Rc<Ink>);

impl PartialEq for InkRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// What a row is drawn from: its pieces and the links among them, made once per row and kept until
/// the row changes.
struct Drawn {
    segments: Vec<Segment>,
    links: Vec<herdr_core::screen::Link>,
}

#[derive(Clone)]
struct DrawnRef(Rc<Drawn>);

impl PartialEq for DrawnRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// The CSS `font` shorthand `measure_text` takes.
pub(crate) fn font_css(family: &str, size: f32) -> String {
    match family {
        "monospace" | "ui-monospace" => format!("{size}px {family}"),
        _ => format!("{size}px \"{}\"", family.replace('"', "")),
    }
}

pub(crate) fn font_family(family: Option<SharedString>) -> SharedString {
    family
        .or_else(|| theme().font_mono.clone())
        .unwrap_or_else(|| "monospace".into())
}

/// What the view reads from the feed.
fn source_for(source: PaneContent) -> PaneSource {
    match source {
        PaneContent::Visible => PaneSource::Visible,
        PaneContent::Recent => PaneSource::Recent,
    }
}

fn to_rgb(color: Hsla) -> Rgb {
    let rgba = color.to_rgb();
    let byte = |channel: f32| (channel.clamp(0.0, 1.0) * 255.0).round() as u8;
    Rgb::new(byte(rgba.r), byte(rgba.g), byte(rgba.b))
}

/// The theme's terminal colours for the appearance now.
pub(crate) fn palette() -> Palette {
    let theme = theme();
    let dark = dark();
    let pick = |color: AdaptiveColor| to_rgb(if dark { color.dark } else { color.light });
    Palette::from_tokens(
        |name| theme.color(name).map(pick),
        pick(theme.background),
        pick(theme.foreground),
    )
}

pub(crate) fn token_color(
    name: &'static str,
    fallback: impl Fn() -> AdaptiveColor,
) -> AdaptiveColor {
    theme().color(name).unwrap_or_else(fallback)
}

pub(crate) fn adaptive(color: Rgb) -> AdaptiveColor {
    let packed = u32::from(color.r) << 16 | u32::from(color.g) << 8 | u32::from(color.b);
    AdaptiveColor::from(Hsla::from(nsh_core::color::rgb(packed)))
}

/// The pane's mirror state: what the feed last said.
#[derive(Clone, Copy)]
struct Mirror {
    screen: Signal<ScreenRef>,
    state: Signal<FeedState>,
    attention: Signal<Option<String>>,
    at_end: Signal<bool>,
    unseen: Signal<u32>,
}

/// A read-only mirror of one herdr pane.
#[component(methods = PaneScreenApi)]
pub fn PaneScreen(props: PaneScreenProps, cx: Scope<PaneScreenEvent>) -> impl IntoElement {
    let mirror = Mirror {
        screen: signal(ScreenRef(Arc::new(Screen::default()))),
        state: signal(FeedState::Gone),
        attention: signal(None),
        at_end: signal(true),
        unseen: signal(0),
    };
    let list_ref = element_ref();
    let (width, height) = (signal(0.0_f32), signal(0.0_f32));

    // The feed: opened for what is asked for, dropped (which stops the engine watching) when the
    // pane, the machine or what is read changes.
    let source = computed(move || source_for(props.source.get()));
    let feed = computed(move || {
        let (machine, pane) = (props.machine.get(), props.pane.get());
        FeedHandle(feed::open(machine.as_ref(), pane.as_ref(), source.get()).map(Rc::from))
    });
    watch_feed(props, feed, mirror);

    // The font: its cell width per point of font size is measured once per family (monospaced text
    // scales linearly), everything else follows from the width.
    let family = move || font_family(props.font_family.get());
    let cell_ratio = computed(move || {
        let css = font_css(&family(), 100.0);
        measure_text(&css, "0000000000").0 / 10.0 / 100.0
    });
    let shown = mirror.screen;
    let plan = computed(move || {
        let cols = shown.with(|s| s.0.cols);
        layout::plan(props.font_size.get(), width.get(), cols, cell_ratio.get())
    });
    let cell_width = computed(move || plan.get().cell_width);
    let line_height = computed(move || plan.get().line_height);
    let scrolls = computed(move || plan.get().scrolls);
    let content_width = computed(move || plan.get().content_width);

    let palette = computed(palette);
    let ink = computed(move || InkRef(Rc::new(Ink::new(palette.get(), props.min_contrast.get()))));

    // The cells that fit, once the size is known.
    let sent_cells = stored((0_u32, 0_u32));
    effect(move || {
        let (w, h) = (width.get(), height.get());
        let plan = plan.get();
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let cells = (
            u32::from(layout::columns_that_fit(w, plan.cell_width)),
            (h / plan.line_height).floor().max(1.0) as u32,
        );
        if sent_cells.replace(cells) != cells {
            cx.emit(PaneScreenEvent::Cells {
                cols: cells.0,
                rows: cells.1,
            });
        }
    });

    cx.methods(PaneScreenApi {
        links: Rc::new(move || {
            shown.with_untracked(|s| {
                s.0.links()
                    .into_iter()
                    .map(|l| PaneLink {
                        kind: l.kind.into(),
                        target: l.target,
                        text: l.text,
                        line: l.line,
                        col: l.col,
                        row: l.row as u32,
                    })
                    .collect()
            })
        }),
        to_end: Rc::new(move || jump_to_end(mirror, cx, list_ref)),
        rows: Rc::new(move || {
            shown.with_untracked(|s| s.0.rows.iter().map(|r| r.text()).collect())
        }),
        to_row: Rc::new(move |row| {
            list_ref.scroll_to_index(row, Percentage(0.0), Points(0.0), false);
            // A row near the end leaves the view at the end, which scroll events report themselves.
            set_at_end(mirror, cx, false);
        }),
    });

    let make_list = move || {
        let row_count = move || shown.with(|s| s.0.rows.len());
        virtual_list(row_count, move |at| {
            pane_row(cx, shown, ink, cell_width, line_height, at)
        })
        .estimated_item_size(move || Points(line_height.get()))
        .follow_end(move || Points(line_height.get()))
        .initial_scroll_index(shown.with_untracked(|s| s.0.rows.len().saturating_sub(1)))
        .element_ref(&list_ref)
        .selectable(true)
        .size_full()
        .on_scroll(move |e: &ScrollEvent| {
            let end = follow::at_end(
                e.offset.y.0,
                e.size.height.0,
                e.content_size.height.0,
                line_height.get_untracked(),
            );
            set_at_end(mirror, cx, end);
        })
    };

    // A pane taller than the view opens at its end, where its prompt is. `initial_scroll_index` cannot do it for a list
    // built before its first layout (the platform has no sizes yet to clamp the jump to) and the pane's first rows
    // usually arrive after the view is built, so once there are rows and a size, jump to the end once.
    let has_rows = computed(move || shown.with(|s| !s.0.rows.is_empty()));
    let opened_at_end = stored(false);
    effect(move || {
        if height.get() > 0.0 && has_rows.get() && !opened_at_end.replace(true) {
            set_timeout(OPEN_SETTLE, move || jump_to_end(mirror, cx, list_ref));
        }
    });
    let body = dynamic(move || {
        if scrolls.get() {
            // A row wider than the view: the rows sit in a box as wide as they are, which scrolls.
            scroll()
                .horizontal()
                .size_full()
                .child(
                    view()
                        .w(move || Length::from(Points(content_width.get())))
                        .flex_shrink_0()
                        .child(make_list()),
                )
                .into_element()
        } else {
            view().size_full().child(make_list()).into_element()
        }
    });

    let pill = computed(move || {
        Pill::for_view(
            mirror.at_end.get(),
            mirror.unseen.get(),
            mirror.attention.with(Option::is_some),
        )
    });
    let live = move || mirror.state.get() == FeedState::Live;

    view()
        .role(AccessibilityRole::Group)
        // Fills what its parent leaves it; the app's own class wins.
        .flex_1()
        .min_h(px(0.0))
        .min_w(px(0.0))
        .label(props.label)
        .overflow_hidden()
        .bg(move || token_color("term-bg", || theme().background))
        .font_family(move || font_family(props.font_family.get()))
        .text_size(move || Length::from(Points(plan.get().font_size)))
        .text_color(move || token_color("term-fg", || theme().foreground))
        .on_layout(move |b: &Bounds<Points>| {
            width.set(b.size.width.0);
            height.set(b.size.height.0);
        })
        // Text from a pane that is not being read is shown, but fainter than live text.
        .child(
            view()
                .size_full()
                .opacity(move || if live() { 1.0 } else { 0.6_f32 })
                .child(body),
        )
        .child(when(
            move || pill.get().is_some(),
            move || pill_view(mirror, cx, list_ref, pill, live),
        ))
        .child(when(move || !live(), move || notice_view(mirror.state)))
}

/// Opens the feed the memo holds into `mirror` and keeps it current: an initial pull, then one pull
/// per message on the feed's `changed()` channel, with the announcements and the unseen count that
/// go with a change. The task ends with the effect's run, that is when the feed is replaced.
fn watch_feed(props: PaneScreenProps, feed: Memo<FeedHandle>, mirror: Mirror) {
    effect(move || {
        let Some(open) = feed.get().0 else {
            // No such machine, or no engine: nothing to show, and it is said so.
            mirror.screen.set(ScreenRef(Arc::new(Screen::default())));
            mirror.state.set(FeedState::Gone);
            mirror.attention.set(None);
            return;
        };
        let label = props.label.get_untracked();
        let mut watch = News {
            last: open.screen(),
            painted_for: None,
            attention: AttentionWatch::starting_at(open.attention().as_deref()),
            gate: Rc::new(RefCell::new(OutputGate::default())),
        };
        mirror.unseen.set(0);
        mirror.screen.set(ScreenRef(watch.last.clone()));
        mirror.state.set(open.state());
        mirror.attention.set(open.attention());
        let changes = open.changed();
        spawn(async move {
            while changes.recv().await.is_ok() {
                watch.pull(&*open, props, &label, mirror);
            }
        });
    });
}

/// What one feed's task remembers between reads.
struct News {
    last: Arc<Screen>,
    /// The activity whose screen was last reported to the read-to-paint metric.
    painted_for: Option<std::time::Instant>,
    attention: AttentionWatch,
    gate: Rc<RefCell<OutputGate>>,
}

impl News {
    /// Brings `mirror` up to date with `feed`, saying what is new to the screen reader.
    fn pull(&mut self, feed: &dyn PaneFeed, props: PaneScreenProps, label: &str, mirror: Mirror) {
        let next = feed.screen();
        if !Arc::ptr_eq(&next, &self.last) {
            let away = !mirror.at_end.get_untracked();
            let announce = props.announce_output.get_untracked();
            if away || announce {
                let fresh = news::new_rows(&self.last, &next);
                if away && !fresh.is_empty() {
                    mirror.unseen.update(|n| *n += fresh.len() as u32);
                }
                if announce
                    && let Some(text) = news::announcement(&fresh)
                    && let Some(now) = self.gate.borrow_mut().push(&text)
                {
                    announce_for_accessibility(now);
                    close_window_later(self.gate.clone());
                }
            }
            metrics::rows_rebound(metrics::changed_rows(&self.last, &next));
            // Once per screen: a feed keeps reporting the activity of the screen it still shows.
            if let Some(activity) = feed.activity_at()
                && self.painted_for != Some(activity)
            {
                self.painted_for = Some(activity);
                metrics::screen_painted(activity);
            }
            self.last = next.clone();
            mirror.screen.set(ScreenRef(next));
        }
        mirror.state.set(feed.state());
        let attention = feed.attention();
        if let Some(question) = self.attention.changed(attention.as_deref()) {
            announce_for_accessibility(format!("{label} needs you: {question}"));
        }
        mirror.attention.set(attention);
    }
}

/// Opens the window after a polite announcement: what arrived meanwhile goes out when it closes, and
/// that opens the next window.
fn close_window_later(gate: Rc<RefCell<OutputGate>>) {
    set_timeout(ANNOUNCE_WINDOW, move || {
        let held = gate.borrow_mut().window_closed();
        if let Some(text) = held {
            announce_for_accessibility(text);
            close_window_later(gate);
        }
    });
}

/// The view reached the end of the pane or left it. Reaching it clears what was unseen below.
fn set_at_end(mirror: Mirror, cx: Scope<PaneScreenEvent>, end: bool) {
    if mirror.at_end.get_untracked() == end {
        return;
    }
    mirror.at_end.set(end);
    if end {
        mirror.unseen.set(0);
    }
    cx.emit(PaneScreenEvent::ScrollState { at_end: end });
}

fn jump_to_end(mirror: Mirror, cx: Scope<PaneScreenEvent>, list: ElementRef) {
    // Not animated: the scroll events of an animation would flip the view in and out of "at the
    // end" on the way and flash the pill.
    list.scroll_to_end(false);
    set_at_end(mirror, cx, true);
}

/// Row `at`: the cells' backgrounds, then the text.
fn pane_row(
    cx: Scope<PaneScreenEvent>,
    shown: Signal<ScreenRef>,
    ink: Memo<InkRef>,
    cell_width: Memo<f32>,
    line_height: Memo<f32>,
    at: Position,
) -> impl IntoElement {
    let row = computed(move || RowRef(shown.with(|s| s.0.rows.get(at.index()).cloned())));
    // Segments and links are made from the row alone, so a repaint for another reason (a new
    // palette, a font size) reuses them.
    let drawn = computed(move || {
        let row = row.get().0;
        let links = row
            .as_ref()
            .map(|r| detect_links(&r.text()))
            .unwrap_or_default();
        let segments = row
            .as_ref()
            .map(|r| segments(r, &links))
            .unwrap_or_default();
        DrawnRef(Rc::new(Drawn { segments, links }))
    });
    let backgrounds = dynamic(move || {
        let (drawn, ink, cw) = (drawn.get().0, ink.get().0, cell_width.get());
        let boxes: Vec<AnyElement> = fills(&drawn.segments, |style| ink.resolve(style).bg)
            .into_iter()
            .map(|fill| fill_box(fill, cw))
            .collect();
        view()
            .absolute()
            .top_0()
            .bottom_0()
            .left_0()
            .right_0()
            .pointer_events(PointerEvents::None)
            .children(boxes)
    });
    let line = dynamic(move || {
        let (drawn, ink) = (drawn.get().0, ink.get().0);
        let spans: Vec<AnyElement> = drawn
            .segments
            .iter()
            .map(|segment| span(segment, &drawn, &ink.resolve(&segment.style), cx))
            .collect();
        text("")
            .select_text()
            .number_of_lines(1u32)
            .text_overflow(EllipsizeMode::Clip)
            .children(spans)
    });
    view()
        .h(move || Length::from(Points(line_height.get())))
        .justify_center()
        .child(backgrounds)
        .child(line)
}

pub(crate) fn fill_box(fill: Fill, cell_width: f32) -> AnyElement {
    view()
        .absolute()
        .top_0()
        .bottom_0()
        .left(Length::from(Points(cell_width * f32::from(fill.col))))
        .w(Length::from(Points(cell_width * f32::from(fill.cols))))
        .bg(adaptive(fill.color))
        .into_element()
}

/// One styled piece of a row; a link is underlined and opens when pressed.
fn span(
    segment: &Segment,
    drawn: &Drawn,
    colors: &Resolved,
    cx: Scope<PaneScreenEvent>,
) -> AnyElement {
    let style = &segment.style;
    let mut piece = text(segment.text.clone()).text_color(adaptive(colors.fg));
    if style.bold {
        piece = piece.font_weight(FontWeight::BOLD);
    }
    if style.italic {
        piece = piece.italic();
    }
    if style.underline || segment.link.is_some() {
        piece = piece.underline();
    }
    if style.strike {
        piece = piece.line_through();
    }
    if colors.hidden {
        piece = piece.opacity(0.0);
    }
    if let Some(link) = segment.link.and_then(|i| drawn.links.get(i)) {
        let event = PaneScreenEvent::Link {
            kind: link.kind.into(),
            target: link.target.clone().into(),
            line: link.line,
            col: link.col,
        };
        piece = piece
            .cursor_pointer()
            .on_press(move || cx.emit(event.clone()));
    }
    piece.into_element()
}

/// The pill over a pane scrolled away from its end: a real button with a shape and words. The agent
/// needing you is the one loud thing; new lines are quiet.
fn pill_view(
    mirror: Mirror,
    cx: Scope<PaneScreenEvent>,
    list: ElementRef,
    pill: Memo<Option<Pill>>,
    live: impl Fn() -> bool + Copy + 'static,
) -> impl IntoElement {
    let label = move || pill.get().map(Pill::label).unwrap_or_default();
    let urgent = move || pill.get() == Some(Pill::NeedsYou);
    let glyph = move || if urgent() { "! " } else { "\u{2193} " };
    button()
        .accessibility_label(move || SharedString::from(label()))
        .on_press(move || jump_to_end(mirror, cx, list))
        .absolute()
        .right(px(16.0))
        .bottom(move || if live() { px(12.0) } else { px(44.0) })
        .min_h(px(28.0))
        .px_3()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(move || {
            if urgent() {
                token_color("signal", || theme().primary)
            } else {
                theme().border
            }
        })
        .bg(move || {
            if urgent() {
                token_color("signal", || theme().primary)
            } else {
                theme().popover
            }
        })
        .text_color(move || {
            if urgent() {
                token_color("signal-foreground", || theme().primary_foreground)
            } else {
                theme().popover_foreground
            }
        })
        .child(text(move || format!("{}{}", glyph(), label())).font_weight(FontWeight::SEMIBOLD))
}

/// The notice at the bottom of a pane that is not being read.
fn notice_view(state: Signal<FeedState>) -> impl IntoElement {
    let words = move || match state.get() {
        FeedState::Gone => "This pane is gone",
        _ => "Not live",
    };
    view()
        .role(AccessibilityRole::Alert)
        .label(move || SharedString::from(words()))
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .px_3()
        .py_1()
        .border_t(px(1.0))
        .border_t_color(move || theme().border)
        .bg(move || theme().popover)
        .child(text(words).text_color(move || theme().popover_foreground))
}
