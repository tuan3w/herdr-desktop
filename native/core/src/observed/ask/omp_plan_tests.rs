//! The omp driver played against the fake dialog: port of `omp_ask_plan_test.dart`. The screens the Dart
//! tests took from captures are the fake's screens at the end of the keys that produced the capture.

use super::fake_omp::{FakeOmpAsk, Seed};
use super::omp_fixtures::{
    FORM_HEADERS, RELEASE_HEADERS, Rng, captures, db_question, form_questions, pending, question,
    release_questions, tools_question, yes_no_question,
};
use super::*;
use crate::observed::model::{AskAnswer, AskDriver, AskQuestion, AskStep, PendingAsk};
use std::collections::BTreeSet;

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

fn blank() -> AskAnswer {
    AskAnswer::default()
}

/// What the dialog should have handed back for `answers`: a custom answer replaces the single choice; a
/// multi-select keeps both.
fn normalised(qs: &[AskQuestion], answers: &[AskAnswer]) -> Vec<AskAnswer> {
    qs.iter()
        .zip(answers)
        .map(|(q, a)| {
            let custom = a.custom.as_deref().filter(|c| !c.trim().is_empty());
            let mut selected = a.selected.clone();
            selected.sort_unstable();
            AskAnswer {
                selected: if !q.multi && custom.is_some() {
                    Vec::new()
                } else {
                    selected
                },
                custom: custom.map(str::to_owned),
            }
        })
        .collect()
}

