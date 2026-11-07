//! Claude Code's question dialog: port of `claude_ask_driver_test.dart`. The Dart tests read screens captured
//! from a real Claude Code (2.1.293 / 2.1.295); these read the same dialogs as small synthetic screens in
//! the captured layout (`claude_goldens`) and as the fake draws them, which was compared with every
//! captured screen. The tool results the Dart tests took from log fixtures through the Claude mapper are
//! written out here as the text the log holds.

use super::claude_goldens as golden;
use super::fake_claude::FakeClaudeAsk;
use super::*;
use crate::observed::model::{AskAnswer, AskDriver, AskOption, AskQuestion, AskStep, PendingAsk};

fn q(id: &str, question: &str, multi: bool, options: &[(&str, &str)]) -> AskQuestion {
    AskQuestion {
        id: id.to_owned(),
        question: question.to_owned(),
        options: options
            .iter()
            .map(|(label, description)| AskOption {
                label: (*label).to_owned(),
                description: (*description).to_owned(),
            })
            .collect(),
        multi,
        recommended: None,
    }
}

fn color() -> AskQuestion {
    q(
        "Color",
        "Which color do you prefer?",
        false,
        &[("Red", "Red"), ("Green", "Green"), ("Blue", "Blue")],
    )
}

fn fruits() -> AskQuestion {
    q(
        "Fruits",
        "Which fruits do I like?",
        true,
        &[
            ("Apple", "Apple"),
            ("Banana", "Banana"),
            ("Cherry", "Cherry"),
            ("Date", "Date"),
        ],
    )
}

fn form() -> Vec<AskQuestion> {
    vec![
        q(
            "Lang",
            "Which language do I prefer?",
            false,
            &[
                ("Python", "Python as your preferred language"),
                ("Go", "Go as your preferred language"),
                ("Rust", "Rust as your preferred language"),
            ],
        ),
        q(
            "Extras",
            "Which extras do I want?",
            true,
            &[
                ("Tests", "Include a test suite"),
                ("Docs", "Include documentation"),
                ("CI", "Include continuous integration setup"),
                ("Lint", "Include linting configuration"),
            ],
        ),
    ]
}

const DEPLOY_QUESTION: &str = "Which of the following deployment strategies would you prefer to use for the next production release of the mobile backend service?";
const DEPLOY_FIRST: &str =
    "Blue-green deployment with automated smoke tests and an instant rollback path if errors rise";

fn deploy() -> AskQuestion {
    q(
        "Deploy",
        DEPLOY_QUESTION,
        false,
        &[(DEPLOY_FIRST, ""), ("Canary", ""), ("Rolling", "")],
    )
}

fn ask(qs: &[AskQuestion]) -> PendingAsk {
    PendingAsk {
        tool_call_id: "t".to_owned(),
        questions: qs.to_vec(),
    }
}

fn pick(selected: &[usize]) -> AskAnswer {
    AskAnswer {
        selected: selected.to_vec(),
        custom: None,
    }
}

fn own(text: &str) -> AskAnswer {
    AskAnswer {
        selected: Vec::new(),
        custom: Some(text.to_owned()),
    }
}

/// Drives `fake` with `answers` the way the session does: read, step, send (text first, then keys), until
/// the driver says it is done. Returns the steps that sent something.
fn drive(fake: &mut FakeClaudeAsk, answers: &[AskAnswer]) -> Vec<AskStep> {
    let mut driver = ClaudeAskDriver::new(ask(&fake.questions), answers.to_vec());
    let mut sent = Vec::new();
    for _ in 0..60 {
        match driver.next(&fake.screen()) {
            AskStep::Done => return sent,
            AskStep::Mismatch(why) => {
                panic!(
                    "mismatch after {} steps: {why}\n{}",
                    sent.len(),
                    fake.screen()
                )
            }
            step => {
                if let AskStep::Send { keys, text, .. } = &step {
                    if let Some(t) = text {
                        fake.paste(t);
                    }
                    for k in keys {
                        fake.press(k);
                    }
                }
                sent.push(step);
            }
        }
    }
    panic!("the driver never finished: {sent:?}");
}

