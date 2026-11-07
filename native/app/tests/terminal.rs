//! The terminal session against real programs on a real pty: what the program is sent for a key, what the person sees of
//! what the program prints. Needs the `terminal` feature (libghostty-vt).
#![cfg(all(unix, feature = "terminal"))]

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use herdr_core::screen::{Color, Rgb};
use herdr_desktop_native::terminal::{
    frame::{Exit, Frame},
    keys,
    session::Session,
    types::{Button, Colors, Config, Input, Launch, MouseKind},
};

const COLORS: Colors = Colors {
    fg: Rgb::new(230, 230, 230),
    bg: Rgb::new(20, 20, 20),
    ansi: [
        Rgb::new(0, 0, 0),
        Rgb::new(200, 10, 10),
        Rgb::new(10, 200, 10),
        Rgb::new(200, 200, 10),
        Rgb::new(10, 10, 200),
        Rgb::new(200, 10, 200),
        Rgb::new(10, 200, 200),
        Rgb::new(200, 200, 200),
        Rgb::new(60, 60, 60),
        Rgb::new(255, 80, 80),
        Rgb::new(80, 255, 80),
        Rgb::new(255, 255, 80),
        Rgb::new(80, 80, 255),
        Rgb::new(255, 80, 255),
        Rgb::new(80, 255, 255),
        Rgb::new(255, 255, 255),
    ],
};

fn start(script: &str) -> Session {
    // SAFETY: set before any thread of this test reads it, to the same value every time.
    unsafe { std::env::set_var("HERDR_DESKTOP_TERMINAL", "1") };
    Session::start(Config {
        launch: Launch {
            argv: vec!["sh".into(), "-c".into(), script.into()],
            cwd: None,
            cols: 40,
            rows: 10,
            cell: (8, 16),
        },
        scrollback_bytes: 4_000_000,
        colors: COLORS,
    })
}