fn show(a: &[AskAnswer]) -> String {
    a.iter()
        .map(|x| match &x.custom {
            Some(c) => format!("{:?} \"{c}\"", x.selected),
            None => format!("{:?}", x.selected),
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

struct Run {
    steps: Vec<AskStep>,
    /// `done`, or the mismatch text.
    outcome: String,
}

impl Run {
    fn sends(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| matches!(s, AskStep::Send { .. }))
            .count()
    }

    fn listing(&self) -> String {
        self.steps
            .iter()
            .map(|s| format!("{s:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Plays `driver` against `fake` the way the app will: read the screen, ask for a step, send it, read again.
fn drive_with(fake: &mut FakeOmpAsk, driver: &mut OmpAskDriver, limit: usize) -> Run {
    let mut steps = Vec::new();
    for _ in 0..limit {
        let step = driver.next(&fake.screen());
        steps.push(step.clone());
        match step {
            AskStep::Done => {
                return Run {
                    steps,
                    outcome: "done".to_owned(),
                };
            }
            AskStep::Mismatch(why) => {
                return Run {
                    steps,
                    outcome: why,
                };
            }
            AskStep::Send {
                keys,
                text,
                submits,
                ..
            } => {
                assert!(!keys.is_empty() || text.is_some(), "an empty step");
                if let Some(t) = &text {
                    fake.paste(t);
                }
                for k in &keys {
                    fake.press(k);
                }
                assert_eq!(
                    fake.closed,
                    submits,
                    "submits must say whether the dialog ended: {:?}",
                    steps.last()
                );
            }
        }
    }
    Run {
        steps,
        outcome: format!("no end after {limit} steps"),
    }
}

fn drive(fake: &mut FakeOmpAsk, qs: &[AskQuestion], answers: &[AskAnswer]) -> Run {
    let mut driver = OmpAskDriver::new(pending(qs), answers.to_vec());
    drive_with(fake, &mut driver, 120)
}

fn expect_answered(
    fake: &FakeOmpAsk,
    qs: &[AskQuestion],
    answers: &[AskAnswer],
    run: &Run,
    reason: &str,
) {
    assert_eq!(run.outcome, "done", "{reason}\n{}", run.listing());
    assert!(!fake.cancelled, "{reason}");
    let submitted = fake
        .submitted
        .as_ref()
        .unwrap_or_else(|| panic!("{reason}: never submitted\n{}", run.listing()));
    assert_eq!(
        show(submitted),
        show(&normalised(qs, answers)),
        "{reason}\n{}",
        run.listing()
    );
}

fn subset(mask: usize, n: usize) -> Vec<usize> {
    (0..n).filter(|i| mask & (1 << i) != 0).collect()
}

fn screen_of(name: &str) -> String {
    captures()
        .into_iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no capture {name}"))
        .build()
        .screen()
}

/// The keys of the step the driver plans for `screen`.
fn first_keys(ask: &PendingAsk, answers: &[AskAnswer], screen: &str) -> Vec<String> {
    match next_ask_step(ask, answers, screen) {
        AskStep::Send { keys, .. } => keys,
        other => panic!("expected keys, got {other:?}"),
    }
}

fn first_send(
    ask: &PendingAsk,
    answers: &[AskAnswer],
    screen: &str,
) -> (Vec<String>, Option<String>, bool) {
    match next_ask_step(ask, answers, screen) {
        AskStep::Send {
            keys,
            text,
            submits,
            ..
        } => (keys, text, submits),
        other => panic!("expected a send, got {other:?}"),
    }
}

fn seed_cursor(cursor: usize) -> Seed {
    Seed {
        cursor: Some(cursor),
        ..Seed::default()
    }
}

// ------------------------------------------------- a single question, single choice

#[test]
fn every_option_and_a_custom_answer_from_every_cursor_position() {
    let qs = [db_question()];
    for cursor in 0..=3 {
        for want in [
            pick(&[0]),
            pick(&[1]),
            pick(&[2]),
            own("Tên khác — dùng “SQLite” trên Pi"),
        ] {
            let mut fake = FakeOmpAsk::new(&qs);
            fake.seed(0, seed_cursor(cursor));
            let run = drive(&mut fake, &qs, std::slice::from_ref(&want));
            let reason = format!("cursor {cursor}, {}", show(std::slice::from_ref(&want)));
            expect_answered(&fake, &qs, std::slice::from_ref(&want), &run, &reason);
            let most = if want.custom.is_none() { 1 } else { 3 };
            assert!(run.sends() <= most, "{reason}\n{}", run.listing());
        }
    }
}

#[test]
fn a_yes_no_from_the_other_row_up_and_with_nothing_in_the_way() {
    let qs = [yes_no_question()];
    for cursor in 0..=2 {
        for t in [0, 1] {
            let mut fake = FakeOmpAsk::new(&qs);
            fake.seed(0, seed_cursor(cursor));
            let want = [pick(&[t])];
            let run = drive(&mut fake, &qs, &want);
            expect_answered(&fake, &qs, &want, &run, &format!("cursor {cursor} -> {t}"));
        }
    }
}

#[test]
fn the_first_plan_from_the_screen_moves_by_the_cursor_it_reads() {
    let ask = pending(&[db_question()]);
    let want = [pick(&[2])];
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-single")),
        ["down", "down", "enter"]
    );
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-single-down")),
        ["down", "enter"]
    );
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-single-other")),
        ["up", "enter"]
    );
    assert_eq!(
        first_keys(&ask, &[pick(&[0])], &screen_of("ask-single-other")),
        ["up", "up", "up", "enter"]
    );
}

#[test]
fn a_custom_answer_opens_the_editor_types_and_submits_and_a_prefilled_editor_is_cleared_first() {
    let want = [own("Postgres, nhưng dùng PgBouncer")];
    let ask = pending(&[db_question()]);
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-single-other")),
        ["enter"]
    );
    let (keys, text, _) = first_send(&ask, &want, &screen_of("ask-other-editor"));
    assert_eq!(text.as_deref(), Some("Postgres, nhưng dùng PgBouncer"));
    assert!(keys.is_empty());
    let (keys, _, submits) = first_send(&ask, &want, &screen_of("ask-other-typed"));
    assert_eq!(keys, ["enter"]);
    assert!(submits);
    assert_eq!(
        first_keys(
            &ask,
            &[own("something else")],
            &screen_of("ask-other-typed")
        ),
        ["ctrl+u"]
    );
}

// --------------------------------------------------------- a single multi-select

#[test]
fn every_subset_with_and_without_a_custom_answer_from_every_cursor_and_from_messy_states() {
    let qs = [tools_question()];
    let mut rnd = Rng::new(7);
    let mut runs = 0;
    for mask in 0..16 {
        for custom in [None, Some("Lint, nhưng chỉ lúc 3 giờ sáng")] {
            for cursor in 0..=4 {
                for mess in 0..3 {
                    let mut fake = FakeOmpAsk::new(&qs);
                    let selected: BTreeSet<usize> = if mess == 0 {
                        BTreeSet::new()
                    } else {
                        (0..4).filter(|_| rnd.flip()).collect()
                    };
                    fake.seed(
                        0,
                        Seed {
                            cursor: Some(cursor),
                            selected: Some(selected),
                            custom: (mess == 2).then(|| "an old answer".to_owned()),
                        },
                    );
                    let want = [AskAnswer {
                        selected: subset(mask, 4),
                        custom: custom.map(str::to_owned),
                    }];
                    let run = drive(&mut fake, &qs, &want);
                    expect_answered(
                        &fake,
                        &qs,
                        &want,
                        &run,
                        &format!("mask {mask} custom {custom:?} cursor {cursor} mess {mess}"),
                    );
                    runs += 1;
                }
            }
        }
    }
    assert_eq!(runs, 480);
}

#[test]
fn enter_never_toggles_the_final_key_is_an_enter_off_the_other_row() {
    let qs = [tools_question()];
    let mut fake = FakeOmpAsk::new(&qs);
    fake.seed(
        0,
        Seed {
            cursor: Some(4),
            selected: Some(BTreeSet::from([0, 2])),
            custom: None,
        },
    );
    let run = drive(&mut fake, &qs, &[pick(&[0, 2])]);
    let AskStep::Send { keys, .. } = &run.steps[0] else {
        panic!("{:?}", run.steps[0]);
    };
    assert_eq!(keys, &["up", "enter"]);
    assert_eq!(fake.submitted.as_ref().unwrap()[0].selected, [0, 2]);
}

#[test]
fn a_long_answer_cut_with_an_ellipsis_on_the_review_tab_still_matches() {
    let ask = pending(&release_questions());
    let answers = [
        pick(&[24]),
        AskAnswer {
            selected: vec![1, 2],
            custom: Some("tag: v2 — bản thử".to_owned()),
        },
    ];
    let screen = screen_of("ask-long-review-custom");
    assert!(
        parse_ask_screen(&screen)
            .review
            .last()
            .unwrap()
            .answer
            .ends_with('…')
    );
    let (keys, _, submits) = first_send(&ask, &answers, &screen);
    assert_eq!(keys, ["enter"]);
    assert!(submits);
    let other = [
        answers[0].clone(),
        AskAnswer {
            selected: vec![1, 2],
            custom: Some("tag: v3".to_owned()),
        },
    ];
    assert_eq!(
        first_keys(&ask, &other, &screen),
        ["shift+tab"],
        "question 2 of 2 is one tab back from the review tab"
    );
}

#[test]
fn multi_select_plans_from_screens() {
    let ask = pending(&[tools_question()]);
    let want = [pick(&[0, 2])];
    // nothing ticked, cursor on Lint: tick Lint, walk to Integration tests, tick it
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-multi")),
        ["space", "down", "down", "space"]
    );
    // Lint ticked, cursor on Lint
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-multi-one")),
        ["down", "down", "space"]
    );
    // both ticked, cursor on Integration tests: confirm
    let (keys, _, submits) = first_send(&ask, &want, &screen_of("ask-multi-two"));
    assert_eq!(keys, ["enter"]);
    assert!(submits);
    // on the review tab the answers match: submit
    assert_eq!(
        first_keys(&ask, &want, &screen_of("ask-multi-review")),
        ["enter"]
    );
    // the review tab shows something else: go back to the question (one tab)
    assert_eq!(
        first_keys(&ask, &[pick(&[1])], &screen_of("ask-multi-review")),
        ["shift+tab"]
    );
}