fn keys_of(step: &AskStep) -> Vec<&str> {
    match step {
        AskStep::Send { keys, .. } => keys.iter().map(String::as_str).collect(),
        other => panic!("not a send: {other:?}"),
    }
}

fn submits(step: &AskStep) -> bool {
    matches!(step, AskStep::Send { submits: true, .. })
}

/// What a reader makes of a screen, for comparing two screens.
fn shape(s: &ClaudeAskScreen) -> String {
    format!(
        "{:?}\n{:?}\n{}\n{:?}\n{:?} {}\n{:?}",
        s.kind,
        s.tabs
            .iter()
            .map(|t| (&t.label, t.answered))
            .collect::<Vec<_>>(),
        s.title,
        s.options
            .iter()
            .map(|o| (o.number, &o.label, o.cursor, o.checked, o.marked))
            .collect::<Vec<_>>(),
        s.cursor_number,
        s.cursor_on_submit,
        s.review
    )
}

// ------------------------------------------------------------------ the screens

#[test]
fn every_dialog_screen_is_read_and_nothing_else_is_a_dialog() {
    for (name, screen) in [
        ("single", golden::SINGLE),
        ("single typed", golden::SINGLE_OTHER),
        ("multi", golden::MULTI_SUBMIT_ROW),
        ("multi chat", golden::MULTI_CHAT),
        ("form", golden::FORM_Q1_ANSWERED),
        ("wrap", golden::WRAP),
        ("tall", golden::TALL),
        ("review", golden::REVIEW),
        ("review missing", golden::REVIEW_UNANSWERED),
    ] {
        assert_ne!(parse_claude_ask(screen).kind, ClaudeAskKind::None, "{name}");
        assert!(looks_like_claude_ask(screen), "{name}");
    }
    for (name, screen) in [
        ("bash approval", golden::APPROVAL_BASH),
        ("edit approval", golden::APPROVAL_EDIT),
        ("plan approval", golden::PLAN_APPROVAL),
        ("a picker with the footer but no chat row", golden::PICKER),
        ("empty", ""),
    ] {
        assert!(!looks_like_claude_ask(screen), "{name}");
    }
}

#[test]
fn a_single_choice_has_a_strip_a_title_rows_a_cursor_and_the_other_row() {
    let s = parse_claude_ask(golden::SINGLE);
    assert_eq!(s.kind, ClaudeAskKind::Question);
    assert_eq!(
        s.tabs,
        [ClaudeAskTab {
            label: "Color".to_owned(),
            answered: false
        }]
    );
    assert_eq!(s.title, "Which color do you prefer?");
    assert_eq!(
        s.options
            .iter()
            .map(|o| o.label.as_str())
            .collect::<Vec<_>>(),
        ["Red", "Green", "Blue", "Type something."]
    );
    assert_eq!(s.cursor_number, Some(1));
    assert!(s.options.iter().all(|o| !o.checked));
}

#[test]
fn a_multi_select_has_checkboxes_a_submit_row_and_a_cursor_that_counts_it() {
    let toggled = parse_claude_ask(golden::MULTI_TOGGLED);
    assert_eq!(
        toggled
            .options
            .iter()
            .map(|o| o.checked)
            .collect::<Vec<_>>(),
        [true, false, true, false, false]
    );
    assert_eq!(toggled.cursor_number, Some(3));
    assert!(toggled.tabs[0].answered, "☒");

    let submit = parse_claude_ask(golden::MULTI_SUBMIT_ROW);
    assert!(submit.cursor_on_submit);
    assert_eq!(
        submit.cursor_number,
        Some(6),
        "the arrows visit 4 options, Other, then Submit"
    );
    assert_eq!(
        submit.options.last().unwrap().label,
        "Elderberry",
        "the text typed on the Other row"
    );
    assert!(submit.options.last().unwrap().checked);

    assert_eq!(
        parse_claude_ask(golden::MULTI_CHAT).cursor_number,
        Some(7),
        "Chat about this is the 7th row the arrows reach"
    );
}

