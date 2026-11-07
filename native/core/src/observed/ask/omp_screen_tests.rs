//! What the reader makes of omp's ask dialog: port of `omp_ask_driver_test.dart`'s screen groups. The Dart
//! tests read screens captured from a real omp; these read the same dialogs, rebuilt from synthetic questions
//! on the fake (which was compared row for row with every capture) and, for the layout itself, goldens.

use super::omp_fixtures::{
    PLAN_HINT, approval_screen, captures, plan_review_screen, resume_picker_screen, with_ansi,
};
use super::omp_goldens as golden;
use super::*;

/// The pane screen at the end of the keys that led to the capture `name`.
fn screen(name: &str) -> String {
    let capture = captures()
        .into_iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no capture {name}"));
    capture.build().screen()
}

fn parse(name: &str) -> AskScreenState {
    parse_ask_screen(&screen(name))
}

fn labels(s: &AskScreenState) -> Vec<&str> {
    s.rows.iter().map(|r| r.label.as_str()).collect()
}

fn answers(s: &AskScreenState) -> Vec<&str> {
    s.review.iter().map(|l| l.answer.as_str()).collect()
}

#[test]
fn the_fake_draws_the_layout_of_the_real_dialogs() {
    for (name, want) in [
        ("ask-single", golden::SINGLE),
        ("ask-multi-two", golden::MULTI_TWO),
        ("ask-form-review", golden::FORM_REVIEW),
        ("ask-other-typed", golden::OTHER_TYPED),
        ("ask-long-scroll", golden::LONG_SCROLL),
    ] {
        let capture = captures().into_iter().find(|c| c.name == name).unwrap();
        let drawn: Vec<String> = capture
            .build()
            .dialog_lines()
            .iter()
            .map(|l| l.trim_end().to_owned())
            .collect();
        assert_eq!(drawn.join("\n"), want, "{name}");
    }
}

#[test]
fn a_single_choice_has_rows_a_cursor_descriptions_and_the_recommended_mark() {
    let s = parse("ask-single");
    assert_eq!(s.kind, AskScreenKind::Question);
    assert!(!s.has_tabs());
    assert_eq!(s.title, "Which database should the project use?");
    assert_eq!(
        labels(&s),
        [
            "SQLite (Recommended)",
            "Postgres",
            "DuckDB",
            "Other (type your own)"
        ]
    );
    assert_eq!(s.cursor_row(), Some(0));
    assert!(s.rows.iter().all(|r| !r.checked && !r.multi));
    assert_eq!(
        s.rows[1].description,
        "Full server, best for concurrent writes and large data sets"
    );
    assert!(s.rows.last().unwrap().is_other());
    assert_eq!(parse("ask-single-down").cursor_row(), Some(1));
    assert_eq!(parse("ask-single-other").cursor_row(), Some(3));
}

#[test]
fn checkboxes_say_which_are_ticked() {
    let s = parse("ask-multi-two");
    assert!(s.has_tabs());
    assert_eq!(s.tabs, ["tools", "Submit"]);
    assert!(s.multi());
    assert_eq!(
        s.rows.iter().map(|r| r.checked).collect::<Vec<_>>(),
        [true, false, true, false, false]
    );
    assert_eq!(s.cursor_row(), Some(2));
    assert!(
        s.rows[2]
            .description
            .starts_with("Needs a database container")
    );
}

#[test]
fn the_review_tab_lists_each_answer() {
    let s = parse("ask-multi-review");
    assert_eq!(s.kind, AskScreenKind::Review);
    assert_eq!(
        s.review,
        [AskReviewLine {
            index: 0,
            answer: "Lint, Integration tests".to_owned()
        }]
    );
    assert_eq!(
        answers(&parse("ask-form-review")),
        ["DuckDB", "Docker image, Changelog", "“Hà Nội — dự án”"]
    );
    let u = parse("ask-long-review-unanswered");
    assert_eq!(u.unanswered, 2);
    assert_eq!(u.tabs, ["pick", "Release flags a…", "Submit"]);
    assert_eq!(answers(&u), ["unanswered", "unanswered"]);
}

