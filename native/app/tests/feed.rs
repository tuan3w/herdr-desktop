//! Watched panes and ticks: what a view of a pane sees, when a pane is read, what the UI is told.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use common::{pane_updated, start, wait_for};
use herdr_core::screen::Color;
use herdr_desktop_native::feed::{self, FeedState, PaneFeed, PaneSource};
use serde_json::{Value, json};

fn pane_object(rig: &common::Rig, pane: &str) -> Value {
    rig.fixture().snapshot()["panes"]
        .as_array()
        .and_then(|panes| panes.iter().find(|p| p["pane_id"] == pane))
        .cloned()
        .expect("the pane is in the fixture")
}

/// How many times the scripted herdr was asked for `pane`'s coloured screen.
fn screen_reads(rig: &common::Rig, pane: &str) -> usize {
    rig.sent("pane.read")
        .iter()
        .filter(|p| p["pane_id"] == pane && p["format"] == "ansi")
        .count()
}

/// Replaces one pane object of the scripted herdr's snapshot (what the next snapshot read shows).
fn set_pane(rig: &common::Rig, id: &str, pane: Value) {
    let mut snapshot = rig.fixture().snapshot();
    if let Some(list) = snapshot["panes"].as_array_mut() {
        for p in list.iter_mut().filter(|p| p["pane_id"] == id) {
            *p = pane.clone();
        }
    }
    rig.fixture().set_snapshot(snapshot);
}

fn texts(feed: &impl PaneFeed) -> Vec<String> {
    feed.screen().text_rows()
}

#[test]
fn a_watched_pane_shows_its_screen_with_colour() {
    let rig = start("mixed");
    let feed = rig
        .engine
        .watch("local", "w1:p4", PaneSource::Visible)
        .expect("a known machine");
    wait_for("the first read", || !feed.screen().rows.is_empty());
    assert_eq!(feed.state(), FeedState::Live);
    let rows = texts(&feed);
    assert_eq!(rows[1], "  Splitting the posting rules into a module");
    let styled = feed.screen().rows[2]
        .runs
        .iter()
        .any(|run| run.style.fg == Some(Color::Rgb(215, 119, 87)));
    assert!(styled, "the spinner keeps its 24-bit colour");
}

#[test]
fn a_changed_row_is_new_and_the_others_are_the_same_rows() {
    let rig = start("mixed");
    let feed = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    wait_for("the first read", || !feed.screen().rows.is_empty());
    let rows = |last: &str| {
        vec![
            "  Updating lockfile".to_owned(),
            "  Resolving".to_owned(),
            last.to_owned(),
        ]
    };
    let moved = |expect: &str| {
        let pane = pane_object(&rig, "w1:p5");
        rig.fixture().push_event(pane_updated(pane, 100));
        wait_for("the new screen", || {
            feed.screen()
                .text_rows()
                .last()
                .is_some_and(|r| r == expect)
        });
    };
    rig.fixture().set_screen("w1:p5", rows("  ⠙ Working (41s)"));
    moved("  ⠙ Working (41s)");
    let before = feed.screen();
    rig.fixture().set_screen("w1:p5", rows("  ⠹ Working (42s)"));
    moved("  ⠹ Working (42s)");
    let after = feed.screen();
    assert!(
        Arc::ptr_eq(&before.rows[0], &after.rows[0])
            && Arc::ptr_eq(&before.rows[1], &after.rows[1])
    );
    assert!(!Arc::ptr_eq(&before.rows[2], &after.rows[2]));
}