#[test]
fn a_form_has_both_tabs_and_marks_the_option_answered_earlier() {
    let q1 = parse_claude_ask(golden::FORM_Q1);
    assert_eq!(
        q1.tabs
            .iter()
            .map(|t| (t.label.as_str(), t.answered))
            .collect::<Vec<_>>(),
        [("Lang", false), ("Extras", false)]
    );
    assert_eq!(q1.title, "Which language do I prefer?");

    let back = parse_claude_ask(golden::FORM_Q1_ANSWERED);
    assert_eq!(
        back.tabs.iter().map(|t| t.answered).collect::<Vec<_>>(),
        [true, true]
    );
    assert!(back.options[1].marked);
    assert_eq!(back.options[1].label, "Go");
    assert_eq!(
        back.cursor_number,
        Some(1),
        "the cursor returns to row 1, not to the answer"
    );
}

#[test]
fn a_question_that_wraps_under_bars_and_labels_and_descriptions_that_wrap() {
    let wrapped = parse_claude_ask(golden::WRAP);
    assert_eq!(wrapped.title, DEPLOY_QUESTION);
    assert_eq!(
        wrapped
            .options
            .iter()
            .take(3)
            .map(|o| o.label.as_str())
            .collect::<Vec<_>>(),
        [DEPLOY_FIRST, "Canary", "Rolling"]
    );
    let tall = parse_claude_ask(golden::TALL);
    assert_eq!(
        tall.options.len(),
        5,
        "4 options and Other: descriptions are not rows"
    );
}

#[test]
fn the_review_tab_lists_each_question_with_its_answer_and_what_is_missing() {
    let done = parse_claude_ask(golden::REVIEW);
    assert_eq!(done.kind, ClaudeAskKind::Review);
    assert_eq!(
        done.review,
        [
            ("Which language do I prefer?".to_owned(), "Go".to_owned()),
            ("Which extras do I want?".to_owned(), "Tests".to_owned())
        ]
    );
    assert_eq!(done.cursor_number, Some(1));

    let missing = parse_claude_ask(golden::REVIEW_UNANSWERED);
    assert_eq!(
        missing.review,
        [("Which extras do I want?".to_owned(), "Tests".to_owned())]
    );
    assert_eq!(
        missing.review_answer_of("Which language do I prefer?"),
        None
    );
    assert_eq!(
        missing.review_answer_of("Which  extras do I want?"),
        Some("Tests")
    );
}

#[test]
fn a_long_answer_that_wraps_on_the_review_is_one_answer() {
    let screen = golden::REVIEW.replace(
        "   → Go\n",
        "   → Go, the one that compiles to a single static\n     binary\n",
    );
    let s = parse_claude_ask(&screen);
    assert_eq!(
        s.review[0].1,
        "Go, the one that compiles to a single static binary"
    );
}

#[test]
fn only_the_dialog_at_the_bottom_counts() {
    let finished_above = format!(
        "{}\n\n⏺ User answered Claude's questions\n\n❯ \n",
        golden::SINGLE
    );
    assert!(!looks_like_claude_ask(&finished_above));
    // A row redrawn in place (a carriage return) shows its last state; colours are not text.
    let colourful =
        golden::SINGLE.replace("❯ 1. Red", "  1. Rod\r\x1b[38;2;0;180;255m❯ 1. Red\x1b[0m");
    assert_eq!(
        parse_claude_ask(&colourful).cursor_number,
        Some(1),
        "colours and redrawn rows do not matter"
    );
}