// ------------------------------------------------------- several questions in a form

fn answer_sets() -> Vec<Vec<AskAnswer>> {
    vec![
        vec![pick(&[2]), pick(&[0, 2]), own("Hà Nội — dự án")],
        vec![pick(&[0]), blank(), blank()],
        vec![own("my own store"), pick(&[1, 2, 3]), own("x")],
        vec![
            pick(&[1]),
            AskAnswer {
                selected: vec![0, 1, 2, 3],
                custom: Some("and more".to_owned()),
            },
            blank(),
        ],
        vec![blank(), pick(&[3]), own("Tên")],
    ]
}

#[test]
fn every_answer_set_from_every_tab_with_random_cursors_and_old_answers() {
    let qs = form_questions();
    let sets = answer_sets();
    let mut rnd = Rng::new(11);
    let mut runs = 0;
    for (a, set) in sets.iter().enumerate() {
        for tab in 0..=3 {
            for trial in 0..6 {
                let mut fake = FakeOmpAsk::with(&qs, 119, &FORM_HEADERS);
                // A chosen radio cannot be un-chosen in omp, so an old choice is only seeded where the
                // answer is a choice or a typed answer replaces it.
                let wants_choice = !set[0].selected.is_empty() || set[0].custom.is_some();
                let old_choice = wants_choice && rnd.flip();
                fake.seed(
                    0,
                    Seed {
                        cursor: Some(rnd.below(4)),
                        selected: Some(if old_choice {
                            BTreeSet::from([rnd.below(3)])
                        } else {
                            BTreeSet::new()
                        }),
                        custom: None,
                    },
                );
                fake.seed(
                    1,
                    Seed {
                        cursor: Some(rnd.below(5)),
                        selected: Some((0..4).filter(|_| rnd.flip()).collect()),
                        custom: None,
                    },
                );
                if rnd.flip() {
                    fake.seed(
                        2,
                        Seed {
                            custom: Some("old name".to_owned()),
                            ..Seed::default()
                        },
                    );
                }
                if trial % 2 == 1 {
                    fake.seed(
                        0,
                        Seed {
                            custom: Some("an old custom".to_owned()),
                            ..Seed::default()
                        },
                    );
                }
                fake.set_tab(tab);
                let run = drive(&mut fake, &qs, set);
                expect_answered(
                    &fake,
                    &qs,
                    set,
                    &run,
                    &format!("set {a} tab {tab} trial {trial}"),
                );
                runs += 1;
            }
        }
    }
    assert_eq!(runs, 120);
}