#[test]
fn a_screen_says_when_the_activity_that_caused_it_was_reported() {
    let rig = start("mixed");
    let feed = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    wait_for("the first read", || !feed.screen().rows.is_empty());
    // The first read was asked for by opening the view, not by anything the pane did.
    assert_eq!(feed.activity_at(), None);

    let reported = std::time::Instant::now();
    rig.fixture().set_screen(
        "w1:p5",
        vec![
            "  Updating lockfile".to_owned(),
            "  ⠙ Working (41s)".to_owned(),
        ],
    );
    rig.fixture()
        .push_event(pane_updated(pane_object(&rig, "w1:p5"), 100));
    wait_for("the new screen", || {
        feed.screen()
            .text_rows()
            .last()
            .is_some_and(|r| r == "  ⠙ Working (41s)")
    });
    let at = feed.activity_at().expect("the screen has a cause");
    assert!(
        at >= reported,
        "the clock starts when herdr reports, not before"
    );
    assert!(at.elapsed() < std::time::Duration::from_secs(10));

    // And the process-wide figures moved: a read was parsed.
    assert!(herdr_desktop_native::metrics::read().parse_us_per_row > 0.0);
}

#[test]
fn views_are_told_when_the_screen_changes() {
    let rig = start("mixed");
    let feed = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    let changed = feed.changed();
    wait_for("the first read", || !feed.screen().rows.is_empty());
    while changed.try_recv().is_ok() {}
    rig.fixture().set_screen("w1:p5", vec!["  Done".to_owned()]);
    rig.fixture()
        .push_event(pane_updated(pane_object(&rig, "w1:p5"), 200));
    wait_for("the notice", || changed.try_recv().is_ok());
    assert_eq!(texts(&feed), ["  Done"]);
}

#[test]
fn every_view_of_a_pane_is_told_not_just_one() {
    let rig = start("mixed");
    let a = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    let b = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    let (told_a, told_b) = (a.changed(), b.changed());
    wait_for("the first read", || !a.screen().rows.is_empty());
    while told_a.try_recv().is_ok() || told_b.try_recv().is_ok() {}
    rig.fixture()
        .set_screen("w1:p5", vec!["  both see this".to_owned()]);
    rig.fixture()
        .push_event(pane_updated(pane_object(&rig, "w1:p5"), 300));
    wait_for("both notices", || {
        told_a.try_recv().is_ok() && told_b.try_recv().is_ok()
    });
    drop(a);
    assert_eq!(
        rig.engine.watching(),
        1,
        "one view is still there, so the pane is still read"
    );
    assert_eq!(texts(&b), ["  both see this"]);
}

#[test]
fn only_watched_panes_are_read_and_a_burst_is_one_read() {
    let rig = start("mixed");
    let watched = rig
        .engine
        .watch("local", "w1:p5", PaneSource::Visible)
        .expect("a known machine");
    wait_for("the first read", || !watched.screen().rows.is_empty());
    rig.fixture()
        .set_screen("w1:p5", vec!["  burst over".to_owned()]);
    let p4 = pane_object(&rig, "w1:p4");
    let p5 = pane_object(&rig, "w1:p5");
    for n in 0..40 {
        rig.fixture().push_event(pane_updated(p4.clone(), 100 + n));
        rig.fixture().push_event(pane_updated(p5.clone(), 100 + n));
    }
    wait_for("the burst to settle", || {
        texts(&watched) == ["  burst over"]
    });
    assert_eq!(screen_reads(&rig, "w1:p4"), 0, "nobody watches it");
    assert!(
        screen_reads(&rig, "w1:p5") < 40,
        "80 events did not cost 40 reads"
    );

    assert_eq!(rig.engine.watching(), 1);
    drop(watched);
    assert_eq!(
        rig.engine.watching(),
        0,
        "the last view going stops the reads"
    );
}

#[test]
fn a_pane_that_is_closed_is_gone_and_a_provider_opens_feeds_for_the_screen_widget() {
    let rig = start("mixed");
    feed::set_provider(rig.engine.feed_provider());
    assert!(
        feed::open("nowhere", "w1:p4", PaneSource::Visible).is_none(),
        "an unknown machine has no feed"
    );
    let handle = feed::open("local", "w1:p4", PaneSource::Visible).expect("a feed");
    wait_for("the first read", || !handle.screen().rows.is_empty());

    let mut snapshot = rig.fixture().snapshot();
    snapshot["panes"]
        .as_array_mut()
        .expect("panes")
        .retain(|p| p["pane_id"] != "w1:p4");
    snapshot["agents"]
        .as_array_mut()
        .expect("agents")
        .retain(|p| p["pane_id"] != "w1:p4");
    rig.fixture().set_snapshot(snapshot);
    rig.fixture()
        .push_event(json!({"event": "pane_closed", "data": {"pane_id": "w1:p4"}}));
    wait_for("the pane to be gone", || handle.state() == FeedState::Gone);
    assert!(
        !handle.screen().rows.is_empty(),
        "its last text stays for the notice to sit over"
    );
}

