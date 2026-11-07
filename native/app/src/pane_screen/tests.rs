//! `PaneScreen` on a headless engine, fed by a scripted pane (`TestFeed`): what a person would notice
//! (which rows were redrawn, the pill, the notices, what a screen reader is told, link presses, the
//! fit) rather than how the view is wired.

use std::{
    collections::HashMap,
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

use async_channel::{Receiver, Sender};
use herdr_core::screen::{Rgb, Screen, contrast_ratio};
use nsh_core::{
    Command, MountItem,
    element::Root,
    geometry::{px, size},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use parking_lot::Mutex;

use super::*;

/// A pane the test scripts: what the engine's feed would hold.
struct TestFeed {
    screen: Mutex<Arc<Screen>>,
    state: Mutex<FeedState>,
    attention: Mutex<Option<String>>,
    wake: Sender<()>,
    woken: Receiver<()>,
}

impl TestFeed {
    fn new() -> Arc<TestFeed> {
        let (wake, woken) = async_channel::bounded(1);
        Arc::new(TestFeed {
            screen: Mutex::new(Arc::new(Screen::default())),
            state: Mutex::new(FeedState::Live),
            attention: Mutex::new(None),
            wake,
            woken,
        })
    }

    fn notify(&self) {
        // One pending message is all the contract promises: a full channel already says "changed".
        let _ = self.wake.try_send(());
    }

    /// Reads `ansi`, as the engine does, keeping the rows that did not change.
    fn show_ansi(&self, ansi: &str) {
        let mut screen = self.screen.lock();
        *screen = Arc::new(Screen::parse(ansi, Some(&screen)));
        drop(screen);
        self.notify();
    }

    fn show(&self, rows: &[String]) {
        self.show_ansi(&rows.join("\r\n"));
    }

    fn set_state(&self, state: FeedState) {
        *self.state.lock() = state;
        self.notify();
    }

    fn set_attention(&self, question: Option<&str>) {
        *self.attention.lock() = question.map(str::to_owned);
        self.notify();
    }
}

struct Handle(Arc<TestFeed>);

impl PaneFeed for Handle {
    fn screen(&self) -> Arc<Screen> {
        self.0.screen.lock().clone()
    }

    fn state(&self) -> FeedState {
        *self.0.state.lock()
    }

    fn attention(&self) -> Option<String> {
        self.0.attention.lock().clone()
    }

    fn changed(&self) -> Receiver<()> {
        self.0.woken.clone()
    }
}

/// Every test's panes, by id on machine `m`.
#[derive(Default)]
struct Panes(Mutex<HashMap<String, Arc<TestFeed>>>);

impl feed::FeedProvider for Panes {
    fn open(&self, machine: &str, pane: &str, _source: PaneSource) -> Option<Box<dyn PaneFeed>> {
        let panes = self.0.lock();
        let feed = panes.get(pane).filter(|_| machine == "m")?;
        Some(Box::new(Handle(feed.clone())))
    }
}

/// A new scripted pane `pane` the next `PaneScreen` of that id opens.
fn pane(pane: &str) -> Arc<TestFeed> {
    static PANES: LazyLock<Arc<Panes>> = LazyLock::new(Arc::default);
    // Every test installs it: the provider is process-wide, and so is its table of panes.
    feed::set_provider(PANES.clone());
    let feed = TestFeed::new();
    PANES.0.lock().insert(pane.to_owned(), feed.clone());
    feed
}

fn lines(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|i| format!("{prefix} {i}")).collect()
}

fn start<C: Component>(width: f32, height: f32, clock: Option<nsh_core::time::Clock>) -> Headless
where
    C::Props: Default,
{
    let config = EngineConfig {
        viewport: size(px(width), px(height)),
        clock: clock.unwrap_or_default(),
        ..EngineConfig::new(Root::of::<C>())
    };
    Headless::start(config).expect("the engine starts")
}

const LABEL: &str = "Terminal, test agent on laptop";

fn mirror(pane: &'static str) -> PaneScreenElement {
    pane_screen()
        .machine("m")
        .pane(pane)
        .label(LABEL)
        .fit(PaneFit::Actual)
        .font_size(10.0)
}

// Screens the tests open. A harness is one component per scenario: the engine builds it from its type.

#[component]
fn Fifty() -> impl IntoElement {
    view().size_full().child(mirror("fifty"))
}

#[component]
fn Scrolled() -> impl IntoElement {
    let following = signal(String::from("following unknown"));
    view()
        .size_full()
        .child(
            mirror("scrolled").on_scroll_state(move |e: &PaneScreenEvent| {
                if let PaneScreenEvent::ScrollState { at_end } = e {
                    following.set(format!("following {at_end}"));
                }
            }),
        )
        .child(text(move || following.get()))
}

#[component]
fn Late() -> impl IntoElement {
    view().size_full().child(mirror("late"))
}

#[component]
fn Blocked() -> impl IntoElement {
    view().size_full().child(mirror("blocked"))
}

#[component]
fn Silent() -> impl IntoElement {
    view().size_full().child(mirror("silent"))
}

#[component]
fn Notices() -> impl IntoElement {
    view().size_full().child(mirror("notices"))
}

#[component]
fn Spoken() -> impl IntoElement {
    view()
        .size_full()
        .child(mirror("spoken").announce_output(true))
}

#[component]
fn Questions() -> impl IntoElement {
    view().size_full().child(mirror("questions"))
}

#[component]
fn Linked() -> impl IntoElement {
    let opened = signal(String::from("nothing opened"));
    view()
        .size_full()
        .child(mirror("linked").on_link(move |e: &PaneScreenEvent| {
            if let PaneScreenEvent::Link {
                kind,
                target,
                line,
                col,
            } = e
            {
                opened.set(format!("opened {kind:?} {target} {line:?} {col:?}"));
            }
        }))
        .child(text(move || opened.get()))
}

#[component]
fn Fitted() -> impl IntoElement {
    view()
        .size_full()
        .child(
            mirror("fitted")
                .fit(PaneFit::Width)
                .on_cells(move |e: &PaneScreenEvent| {
                    if let PaneScreenEvent::Cells { cols, rows } = e {
                        CELLS.lock().push((*cols, *rows));
                    }
                }),
        )
}

/// What `Fitted` heard from `onCells`.
static CELLS: Mutex<Vec<(u32, u32)>> = Mutex::new(Vec::new());

#[component]
fn Painted() -> impl IntoElement {
    view().size_full().child(mirror("painted"))
}

#[component]
fn Missing() -> impl IntoElement {
    view()
        .size_full()
        .child(pane_screen().machine("nowhere").pane("p").label(LABEL))
}

/// What the engine told the platform to change, counted from the batches a test applies.
#[derive(Clone, Default)]
struct Changes {
    items: Arc<AtomicUsize>,
    texts: Arc<AtomicUsize>,
}

impl Changes {
    fn watch(&self, app: &mut Headless) {
        let (items, texts) = (self.items.clone(), self.texts.clone());
        app.observe(move |_, batch| {
            items.fetch_add(batch.items.len(), Ordering::SeqCst);
            let rewritten = batch
                .items
                .iter()
                .filter(|item| matches!(item, MountItem::Text { .. }))
                .count();
            texts.fetch_add(rewritten, Ordering::SeqCst);
        });
    }

    /// `(mount items, rewritten texts)` since the last call.
    fn take(&self) -> (usize, usize) {
        (
            self.items.swap(0, Ordering::SeqCst),
            self.texts.swap(0, Ordering::SeqCst),
        )
    }
}

#[test]
fn one_new_line_redraws_one_row_not_the_screen() {
    let pane = pane("fifty");
    pane.show(&lines("row", 50));
    let mut app = start::<Fifty>(800.0, 1000.0, None);
    let changes = Changes::default();
    changes.watch(&mut app);
    app.wait_for("text:row 49").unwrap();
    let (_, first_texts) = changes.take();
    assert!(
        first_texts >= 50,
        "every row was drawn once ({first_texts})"
    );

    let mut one = lines("row", 50);
    one[20] = "row 20 changed".into();
    pane.show(&one);
    app.wait_for("text:row 20 changed").unwrap();
    let (one_items, one_texts) = changes.take();

    pane.show(&lines("fresh", 50));
    app.wait_for("text:fresh 49").unwrap();
    let (all_items, all_texts) = changes.take();

    assert_eq!(one_texts, 1, "only the changed row's text was rewritten");
    assert!(
        all_texts >= 50,
        "a screen of new rows rewrites them all ({all_texts})"
    );
    assert!(
        one_items * 5 <= all_items,
        "one changed row cost {one_items} mount items, a whole new screen {all_items}"
    );
}

#[test]
fn scrolled_away_new_lines_show_a_pill_that_jumps_to_the_end() {
    let pane = pane("scrolled");
    pane.show(&lines("row", 40));
    let mut app = start::<Scrolled>(400.0, 300.0, None);
    app.wait_for("text:row 39").unwrap();
    assert!(!app.shows("new lines"), "following the end needs no pill");

    app.scroll(&format!("label:{LABEL}"), px(-200.0)).unwrap();
    app.wait_for("text:following false").unwrap();
    let mut more = lines("row", 40);
    more.extend(lines("late", 3));
    pane.show(&more);
    app.wait_for("text:/3 new lines/").unwrap();

    app.press("label:3 new lines").unwrap();
    app.wait_for("text:following true").unwrap();
    // 43 rows of 14 pt: the end is at least 602 - 300 down, past where the 40-row end was.
    let jumped = app
        .screen()
        .commands()
        .iter()
        .rev()
        .find_map(|(_, c)| match c {
            Command::ScrollTo { y, .. } => Some(y.0),
            _ => None,
        });
    assert!(
        jumped.is_some_and(|y| y >= 302.0),
        "pressing the pill scrolls to the new end, got {jumped:?}"
    );
    app.wait_for_gone("text:/new lines/", Duration::from_secs(2))
        .unwrap();
}

#[test]
fn a_pane_whose_rows_arrive_after_the_view_opens_at_its_end() {
    // A pane tab is built before its first read answers: the view starts empty and a screen taller than it arrives.
    let pane = pane("late");
    let mut app = start::<Late>(400.0, 300.0, None);
    pane.show(&lines("row", 60));
    app.wait_for("text:row 59").unwrap();
    assert!(!app.shows("new lines"), "opening at the end needs no pill");
}

#[test]
fn a_blocked_agent_takes_the_pill_when_you_are_scrolled_away() {
    let pane = pane("blocked");
    pane.show(&lines("row", 40));
    let mut app = start::<Blocked>(400.0, 300.0, None);
    app.wait_for("text:row 39").unwrap();
    app.scroll(&format!("label:{LABEL}"), px(-200.0)).unwrap();
    pane.set_attention(Some("Run rm -rf build?"));
    app.wait_for("text:/Needs you/").unwrap();
    assert!(
        app.screen().matches("label:Needs you").unwrap(),
        "the pill is a named button"
    );
}

#[test]
fn a_pane_that_stops_updating_says_so_and_a_closed_one_says_it_is_gone() {
    let pane = pane("notices");
    pane.show(&lines("row", 5));
    let mut app = start::<Notices>(400.0, 300.0, None);
    app.wait_for("text:row 4").unwrap();
    assert!(!app.shows("Not live") && !app.shows("This pane is gone"));

    pane.set_state(FeedState::Stale);
    app.wait_for("text:Not live").unwrap();
    assert!(
        app.shows("row 4"),
        "the last text stays, dimmed, under the notice"
    );

    pane.set_state(FeedState::Live);
    app.wait_for_gone("text:Not live", Duration::from_secs(2))
        .unwrap();

    pane.set_state(FeedState::Gone);
    app.wait_for("text:This pane is gone").unwrap();
}

#[test]
fn a_pane_with_no_machine_is_shown_as_gone_not_as_empty() {
    let mut app = start::<Missing>(400.0, 300.0, None);
    app.wait_for("text:This pane is gone").unwrap();
}

#[test]
fn the_agent_needing_you_is_announced_once_per_question() {
    let pane = pane("questions");
    pane.show(&lines("row", 5));
    let mut app = start::<Questions>(400.0, 300.0, None);
    app.wait_for("text:row 4").unwrap();
    let said = |app: &Headless, words: &str| {
        app.screen()
            .commands()
            .iter()
            .filter(|(_, c)| matches!(c, Command::Announce(m) if m == words))
            .count()
    };
    let words = format!("{LABEL} needs you: Run rm -rf build?");
    assert_eq!(said(&app, &words), 0);

    pane.set_attention(Some("Run rm -rf build?"));
    app.wait_until("the announcement", Duration::from_secs(5), |s| {
        s.commands()
            .iter()
            .any(|(_, c)| matches!(c, Command::Announce(m) if *m == words))
    })
    .unwrap();

    // Unrelated reads while it waits do not repeat it.
    pane.show(&lines("row", 6));
    app.wait_for("text:row 5").unwrap();
    assert_eq!(said(&app, &words), 1);

    pane.set_attention(Some("Push to origin?"));
    let next = format!("{LABEL} needs you: Push to origin?");
    app.wait_until("the next question", Duration::from_secs(5), |s| {
        s.commands()
            .iter()
            .any(|(_, c)| matches!(c, Command::Announce(m) if *m == next))
    })
    .unwrap();
}

#[test]
fn new_output_is_read_aloud_at_most_once_per_window_when_asked() {
    let pane = pane("spoken");
    pane.show(&lines("row", 3));
    let clock = nsh_core::time::Clock::manual(SystemTime::UNIX_EPOCH);
    let mut app = start::<Spoken>(400.0, 300.0, Some(clock));
    app.wait_for("text:row 2").unwrap();
    let announcements = |app: &Headless| -> Vec<String> {
        app.screen()
            .commands()
            .iter()
            .filter_map(|(_, c)| match c {
                Command::Announce(m) => Some(m.clone()),
                _ => None,
            })
            .collect()
    };
    assert!(
        announcements(&app).is_empty(),
        "what was already there is not news"
    );

    let mut rows = lines("row", 3);
    rows.push("alpha".into());
    pane.show(&rows);
    app.wait_for("text:alpha").unwrap();
    assert_eq!(
        announcements(&app),
        ["alpha"],
        "the first output goes out at once"
    );

    rows.push("beta".into());
    pane.show(&rows);
    app.wait_for("text:beta").unwrap();
    rows.push("gamma".into());
    pane.show(&rows);
    app.wait_for("text:gamma").unwrap();
    assert_eq!(announcements(&app), ["alpha"], "the window is still open");

    app.fast_forward(Duration::from_secs(2)).unwrap();
    assert_eq!(
        announcements(&app),
        ["alpha", "beta gamma"],
        "what waited goes out together"
    );
}

#[test]
fn output_is_not_read_aloud_unless_asked() {
    let pane = pane("silent");
    pane.show(&lines("row", 3));
    let mut app = start::<Silent>(400.0, 300.0, None);
    app.wait_for("text:row 2").unwrap();
    pane.show(&lines("row", 4));
    app.wait_for("text:row 3").unwrap();
    assert!(
        !app.screen()
            .commands()
            .iter()
            .any(|(_, c)| matches!(c, Command::Announce(_))),
        "nothing is announced"
    );
}

#[test]
fn pressing_a_link_reports_what_it_opens() {
    let pane = pane("linked");
    pane.show_ansi("see src/main.rs:42:7 for the bug\r\nand https://example.dev/docs too");
    let mut app = start::<Linked>(600.0, 300.0, None);
    app.wait_for("text:/for the bug/").unwrap();
    let docs = format!("label:{LABEL} >> text:https://example.dev/docs");
    app.press(&format!("label:{LABEL} >> text:src/main.rs:42:7"))
        .unwrap();
    app.wait_for("text:opened Path src/main.rs Some(42) Some(7)")
        .unwrap();
    app.press(&docs).unwrap();
    app.wait_for("text:opened Url https://example.dev/docs None None")
        .unwrap();
    let underlined = app.screen().span_style(&docs).unwrap();
    assert!(underlined.decoration.underline, "a link is underlined");
}

#[test]
fn styles_arrive_as_bold_italic_underline_and_corrected_colour() {
    let pane = pane("painted");
    pane.show_ansi(
        "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[9mgone\x1b[0m \x1b[93myellow\x1b[0m",
    );
    let mut app = start::<Painted>(600.0, 200.0, None);
    app.wait_for("text:/yellow/").unwrap();
    let style = |t: &str| app.screen().span_style(&format!("text:{t}")).unwrap();
    assert_eq!(style("bold").font_weight, 700);
    assert!(style("italic").italic);
    assert!(style("under").decoration.underline);
    assert!(style("gone").decoration.line_through);
    // Yellow on the light page is unreadable as sent; it is lifted until it reads.
    let yellow = style("yellow").color;
    let (r, g, b, _) = yellow.to_f64();
    let drawn = Rgb::new(
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    );
    assert!(
        contrast_ratio(drawn, Rgb::new(255, 255, 255)) >= 4.5,
        "yellow was drawn as {drawn:?}"
    );
}

#[test]
fn width_fit_scales_the_font_to_the_view_and_reports_the_cells_that_fit() {
    CELLS.lock().clear();
    let pane = pane("fitted");
    // 100 columns.
    pane.show(&[format!("{:<100}", "a wide line"), "second".to_owned()]);
    let mut app = start::<Fitted>(550.0, 280.0, None);
    app.wait_for("text:a wide line").unwrap();
    // The approximate text engine of the headless runner makes a cell 0.55 em wide.
    let size = app
        .screen()
        .span_style("text:a wide line")
        .unwrap()
        .font_size;
    assert!(
        (size.0 - 10.0).abs() < 0.2,
        "100 columns in 550 pt need a 10 pt font, got {size:?}"
    );
    let last = *CELLS.lock().last().expect("onCells fired");
    assert_eq!(last.0, 100, "all the columns fit");
    assert!(last.1 >= 10, "rows that fit: {last:?}");
}