#[test]
fn the_fake_draws_what_the_real_dialog_drew() {
    let cases: Vec<(&str, FakeClaudeAsk, &str)> = vec![
        ("single", FakeClaudeAsk::new(&[color()]), golden::SINGLE),
        ("form q1", FakeClaudeAsk::new(&form()), golden::FORM_Q1),
        (
            "review",
            {
                let mut f = FakeClaudeAsk::new(&form());
                for k in ["down", "enter", "enter", "right"] {
                    f.press(k);
                }
                f
            },
            golden::REVIEW,
        ),
        (
            "answered form, back on q1",
            {
                let mut f = FakeClaudeAsk::new(&form());
                for k in ["down", "enter", "enter", "left", "left"] {
                    f.press(k);
                }
                f
            },
            golden::FORM_Q1_ANSWERED,
        ),
        (
            "typed on the other row",
            {
                let mut f = FakeClaudeAsk::new(&[color()]);
                for k in ["down", "down", "down"] {
                    f.press(k);
                }
                f.paste("purple");
                f
            },
            golden::SINGLE_OTHER,
        ),
        (
            "multi with the cursor on submit",
            {
                let mut f = FakeClaudeAsk::new(&[fruits()]);
                for k in ["enter", "down", "down", "enter", "down", "down"] {
                    f.press(k);
                }
                f.paste("Elderberry");
                f.press("down");
                f
            },
            golden::MULTI_SUBMIT_ROW,
        ),
        (
            "wrapping question",
            FakeClaudeAsk::new(&[deploy()]),
            golden::WRAP,
        ),
    ];
    for (name, fake, want) in cases {
        assert_eq!(
            shape(&parse_claude_ask(&fake.screen())),
            shape(&parse_claude_ask(want)),
            "{name}"
        );
    }
}

// ------------------------------------------------------------------- the driver

#[test]
fn a_single_choice_moves_to_the_row_and_enters_never_a_digit_that_could_be_text() {
    let mut fake = FakeClaudeAsk::new(&[color()]);
    let sent = drive(&mut fake, &[pick(&[1])]);
    assert!(fake.submitted);
    assert_eq!(fake.answer_of(0).as_deref(), Some("Green"));
    assert_eq!(sent.len(), 1);
    assert_eq!(keys_of(&sent[0]), ["down", "enter"]);
    assert!(submits(&sent[0]));
}