#[test]
fn a_blocked_pane_tells_the_mirror_what_it_asks() {
    let rig = start("mixed");
    let feed = rig
        .engine
        .watch("local", "w1:p1", PaneSource::Visible)
        .expect("a known machine");
    assert_eq!(
        feed.attention().as_deref(),
        Some("Waiting for an answer"),
        "the question is not read yet"
    );
    rig.engine.board(); // starts the read of its question
    wait_for("the question", || {
        feed.attention().as_deref() == Some("Do you want to proceed?")
    });
    let working = rig
        .engine
        .watch("local", "w1:p4", PaneSource::Visible)
        .expect("a known machine");
    assert_eq!(working.attention(), None);
}

#[test]
fn a_burst_of_events_is_a_few_ticks_not_one_each() {
    let rig = start("mixed");
    let revision = rig.engine.revision();
    let before = rig.ticks.load(Ordering::Relaxed);
    let pane = pane_object(&rig, "w1:p4");
    for n in 0..200 {
        let mut p = pane.clone();
        p["terminal_title"] = json!(format!("Refactor ledger {n}"));
        p["terminal_title_stripped"] = json!(format!("Refactor ledger {n}"));
        rig.fixture().push_event(pane_updated(p, 100 + n));
    }
    wait_for("a tick", || rig.ticks.load(Ordering::Relaxed) > before);
    wait_for("the last title", || {
        rig.engine
            .pane_summary("local", "w1:p4")
            .is_some_and(|m| m.name == "Refactor ledger 199")
    });
    let ticks = rig.ticks.load(Ordering::Relaxed) - before;
    assert!(ticks < 100, "200 events made {ticks} ticks");
    assert!(rig.engine.revision() > revision, "the counter moved");
}

#[test]
fn a_pane_herdr_could_not_restore_is_not_read_and_says_why_until_it_runs() {
    let rig = start("mixed");
    let mut pane = pane_object(&rig, "w1:p4");
    pane["restore_error"] = json!("could not start the program:\n\u{202e}no such file");
    let feed = rig
        .engine
        .watch("local", "w1:p4", PaneSource::Visible)
        .expect("a known machine");
    wait_for("the first read", || !feed.screen().rows.is_empty());
    assert_eq!(feed.state(), FeedState::Live);

    let reads = screen_reads(&rig, "w1:p4");
    let mut broken = pane.clone();
    broken["revision"] = json!(50);
    set_pane(&rig, "w1:p4", broken.clone());
    rig.fixture().push_event(pane_updated(broken, 51));
    wait_for("the state to follow", || {
        feed.state() == FeedState::Unrestored
    });
    let meta = rig.engine.pane_summary("local", "w1:p4").expect("listed");
    assert_eq!(
        meta.restore_error.as_deref(),
        Some("could not start the program: no such file"),
        "one safe line: no newline, no direction override"
    );
    // More activity does not read it: herdr would only answer pane_not_found.
    let mut moved = pane.clone();
    moved["restore_error"] = json!("could not start the program");
    rig.fixture().push_event(pane_updated(moved, 52));
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert_eq!(
        screen_reads(&rig, "w1:p4"),
        reads,
        "nothing is read while it is not running"
    );

    // herdr runs it again: reads and the live state come back.
    let mut running = pane;
    running
        .as_object_mut()
        .expect("a pane")
        .remove("restore_error");
    set_pane(&rig, "w1:p4", running.clone());
    rig.fixture().push_event(pane_updated(running, 60));
    wait_for("it to be live again", || feed.state() == FeedState::Live);
    assert_eq!(
        rig.engine
            .pane_summary("local", "w1:p4")
            .expect("listed")
            .restore_error,
        None
    );
}