#[test]
fn a_clean_run_takes_few_round_trips() {
    let qs = form_questions();
    let set = &answer_sets()[0];
    let mut fake = FakeOmpAsk::with(&qs, 119, &FORM_HEADERS);
    let run = drive(&mut fake, &qs, set);
    expect_answered(&fake, &qs, set, &run, "clean");
    // choose, toggles, next, open editor, type, confirm, submit
    assert!(run.sends() <= 8, "{}", run.listing());
}

#[test]
fn the_plan_reads_the_step_from_the_screen_not_from_what_was_sent_before() {
    let ask = pending(&form_questions());
    let a = &answer_sets()[0];
    // tab 3 of the form with the custom answer already set: confirm it by moving on
    assert_eq!(
        first_keys(&ask, a, &screen_of("ask-form-q3-custom")),
        ["tab"]
    );
    // the review tab agrees with everything: submit
    assert_eq!(
        first_keys(&ask, a, &screen_of("ask-form-review")),
        ["enter"]
    );
    // the review tab lists DuckDB for question 1, the user wants SQLite: go forward 1 tab, not back 3
    let fix = [pick(&[0]), pick(&[0, 2]), own("Hà Nội — dự án")];
    assert_eq!(
        first_keys(&ask, &fix, &screen_of("ask-form-review")),
        ["tab"]
    );
    // the editor is open on question 3 with the right text: Enter
    assert_eq!(
        first_keys(&ask, a, &screen_of("ask-form-editor-prefilled")),
        ["enter"]
    );
    // question 1 answered DuckDB (index 2), the user wants Postgres: one up, Enter
    assert_eq!(
        first_keys(
            &ask,
            &[pick(&[1]), blank(), blank()],
            &screen_of("ask-form-q1-answered")
        ),
        ["up", "enter"]
    );
}