#[test]
fn zero_options_leave_only_the_other_row_and_a_custom_answer_shows_under_it_ticked() {
    let plain = parse("ask-form-q3");
    assert_eq!(plain.rows.len(), 1);
    assert!(plain.rows[0].is_other());
    let set = parse("ask-form-q3-custom");
    assert!(set.rows[0].checked);
    assert_eq!(set.rows[0].description, "Hà Nội — dự án");
}

#[test]
fn the_editor_is_read_empty_typed_and_prefilled() {
    let empty = parse("ask-other-editor");
    assert_eq!(empty.kind, AskScreenKind::Editor);
    assert_eq!(empty.editor_text, "");
    assert_eq!(empty.title, "Which database should the project use?");
    assert_eq!(
        parse("ask-other-typed").editor_text,
        "Postgres, nhưng dùng PgBouncer"
    );
    assert_eq!(
        parse("ask-form-editor-prefilled").editor_text,
        "Hà Nội — dự án"
    );
}

#[test]
fn a_wrapped_label_is_one_row_the_scrollbar_is_not_text_and_a_cut_tab_label_keeps_its_mark() {
    let s = parse("ask-long-scroll");
    assert!(s.rows.iter().any(|r| {
        r.label
            .starts_with("Release 04 with a considerably longer label that wraps")
    }));
    assert!(
        s.rows
            .iter()
            .all(|r| !r.label.contains('█') && !r.label.contains('│'))
    );
    assert_eq!(
        s.rows[s.cursor_row().unwrap()].label,
        "Release 15 (Recommended)"
    );
    assert_eq!(s.tabs[1], "Release flags a…");
    let bottom = parse("ask-long-scroll-bottom");
    assert!(bottom.rows.last().unwrap().is_other());
    assert!(
        bottom
            .rows
            .iter()
            .any(|r| r.label.starts_with("Tiếng Việt"))
    );
}

#[test]
fn screens_that_are_not_an_ask_dialog_are_none() {
    for (name, shown) in [
        ("approval", approval_screen("bash", &["Command: ls"], 0)),
        (
            "plan review",
            plan_review_screen(0, "(~6.8k / 200k)", false, PLAN_HINT),
        ),
        ("resume picker", resume_picker_screen()),
        ("prompt", "just a prompt\n π > Haiku".to_owned()),
        ("empty", String::new()),
    ] {
        assert!(!looks_like_ask(&shown), "{name}");
    }
    for c in captures() {
        assert!(looks_like_ask(&c.build().screen()), "{}", c.name);
    }
}

#[test]
fn colours_and_carriage_returns_do_not_matter() {
    let plain = screen("ask-multi");
    let coloured = with_ansi(&plain);
    assert!(coloured.contains("\x1b["));
    let s = parse_ask_screen(&coloured);
    assert_eq!(s.rows.len(), 5);
    assert_eq!(s, parse_ask_screen(&plain));
}

#[test]
fn the_countdown_of_a_timed_question_is_read() {
    let timed = screen("ask-single").replacen("╭─ Ask ──", "╭─ Ask (12s) ──", 1);
    let s = parse_ask_screen(&timed);
    assert_eq!(s.kind, AskScreenKind::Question);
    assert_eq!(s.seconds_left, Some(12));
    assert_eq!(parse("ask-single").seconds_left, None);
}

#[test]
fn only_the_last_titled_box_is_the_dialog() {
    // A finished ask above a plain approval: the dialog on screen is the approval, so nothing to answer.
    let finished = screen("ask-single");
    let after = format!(
        "{finished}\n{}",
        approval_screen("bash", &["Command: ls"], 0)
    );
    assert!(!looks_like_ask(&after));
    // ... and the reverse: a finished approval above an ask.
    let before = format!(
        "{}\n{finished}",
        approval_screen("bash", &["Command: ls"], 0)
    );
    assert!(looks_like_ask(&before));
}

#[test]
fn a_dialog_cut_off_at_the_bottom_is_none() {
    let full = screen("ask-single");
    let cut: Vec<&str> = full.lines().filter(|l| !l.starts_with('╰')).collect();
    assert!(!looks_like_ask(&cut.join("\n")));
}