#[test]
fn a_typed_answer_goes_in_the_other_row_once_and_is_submitted() {
    let mut fake = FakeClaudeAsk::new(&[color()]);
    let sent = drive(&mut fake, &[own("purple, with a comma")]);
    assert!(fake.submitted);
    assert_eq!(fake.answer_of(0).as_deref(), Some("purple, with a comma"));
    let typed: Vec<&str> = sent
        .iter()
        .filter_map(|s| match s {
            AskStep::Send { text: Some(t), .. } => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(typed, ["purple, with a comma"]);
}

#[test]
fn a_multi_select_toggles_what_differs_then_goes_to_the_review_and_submits() {
    let mut fake = FakeClaudeAsk::new(&[fruits()]);
    drive(&mut fake, &[pick(&[0, 2])]);
    assert!(fake.submitted);
    assert_eq!(fake.answer_of(0).as_deref(), Some("Apple, Cherry"));
}

#[test]
fn a_multi_select_with_a_typed_answer_too() {
    let mut fake = FakeClaudeAsk::new(&[fruits()]);
    drive(
        &mut fake,
        &[AskAnswer {
            selected: vec![0, 2],
            custom: Some("Elderberry".to_owned()),
        }],
    );
    assert_eq!(
        fake.answer_of(0).as_deref(),
        Some("Apple, Cherry, Elderberry")
    );
    assert!(fake.submitted);
}

#[test]
fn a_form_answers_each_question_in_its_tab_then_checks_the_review_and_submits() {
    let mut fake = FakeClaudeAsk::new(&form());
    drive(&mut fake, &[pick(&[1]), pick(&[0, 2])]);
    assert!(fake.submitted);
    assert_eq!(
        [fake.answer_of(0).unwrap(), fake.answer_of(1).unwrap()],
        ["Go", "Tests, CI"]
    );
}

#[test]
fn a_half_answered_form_answers_again_what_was_answered_otherwise() {
    let mut fake = FakeClaudeAsk::new(&form());
    fake.press("enter"); // Python, on to the second tab
    drive(&mut fake, &[pick(&[1]), pick(&[1])]);
    assert!(fake.submitted);
    assert_eq!(
        [fake.answer_of(0).unwrap(), fake.answer_of(1).unwrap()],
        ["Go", "Docs"]
    );
}

#[test]
fn a_question_that_wraps_is_still_that_question() {
    let mut fake = FakeClaudeAsk::new(&[deploy()]);
    drive(&mut fake, &[pick(&[0])]);
    assert_eq!(fake.answer_of(0).as_deref(), Some(DEPLOY_FIRST));
}

#[test]
fn from_chat_about_this_or_the_submit_row_the_arrows_count_the_rows_of_the_dialog() {
    for multi in [true, false] {
        let question = if multi { fruits() } else { color() };
        let mut fake = FakeClaudeAsk::new(std::slice::from_ref(&question));
        // Down to the last row: Chat about this.
        for _ in 0..question.options.len() + if multi { 2 } else { 1 } {
            fake.press("down");
        }
        assert_eq!(
            parse_claude_ask(&fake.screen()).cursor_number,
            Some(question.options.len() + if multi { 3 } else { 2 }),
            "multi {multi}: the cursor is on Chat"
        );
        drive(&mut fake, &[pick(if multi { &[0, 2] } else { &[1] })]);
        assert!(fake.submitted, "multi {multi}");
        assert_eq!(
            fake.answer_of(0).as_deref(),
            Some(if multi { "Apple, Cherry" } else { "Green" }),
            "multi {multi}"
        );
    }
}

#[test]
fn no_dialog_on_the_screen_is_done() {
    let mut d = ClaudeAskDriver::new(ask(&[color()]), vec![pick(&[0])]);
    assert_eq!(d.next("⏺ Done\n\n❯ "), AskStep::Done);
}

#[test]
fn another_question_on_the_screen_is_not_answered() {
    let other = FakeClaudeAsk::new(&[q(
        "Color",
        "Which animal?",
        false,
        &[("Cat", ""), ("Dog", "")],
    )]);
    let step = ClaudeAskDriver::new(ask(&[color()]), vec![pick(&[0])]).next(&other.screen());
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn options_that_are_not_the_ones_asked_are_not_answered() {
    let other = FakeClaudeAsk::new(&[q(
        "Color",
        "Which color do you prefer?",
        false,
        &[("Cyan", ""), ("Magenta", ""), ("Black", "")],
    )]);
    let step = ClaudeAskDriver::new(ask(&[color()]), vec![pick(&[0])]).next(&other.screen());
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn text_already_in_the_other_row_is_never_overwritten() {
    let mut fake = FakeClaudeAsk::new(&[color()]);
    for k in ["down", "down", "down"] {
        fake.press(k);
    }
    fake.paste("abc");
    let step = ClaudeAskDriver::new(ask(&[color()]), vec![own("purple")]).next(&fake.screen());
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn a_dialog_that_does_not_react_gives_up_instead_of_pressing_forever() {
    let fake = FakeClaudeAsk::new(&[color()]);
    let mut driver = ClaudeAskDriver::new(ask(&[color()]), vec![pick(&[2])]);
    let screen = fake.screen();
    let mut last = AskStep::Done;
    for _ in 0..6 {
        last = driver.next(&screen);
        if !matches!(last, AskStep::Send { .. }) {
            break;
        }
    }
    assert!(matches!(last, AskStep::Mismatch(_)), "{last:?}");
}

#[test]
fn a_driver_gives_up_after_its_step_budget() {
    let mut fake = FakeClaudeAsk::new(&form());
    let mut driver =
        ClaudeAskDriver::with_max_steps(ask(&form()), vec![pick(&[1]), pick(&[0, 2])], 2);
    let mut last = AskStep::Done;
    for _ in 0..10 {
        last = driver.next(&fake.screen());
        let AskStep::Send { keys, .. } = &last else {
            break;
        };
        for k in keys {
            fake.press(k);
        }
    }
    assert_eq!(last, AskStep::Mismatch("too many steps".to_owned()));
}

#[test]
fn a_review_that_shows_another_answer_sends_the_person_back_not_on() {
    let mut fake = FakeClaudeAsk::new(&form());
    for k in ["enter", "enter", "right"] {
        fake.press(k);
    }
    let mut driver = ClaudeAskDriver::new(ask(&form()), vec![pick(&[1]), pick(&[0])]);
    let step = driver.next(&fake.screen());
    assert!(!submits(&step));
    assert_eq!(
        keys_of(&step),
        ["left", "left"],
        "back to the first question"
    );
}

#[test]
fn a_review_that_matches_is_submitted_with_the_digit_that_works_wherever_the_cursor_is() {
    let mut fake = FakeClaudeAsk::new(&form());
    for k in ["down", "enter", "enter", "right"] {
        fake.press(k);
    }
    let mut driver = ClaudeAskDriver::new(ask(&form()), vec![pick(&[1]), pick(&[0])]);
    let step = driver.next(&fake.screen());
    assert_eq!(keys_of(&step), ["1"]);
    assert!(submits(&step));
}

#[test]
fn a_review_that_never_matches_stops_after_two_fixes() {
    let mut fake = FakeClaudeAsk::new(&form());
    for k in ["enter", "enter", "right"] {
        fake.press(k);
    }
    // The fake keeps showing Python: the driver sends the person back twice, then gives up.
    let review = fake.screen();
    let mut driver = ClaudeAskDriver::new(ask(&form()), vec![pick(&[1]), pick(&[0])]);
    assert_eq!(keys_of(&driver.next(&review)), ["left", "left"]);
    assert_eq!(keys_of(&driver.next(&review)), ["left", "left"]);
    let AskStep::Mismatch(why) = driver.next(&review) else {
        panic!("a third try");
    };
    assert!(why.contains("would not take its answer"), "{why}");
}

#[test]
fn answers_that_do_not_pair_with_the_questions_are_never_driven() {
    let fake = FakeClaudeAsk::new(&[color()]);
    let step = ClaudeAskDriver::new(ask(&[color()]), vec![]).next(&fake.screen());
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn a_lone_single_choice_needs_exactly_one_option() {
    let fake = FakeClaudeAsk::new(&[color()]);
    for wrong in [pick(&[]), pick(&[0, 1]), pick(&[9])] {
        let step = ClaudeAskDriver::new(ask(&[color()]), vec![wrong]).next(&fake.screen());
        assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
    }
}

#[test]
fn the_trait_plans_like_the_driver() {
    let fake = FakeClaudeAsk::new(&[color()]);
    let mut stepper = ClaudeAsk.stepper(&ask(&[color()]), &[pick(&[1])]);
    assert_eq!(keys_of(&stepper(&fake.screen())), ["down", "enter"]);
    assert!(ClaudeAsk.looks_like_ask(&fake.screen()));
    assert!(!ClaudeAsk.looks_like_ask("❯ "));
}

// ----------------------------------------------------------- the result Claude recorded

/// The tool result as the log holds it: Claude words the lead-in two ways.
fn result(pairs: &[(&str, &str)], lead: &str) -> String {
    let body = pairs
        .iter()
        .map(|(q, a)| format!("\"{q}\"=\"{a}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{lead} {body}. You can now continue with the user's answers in mind.")
}

#[test]
fn the_result_says_what_was_chosen_in_either_wording_for_one_question_or_two() {
    let single = result(
        &[("Which color do you prefer?", "Green")],
        "Your questions have been answered:",
    );
    assert!(claude_ask_result_matches(
        Some(&single),
        &ask(&[color()]),
        &[pick(&[1])]
    ));
    let multi = result(
        &[("Which fruits do I like?", "Apple, Cherry")],
        "The user answered:",
    );
    assert!(claude_ask_result_matches(
        Some(&multi),
        &ask(&[fruits()]),
        &[pick(&[0, 2])]
    ));
    let typed = result(
        &[("Which color do you prefer?", "purple")],
        "The user answered:",
    );
    assert!(claude_ask_result_matches(
        Some(&typed),
        &ask(&[color()]),
        &[own("purple")]
    ));
    let two = result(
        &[
            ("Which language do I prefer?", "Go"),
            ("Which extras do I want?", "Tests, CI"),
        ],
        "The user answered:",
    );
    assert!(claude_ask_result_matches(
        Some(&two),
        &ask(&form()),
        &[pick(&[1]), pick(&[0, 2])]
    ));
}

#[test]
fn a_form_with_a_typed_answer_after_the_labels_as_claude_words_it() {
    let given = result(
        &[
            ("Which language do I prefer?", "Go"),
            ("Which extras do I want?", "Tests, CI, Docs please"),
        ],
        "Your questions have been answered:",
    );
    let with_typed = [
        pick(&[1]),
        AskAnswer {
            selected: vec![0, 2],
            custom: Some("Docs please".to_owned()),
        },
    ];
    assert!(claude_ask_result_matches(
        Some(&given),
        &ask(&form()),
        &with_typed
    ));
    let without = [pick(&[1]), pick(&[0, 2])];
    assert!(
        !claude_ask_result_matches(Some(&given), &ask(&form()), &without),
        "the typed part is missing"
    );
}

#[test]
fn the_result_catches_an_answer_that_is_another_one() {
    let single = result(
        &[("Which color do you prefer?", "Green")],
        "The user answered:",
    );
    assert!(!claude_ask_result_matches(
        Some(&single),
        &ask(&[color()]),
        &[pick(&[0])]
    ));
    let multi = result(
        &[("Which fruits do I like?", "Apple, Cherry")],
        "The user answered:",
    );
    assert!(!claude_ask_result_matches(
        Some(&multi),
        &ask(&[fruits()]),
        &[pick(&[0])]
    ));
    assert!(!claude_ask_result_matches(
        None,
        &ask(&[color()]),
        &[pick(&[0])]
    ));
}

#[test]
fn the_result_is_compared_with_white_space_flattened_and_needs_every_question() {
    let wrapped = "The user answered: \"Which color\n do you prefer?\"=\"Green\"";
    assert!(claude_ask_result_matches(
        Some(wrapped),
        &ask(&[color()]),
        &[pick(&[1])]
    ));
    let only_first = result(
        &[("Which language do I prefer?", "Go")],
        "The user answered:",
    );
    assert!(!claude_ask_result_matches(
        Some(&only_first),
        &ask(&form()),
        &[pick(&[1]), pick(&[0])]
    ));
    assert!(!claude_ask_result_matches(
        Some(&only_first),
        &ask(&form()),
        &[pick(&[1])]
    ));
    assert!(!claude_ask_result_matches(Some("anything"), &ask(&[]), &[]));
    assert!(ClaudeAsk.result_matches(Some(&only_first), &ask(&form()[..1]), &[pick(&[1])]));
}

#[test]
fn expected_answer_is_the_label_the_labels_in_order_or_the_text() {
    let a = AskAnswer {
        selected: vec![2, 0],
        custom: Some("  Elderberry ".to_owned()),
    };
    assert_eq!(expected_answer(&fruits(), &a), "Apple, Cherry, Elderberry");
    assert_eq!(expected_answer(&color(), &a), "Elderberry");
    assert_eq!(expected_answer(&color(), &pick(&[1])), "Green");
    assert_eq!(expected_answer(&color(), &pick(&[])), "");
}