// ------------------------------------------------------------ long lists that scroll

#[test]
fn every_one_of_30_options_and_other_from_the_top_the_middle_and_the_bottom() {
    let qs = release_questions();
    for cursor in [0, 14, 30] {
        for t in 0..=30 {
            let first = if t == 30 {
                own("Release 99, tự nhập")
            } else {
                pick(&[t])
            };
            let second = if t % 2 == 0 {
                pick(&[0, 2])
            } else {
                pick(&[1])
            };
            let a = [first, second];
            let mut fake = FakeOmpAsk::with(&qs, 58, &RELEASE_HEADERS);
            fake.seed(0, seed_cursor(cursor));
            let run = drive(&mut fake, &qs, &a);
            expect_answered(&fake, &qs, &a, &run, &format!("cursor {cursor} target {t}"));
        }
    }
}

#[test]
fn a_multi_select_taller_than_the_box_ticks_rows_that_are_out_of_view() {
    let labels: Vec<(String, &str)> = (1..=40)
        .map(|i| (format!("Choice {i}"), if i % 7 == 0 { "seven" } else { "" }))
        .collect();
    let list: Vec<(&str, &str)> = labels.iter().map(|(l, d)| (l.as_str(), *d)).collect();
    let big = question("many", "Which of these forty?", true, None, &list);
    let mut rnd = Rng::new(3);
    for trial in 0..25 {
        let mut fake = FakeOmpAsk::new(std::slice::from_ref(&big));
        fake.seed(
            0,
            Seed {
                cursor: Some(rnd.below(41)),
                selected: Some((0..40).filter(|_| rnd.below(5) == 0).collect()),
                custom: (trial % 5 == 0).then(|| "old".to_owned()),
            },
        );
        let want = [AskAnswer {
            selected: (0..40).filter(|_| rnd.below(4) == 0).collect(),
            custom: (trial % 3 == 0).then(|| "also: this".to_owned()),
        }];
        let run = drive(&mut fake, std::slice::from_ref(&big), &want);
        expect_answered(
            &fake,
            std::slice::from_ref(&big),
            &want,
            &run,
            &format!("trial {trial}"),
        );
    }
}

// ---------------------------------------------------------------------- zero options

#[test]
fn with_no_options_only_a_typed_answer_is_possible_and_skipping_moves_on() {
    let qs = form_questions();
    let mut fake = FakeOmpAsk::with(&qs, 119, &FORM_HEADERS);
    fake.set_tab(2);
    let want = [pick(&[0]), blank(), own("Dự án mới")];
    let run = drive(&mut fake, &qs, &want);
    expect_answered(&fake, &qs, &want, &run, "zero options");
}

#[test]
fn a_lone_question_with_nothing_to_choose_and_nothing_to_type_cannot_be_answered() {
    let q = [question("a", "Anything?", false, None, &[])];
    let mut fake = FakeOmpAsk::new(&q);
    let run = drive(&mut fake, &q, &[blank()]);
    assert_eq!(run.outcome, "nothing to answer");
    assert!(!fake.closed);
}

// ----------------------------------------------------------------- refusing to guess

#[test]
fn a_dialog_that_does_not_react_gets_two_more_tries_then_the_driver_gives_up() {
    let mut d = OmpAskDriver::new(pending(&[db_question()]), vec![pick(&[2])]);
    let screen = screen_of("ask-single");
    assert!(matches!(d.next(&screen), AskStep::Send { .. }));
    assert!(matches!(d.next(&screen), AskStep::Send { .. }));
    assert!(matches!(d.next(&screen), AskStep::Mismatch(_)));
}