fn wait_for(session: &Session, what: &str, mut ok: impl FnMut(&Frame) -> bool) -> Arc<Frame> {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let frame = session.frame();
        if ok(&frame) {
            return frame;
        }
        assert!(
            Instant::now() < end,
            "never happened: {what}; the screen was:\n{}",
            frame.text()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn key(stroke: &str) -> Input {
    Input::Key(keys::parse(stroke, false).unwrap_or_else(|| panic!("{stroke}")))
}

/// What a program that echoes its input with control characters visible (`cat -v`) shows after `inputs`.
fn echo(setup: &str, inputs: Vec<Input>, expect: &str) {
    let session = start(&format!(
        "{setup}{}cat -v",
        if setup.is_empty() { "" } else { "; " }
    ));
    wait_for(&session, "the program is ready", |f| f.rev > 0);
    std::thread::sleep(Duration::from_millis(300));
    for input in inputs {
        session.send(input);
    }
    wait_for(&session, expect, |f| f.text().contains(expect));
}

#[test]
fn what_a_program_prints_is_on_the_screen_in_the_theme_colours() {
    let session =
        start("printf 'plain \\033[31mred\\033[0m \\033[1;38;2;1;2;3mtrue\\033[0m\\r\\n'; sleep 5");
    let frame = wait_for(&session, "the text", |f| {
        f.text().contains("plain red true")
    });
    let red = frame.rows[0]
        .runs
        .iter()
        .find(|r| r.text == "red")
        .expect("a red run");
    assert_eq!(
        red.style.fg,
        Some(Color::Rgb(200, 10, 10)),
        "palette red is the theme's red"
    );
    let bold = frame.rows[0]
        .runs
        .iter()
        .find(|r| r.text == "true")
        .expect("a run");
    assert!(bold.style.bold);
    assert_eq!(bold.style.fg, Some(Color::Rgb(1, 2, 3)));
}

#[test]
fn keys_reach_the_program_as_a_terminal_encodes_them() {
    echo(
        "",
        vec![
            key("ctrl+k"),
            key("escape"),
            key("alt+x"),
            key("up"),
            key("ctrl+left"),
            key("shift+tab"),
            key("f5"),
            key("ctrl+space"),
        ],
        "^K^[^[x^[[A^[[1;5D^[[Z^[[15~^@",
    );
}

#[test]
fn typed_text_goes_through_as_utf8() {
    echo("", vec![Input::Text("héllo ✓".into())], "héllo ✓");
}

#[test]
fn application_cursor_keys_change_what_up_sends() {
    echo(
        "printf '\\033[?1h'",
        vec![key("up"), key("home")],
        "^[OA^[OH",
    );
}

#[test]
fn the_kitty_keyboard_protocol_is_honoured_when_a_program_turns_it_on() {
    // Disambiguate: Escape and Ctrl+letter become CSI u.
    echo(
        "printf '\\033[>1u'",
        vec![key("escape"), key("ctrl+k")],
        "^[[27u^[[107;5u",
    );
}

#[test]
fn modify_other_keys_is_honoured_when_a_program_turns_it_on() {
    // libghostty keeps Ctrl+letter as its control byte (^K) in this mode; the chords that have none are reported in full.
    echo(
        "printf '\\033[>4;2m'",
        vec![key("ctrl+k"), key("alt+x"), key("ctrl+enter")],
        "^K^[[27;3;120~^[[27;5;13~",
    );
}

#[test]
fn paste_is_bracketed_only_when_the_program_asked_for_it() {
    echo(
        "printf '\\033[?2004h'",
        vec![Input::Paste("one".into())],
        "^[[200~one^[[201~",
    );
    echo("", vec![Input::Paste("two".into())], "two");
}

#[test]
fn focus_events_are_sent_only_when_asked_for() {
    echo(
        "printf '\\033[?1004h'",
        vec![Input::Focus(true), Input::Focus(false)],
        "^[[I^[[O",
    );
}

#[test]
fn the_mouse_is_reported_when_the_program_tracks_it_and_selects_when_not() {
    // SGR encoding: button 0 at column 5, row 3 (1-based) is `CSI < 0 ; 5 ; 3 M`.
    echo(
        "printf '\\033[?1000h\\033[?1006h'",
        vec![Input::Mouse {
            kind: MouseKind::Press(Button::Left),
            x: 4.0 * 8.0 + 1.0,
            y: 2.0 * 16.0 + 1.0,
            clicks: 1,
            shift: false,
            ctrl: false,
            alt: false,
        }],
        "^[[<0;5;3M",
    );
    // The wheel is button 4 (up).
    echo(
        "printf '\\033[?1000h\\033[?1006h'",
        vec![Input::Wheel {
            ticks: 1,
            x: 1.0,
            y: 1.0,
            shift: false,
        }],
        "^[[<64;1;1M",
    );
}

#[test]
fn a_drag_selects_text_and_copy_answers_with_it() {
    let session = start("printf 'hello world\\r\\n'; sleep 5");
    wait_for(&session, "the text", |f| f.text().contains("hello world"));
    let at = |col: f32| (col * 8.0 + 1.0, 1.0);
    let (x, y) = at(0.0);
    session.send(Input::Mouse {
        kind: MouseKind::Press(Button::Left),
        x,
        y,
        clicks: 1,
        shift: false,
        ctrl: false,
        alt: false,
    });
    let (x, y) = at(4.0);
    session.send(Input::Mouse {
        kind: MouseKind::Motion(Some(Button::Left)),
        x,
        y,
        clicks: 1,
        shift: false,
        ctrl: false,
        alt: false,
    });
    session.send(Input::Mouse {
        kind: MouseKind::Release(Button::Left),
        x,
        y,
        clicks: 1,
        shift: false,
        ctrl: false,
        alt: false,
    });
    let frame = wait_for(&session, "a selection", |f| f.selection);
    assert!(
        frame.rows[0]
            .runs
            .iter()
            .any(|r| r.style.inverse && r.text == "hello"),
        "{:?}",
        frame.rows[0].runs
    );
    assert_eq!(session.selection().as_deref(), Some("hello"));

    // A double click selects the word.
    let (x, y) = at(7.0);
    session.send(Input::Mouse {
        kind: MouseKind::Press(Button::Left),
        x,
        y,
        clicks: 2,
        shift: false,
        ctrl: false,
        alt: false,
    });
    assert_eq!(session.selection().as_deref(), Some("world"));
}

#[test]
fn the_scrollback_is_scrolled_with_the_wheel_and_to_an_absolute_row() {
    let session = start("i=0; while [ $i -lt 100 ]; do echo line $i; i=$((i+1)); done; sleep 5");
    let frame = wait_for(&session, "the end", |f| f.text().contains("line 99"));
    assert!(
        frame.scroll.total >= 100 && frame.scroll.at_end(),
        "{:?}",
        frame.scroll
    );
    session.send(Input::Wheel {
        ticks: 5,
        x: 1.0,
        y: 1.0,
        shift: false,
    });
    let up = wait_for(&session, "scrolled up", |f| !f.scroll.at_end());
    assert_eq!(up.scroll.offset, frame.scroll.offset - 15);
    session.send(Input::ScrollTo(0));
    wait_for(&session, "the top", |f| f.text().starts_with("line 0"));
    session.send(Input::ScrollEnd);
    wait_for(&session, "the end again", |f| f.scroll.at_end());
}

#[test]
fn a_resize_reaches_the_program_and_reflows_the_screen() {
    let session = start("trap 'stty size' WINCH; stty size; while :; do sleep 0.05; done");
    wait_for(&session, "the first size", |f| f.text().contains("10 40"));
    session.send(Input::Resize {
        cols: 60,
        rows: 12,
        cell: (8, 16),
    });
    let frame = wait_for(&session, "the new size", |f| f.text().contains("12 60"));
    assert_eq!(frame.cols, 60);
    assert_eq!(frame.rows.len(), 12);
}

#[test]
fn title_bell_and_hyperlinks_are_reported() {
    let session = start(
        "printf '\\033]0;my title\\007\\a\\033]8;;https://example.com/x\\033\\\\a link\\033]8;;\\033\\\\ after\\r\\n'; sleep 5",
    );
    let frame = wait_for(&session, "the link", |f| !f.links.is_empty());
    assert_eq!(&*frame.title, "my title");
    assert!(frame.bells >= 1);
    let link = &frame.links[0].link;
    assert_eq!(
        (link.target.as_str(), link.start_col, link.end_col),
        ("https://example.com/x", 0, 6)
    );
    assert_eq!(frame.rows[0].text().trim_end(), "a link after");
}

#[test]
fn wide_characters_emoji_and_combining_marks_keep_their_cells() {
    let session = start("printf '日本 😀 e\\314\\201x\\r\\n'; sleep 5");
    let frame = wait_for(&session, "the text", |f| f.text().contains('x'));
    assert_eq!(frame.rows[0].text().trim_end(), "日本 😀 e\u{301}x");
    assert_eq!(
        frame.rows[0].columns(),
        "日本 😀 éx"
            .chars()
            .map(|c| if c as u32 > 0x2e80 || c == '😀' {
                2
            } else {
                1
            })
            .sum::<usize>()
    );
}

#[test]
fn the_cursor_and_its_shape_follow_the_program() {
    let session = start("printf 'ab\\033[6 q'; sleep 5");
    let frame = wait_for(&session, "a bar cursor", |f| {
        f.cursor
            .is_some_and(|c| c.shape == herdr_desktop_native::terminal::frame::CursorShape::Bar)
    });
    assert_eq!(
        (frame.cursor.unwrap().col, frame.cursor.unwrap().row),
        (2, 0)
    );
}

#[test]
fn the_end_of_the_program_is_reported_and_restart_runs_it_again() {
    let session = start("echo once; exit 3");
    let frame = wait_for(&session, "the exit", |f| f.exit.is_some());
    assert_eq!(frame.exit, Some(Exit::Code(3)));
    assert!(frame.text().contains("once"));
    session.send(Input::Restart);
    let again = wait_for(&session, "a second run", |f| {
        f.exit.is_some() && f.rev > frame.rev && f.text().contains("once")
    });
    assert_eq!(again.exit, Some(Exit::Code(3)));
}

#[test]
fn a_program_that_cannot_start_says_so_in_the_terminal() {
    unsafe { std::env::set_var("HERDR_DESKTOP_TERMINAL", "1") };
    let session = Session::start(Config {
        launch: Launch {
            argv: vec!["/no/such/program".into()],
            cwd: None,
            cols: 40,
            rows: 5,
            cell: (8, 16),
        },
        scrollback_bytes: 1_000_000,
        colors: COLORS,
    });
    let frame = wait_for(&session, "the exit", |f| f.exit.is_some());
    assert_eq!(frame.exit, Some(Exit::Code(127)));
    assert!(frame.text().contains("Could not start the program"));
}

#[test]
fn an_idle_terminal_publishes_nothing() {
    let session = start("echo up; sleep 5");
    let frame = wait_for(&session, "the text", |f| f.text().contains("up"));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        session.frame().rev,
        frame.rev,
        "no frame while nothing changes"
    );
}

#[test]
fn the_child_has_its_own_terminal_variables_and_none_of_herdrs() {
    // SAFETY: the test sets a variable for the child to be told it is not inherited.
    unsafe { std::env::set_var("HERDR_PANE_ID", "w1:p1") };
    let session = start("echo $TERM $COLORTERM ${HERDR_PANE_ID:-none}; sleep 5");
    let frame = wait_for(&session, "the text", |f| {
        f.text().contains("none") || f.text().contains("w1:p1")
    });
    assert_eq!(
        frame.rows[0].text().trim_end(),
        "xterm-256color truecolor none"
    );
}

/// 20 MB through the terminal: the program stays in step with the pty, the view sees few frames.
#[test]
fn a_20_mb_stream_is_parsed_and_costs_few_frames() {
    let session =
        start("head -c 20000000 /dev/zero | tr '\\0' 'y' | fold -w 100; echo DONE-STREAM");
    let started = Instant::now();
    let first = session.frame().rev;
    let frame = wait_for(&session, "the end of the stream", |f| {
        f.text().contains("DONE-STREAM")
    });
    let secs = started.elapsed().as_secs_f64();
    let frames = frame.rev - first;
    println!(
        "20 MB through the session in {secs:.2} s ({:.0} MB/s), {frames} frames published",
        20.0 / secs
    );
    assert!(
        frames < (secs * 130.0) as u64 + 5,
        "{frames} frames in {secs:.2} s: more than one per 8 ms"
    );
}

#[test]
#[ignore = "exploration: prints what modifyOtherKeys 2 does to a few keys"]
fn probe_modify_other_keys() {
    for stroke in [
        "ctrl+k",
        "alt+x",
        "ctrl+enter",
        "ctrl+[",
        "ctrl+/",
        "ctrl+space",
        "alt+enter",
        "ctrl+alt+a",
        "shift+enter",
        "ctrl+up",
        "ctrl+1",
    ] {
        let session = start("printf '\\033[>4;2m'; cat -v");
        wait_for(&session, "ready", |f| f.rev > 0);
        std::thread::sleep(Duration::from_millis(200));
        session.send(Input::Key(keys::parse(stroke, false).unwrap()));
        std::thread::sleep(Duration::from_millis(300));
        println!(
            "mok2 {stroke:>12} -> {:?}",
            session.frame().text().lines().next().unwrap_or("")
        );
    }
}