#[test]
fn a_driver_gives_up_after_its_step_budget() {
    let mut fake = FakeOmpAsk::new(&[tools_question()]);
    let mut d = OmpAskDriver::with_max_steps(pending(&[tools_question()]), vec![pick(&[0, 2])], 1);
    let run = drive_with(&mut fake, &mut d, 10);
    assert_eq!(run.outcome, "too many steps");
}

#[test]
fn another_question_on_screen() {
    let step = next_ask_step(
        &pending(&[tools_question()]),
        &[pick(&[0])],
        &screen_of("ask-single"),
    );
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn radios_where_checkboxes_were_asked() {
    let mut asked = db_question();
    asked.multi = true;
    let step = next_ask_step(&pending(&[asked]), &[pick(&[0])], &screen_of("ask-single"));
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn checkboxes_where_radios_were_asked() {
    let mut asked = tools_question();
    asked.multi = false;
    let step = next_ask_step(&pending(&[asked]), &[pick(&[0])], &screen_of("ask-multi"));
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn a_different_number_of_tabs() {
    let qs = form_questions();
    let step = next_ask_step(
        &pending(&qs[..2]),
        &[blank(), blank()],
        &screen_of("ask-form-q1"),
    );
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn a_draft_in_the_composer() {
    let mut fake = FakeOmpAsk::new(&[db_question()]);
    let screen = fake.screen().replacen(
        "↑/↓ move",
        "Finish or clear the current prompt to answer",
        1,
    );
    let step = next_ask_step(&pending(&[db_question()]), &[pick(&[1])], &screen);
    let AskStep::Mismatch(why) = step else {
        panic!("{step:?}");
    };
    assert!(why.contains("draft"), "{why}");
}

#[test]
fn a_single_choice_with_two_answers_and_a_lone_single_choice_with_none() {
    let ask = pending(&[db_question()]);
    let single = screen_of("ask-single");
    assert!(matches!(
        next_ask_step(&ask, &[pick(&[0, 1])], &single),
        AskStep::Mismatch(_)
    ));
    assert!(matches!(
        next_ask_step(&ask, &[blank()], &single),
        AskStep::Mismatch(_)
    ));
}

#[test]
fn no_dialog_on_screen_is_done_and_a_different_dialog_is_not_an_ask() {
    let ask = pending(&[db_question()]);
    let a = [pick(&[1])];
    assert_eq!(
        next_ask_step(&ask, &a, "just a prompt\n π > Haiku"),
        AskStep::Done
    );
    assert_eq!(
        next_ask_step(
            &ask,
            &a,
            &super::omp_fixtures::approval_screen("bash", &["Command: ls"], 0)
        ),
        AskStep::Done
    );
}

#[test]
fn answers_that_do_not_pair_with_the_questions_are_never_driven() {
    let ask = pending(&[db_question()]);
    let step = next_ask_step(&ask, &[], &screen_of("ask-single"));
    assert!(matches!(step, AskStep::Mismatch(_)), "{step:?}");
}

#[test]
fn a_review_that_never_matches_stops_after_two_fixes_instead_of_looping() {
    // The fake shows the real review, but the driver is told a label that cannot match (its text differs
    // from what omp draws).
    let mut lying = tools_question();
    lying.options[3].label = "Type checks".to_owned();
    let mut d = OmpAskDriver::new(pending(&[lying]), vec![pick(&[3])]);
    let mut fake = FakeOmpAsk::new(&[tools_question()]);
    let run = drive_with(&mut fake, &mut d, 120);
    assert_ne!(run.outcome, "done");
    assert!(fake.submitted.is_none());
}

#[test]
fn the_stepper_of_the_trait_plans_like_the_driver() {
    let ask = pending(&[db_question()]);
    let mut step = OmpAsk.stepper(&ask, &[pick(&[2])]);
    let screen = screen_of("ask-single");
    assert_eq!(step(&screen), next_ask_step(&ask, &[pick(&[2])], &screen));
    assert!(OmpAsk.looks_like_ask(&screen));
}
