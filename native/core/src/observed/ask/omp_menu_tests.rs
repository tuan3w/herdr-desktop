//! omp's menus (port of the `menus` group of `omp_ask_driver_test.dart`, on synthetic screens in the layout
//! of the captured ones) and the result omp's question tool records (`askResultMatches` has no test of its
//! own in herdr-mobile; these pin what its doc comment says).

use super::omp_fixtures::{
    PLAN_HINT, approval_screen, db_question, pending, plan_review_screen, question, tools_question,
};
use super::*;
use crate::observed::model::{AskAnswer, AskDriver, PendingAsk};

fn labels(options: &[OmpMenuOption]) -> Vec<&str> {
    options.iter().map(|o| o.label.as_str()).collect()
}

fn plan(usage: &str, cursor: usize) -> OmpPlanReviewScreen {
    parse_omp_plan_review(&plan_review_screen(cursor, usage, false, PLAN_HINT)).unwrap()
}

// ----------------------------------------------------------------- tool approval

#[test]
fn a_tool_approval_names_the_tool_what_it_runs_the_options_and_the_keys() {
    let a = parse_omp_approval(&approval_screen(
        "bash",
        &["Command: echo hello && date -u +%Y"],
        0,
    ))
    .unwrap();
    assert_eq!(a.tool, "bash");
    assert_eq!(a.detail, ["Command: echo hello && date -u +%Y"]);
    assert_eq!(labels(&a.options), ["Approve", "Deny"]);
    assert_eq!(a.cursor_index(), Some(0));
    assert_eq!(a.approve().unwrap(), ["enter"]);
    assert_eq!(a.deny().unwrap(), ["down", "enter"]);

    let d = parse_omp_approval(&approval_screen(
        "bash",
        &["Command: echo hello && date -u +%Y"],
        1,
    ))
    .unwrap();
    assert_eq!(d.cursor_index(), Some(1));
    assert_eq!(d.approve().unwrap(), ["up", "enter"]);
    assert_eq!(d.deny().unwrap(), ["enter"]);
    assert_eq!(OmpApprovalScreen::CANCEL, ["esc"]);

    let w = parse_omp_approval(&approval_screen(
        "write",
        &["Path: hello.txt", "Content:", "hello omq"],
        0,
    ))
    .unwrap();
    assert_eq!(w.tool, "write");
    assert_eq!(w.detail, ["Path: hello.txt", "Content:", "hello omq"]);
}

#[test]
fn an_approval_without_a_cursor_cannot_be_keyed() {
    let mut screen = approval_screen("bash", &["Command: ls"], 0);
    screen = screen.replace('❯', " ");
    let a = parse_omp_approval(&screen).unwrap();
    assert_eq!(a.cursor_index(), None);
    assert_eq!(a.approve(), None);
    assert_eq!(omp_menu_prompt(&screen), None);
}

#[test]
fn the_approval_prompt_offers_each_option_with_its_keys_and_the_command_as_subject() {
    let prompt = omp_menu_prompt(&approval_screen(
        "bash",
        &["Reason: check the date", "Command: date -u +%Y"],
        1,
    ))
    .unwrap();
    assert_eq!(prompt.question, "Allow tool: bash");
    assert_eq!(prompt.subject.as_deref(), Some("date -u +%Y"));
    assert_eq!(
        prompt
            .options
            .iter()
            .map(|o| (o.label.as_str(), o.keys.clone()))
            .collect::<Vec<_>>(),
        [
            ("Approve", vec!["up".to_owned(), "enter".to_owned()]),
            ("Deny", vec!["enter".to_owned()]),
        ]
    );
    assert!(prompt.options.iter().all(|o| !o.needs_confirm()));
    assert_eq!(prompt.digest, crate::prompt::prompt_digest(&prompt));
    // The digest does not depend on where the cursor is: the same question, whatever the person did.
    let moved = omp_menu_prompt(&approval_screen(
        "bash",
        &["Reason: check the date", "Command: date -u +%Y"],
        0,
    ))
    .unwrap();
    assert_eq!(moved.digest, prompt.digest);
    assert_ne!(
        omp_menu_prompt(&approval_screen("bash", &["Command: date"], 0))
            .unwrap()
            .digest,
        prompt.digest
    );
}

#[test]
fn an_approval_with_no_named_row_shows_every_row_as_the_subject() {
    let prompt = omp_menu_prompt(&approval_screen(
        "edit",
        &["Rewrite the header", "of hello.txt"],
        0,
    ))
    .unwrap();
    assert_eq!(
        prompt.subject.as_deref(),
        Some("Rewrite the header\nof hello.txt")
    );
    let bare = omp_menu_prompt(&approval_screen("edit", &[], 0)).unwrap();
    assert_eq!(bare.subject, None);
}

// ------------------------------------------------------------------- plan review

#[test]
fn plan_review_lists_its_options_and_keys() {
    let p = plan("(~6.8k / 200k)", 0);
    assert_eq!(
        labels(&p.options),
        [
            "Approve and execute",
            "Approve and compact context",
            "Approve and keep context (~6.8k / 200k)",
            "Refine plan",
            "Save and quit",
        ]
    );
    assert_eq!(p.cursor_index(), Some(0));
    assert_eq!(p.approve().unwrap(), ["enter"]);
    assert_eq!(
        p.keys_for_label("Refine").unwrap(),
        ["down", "down", "down", "enter"]
    );
    let r = plan("(~6.8k / 200k)", 3);
    assert_eq!(r.cursor_index(), Some(3));
    assert_eq!(r.approve().unwrap(), ["up", "up", "up", "enter"]);
}

#[test]
fn the_model_slider_rows_are_not_options() {
    let p = parse_omp_plan_review(&plan_review_screen(0, "(~23k / 1m)", true, PLAN_HINT)).unwrap();
    assert_eq!(
        labels(&p.options),
        [
            "Approve and execute",
            "Approve and compact context",
            "Approve and keep context (~23k / 1m)",
            "Refine plan",
            "Save and quit",
        ]
    );
    assert_eq!(p.cursor_index(), Some(0));
    assert_eq!(
        p.keys_for_label("Refine").unwrap(),
        ["down", "down", "down", "enter"]
    );
}

#[test]
fn keep_context_over_95_percent_is_skipped_by_the_cursor_so_the_keys_do_not_count_it() {
    // 199k of 200k: disabled for sure, so Refine is two downs, not three (three would land on "Save and
    // quit", which quits omp).
    let over = plan("(~199k / 200k)", 0);
    assert_eq!(
        over.keys_for_label("Refine").unwrap(),
        ["down", "down", "enter"]
    );
    assert_eq!(
        over.keys_for_label("Save").unwrap(),
        ["down", "down", "down", "enter"]
    );
    assert_eq!(over.keys_for_label("Approve and keep"), None);
    let under = plan("(~150k / 200k)", 0);
    assert_eq!(
        under.keys_for_label("Refine").unwrap(),
        ["down", "down", "down", "enter"]
    );
    assert_eq!(
        under.keys_for_label("Approve and keep").unwrap(),
        ["down", "down", "enter"]
    );
    // 1m is 0.95m to 1.05m once rounded, so 950k used cannot be told.
    let edge = plan("(~950k / 1m)", 0);
    assert_eq!(edge.keys_for_label("Refine"), None);
    assert_eq!(
        edge.keys_for_label("Approve and compact").unwrap(),
        ["down", "enter"]
    );
    // A narrow pane cuts the label: the usage cannot be read, so it may be over.
    let cut = plan("(~199k / 2…", 0);
    assert_eq!(cut.keys_for_label("Refine"), None);
    assert_eq!(
        cut.keys_for_label("Approve and compact").unwrap(),
        ["down", "enter"]
    );
    // Going up crosses the row too.
    let from = plan("(~199k / 200k)", 3);
    assert_eq!(
        from.keys_for_label("Approve and execute").unwrap(),
        ["up", "up", "enter"]
    );
}

#[test]
fn a_keep_context_row_without_usage_is_enabled() {
    let bare = parse_omp_plan_review(&plan_review_screen(0, "", false, PLAN_HINT)).unwrap();
    assert_eq!(bare.options[2].label, "Approve and keep context");
    assert_eq!(
        bare.keys_for_label("Refine").unwrap(),
        ["down", "down", "down", "enter"]
    );
}

#[test]
fn with_the_focus_off_the_options_no_key_chooses_one() {
    let on_text = plan_review_screen(0, "(~6.8k / 200k)", false, "↑/↓ scroll · ⇧ faster");
    let p = parse_omp_plan_review(&on_text).unwrap();
    assert!(!p.focus_on_options);
    assert_eq!(p.keys_for(0), None);
    assert_eq!(omp_menu_prompt(&on_text), None);
    let focused =
        omp_menu_prompt(&plan_review_screen(0, "(~6.8k / 200k)", false, PLAN_HINT)).unwrap();
    assert_eq!(focused.options.len(), 5);
    assert_eq!(focused.question, "Plan mode - next step");
    assert_eq!(focused.subject, None);
}

#[test]
fn a_plan_review_prompt_leaves_out_an_option_no_keys_reach_for_sure() {
    let prompt =
        omp_menu_prompt(&plan_review_screen(0, "(~199k / 200k)", false, PLAN_HINT)).unwrap();
    let offered: Vec<&str> = prompt.options.iter().map(|o| o.label.as_str()).collect();
    assert_eq!(
        offered,
        [
            "Approve and execute",
            "Approve and compact context",
            "Refine plan",
            "Save and quit"
        ]
    );
}

#[test]
fn the_plan_review_is_waited_on_but_nothing_else_is() {
    assert!(omp_waits_on_plan_review(&plan_review_screen(
        0,
        "(~6.8k / 200k)",
        false,
        PLAN_HINT
    )));
    assert!(!omp_waits_on_plan_review(&approval_screen(
        "bash",
        &["Command: ls"],
        0
    )));
    assert!(!omp_waits_on_plan_review(""));
}

#[test]
fn other_screens_are_not_menus() {
    let ask = super::omp_fixtures::captures()
        .into_iter()
        .find(|c| c.name == "ask-single")
        .unwrap()
        .build()
        .screen();
    assert!(parse_omp_approval(&ask).is_none());
    assert!(parse_omp_plan_review(&ask).is_none());
    assert!(parse_omp_approval("").is_none());
    assert!(omp_menu_prompt(&ask).is_none());
    assert!(parse_omp_plan_review(&approval_screen("bash", &["Command: ls"], 0)).is_none());
}

// ------------------------------------------------------------ what omp recorded

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

fn form() -> PendingAsk {
    pending(&[
        db_question(),
        tools_question(),
        question("name", "What is it called?", false, None, &[]),
    ])
}

#[test]
fn one_question_is_matched_by_the_labels_it_says_were_selected() {
    let ask = pending(&[tools_question()]);
    let m = |out: &str, a: AskAnswer| ask_result_matches(Some(out), &ask, &[a]);
    assert!(m("User selected: Lint, Integration tests", pick(&[0, 2])));
    assert!(
        m("User selected: Integration tests, Lint", pick(&[0, 2])),
        "order is free"
    );
    assert!(!m("User selected: Lint", pick(&[0, 2])));
    assert!(!m("User selected: Lint, Unit tests", pick(&[0, 2])));
    assert!(
        !m("User selected: Lint, Lint", pick(&[0, 2])),
        "a repeat is not a second label"
    );
    assert!(!m("something else", pick(&[0])));
    assert!(!m("User provided custom input: Lint", pick(&[0])));
}

#[test]
fn notes_omp_appends_are_not_part_of_the_answer() {
    let ask = pending(&[db_question()]);
    assert!(ask_result_matches(
        Some("User selected: Postgres (auto-selected after timeout)"),
        &ask,
        &[pick(&[1])]
    ));
    assert!(ask_result_matches(
        Some("User selected: Postgres (note: because) (auto-selected after timeout)"),
        &ask,
        &[pick(&[1])]
    ));
}

#[test]
fn a_custom_answer_is_matched_verbatim_and_alone_or_with_the_labels() {
    let ask = pending(&[tools_question()]);
    let typed = AskAnswer {
        selected: vec![0],
        custom: Some("nightly only".to_owned()),
    };
    let both = "User selected: Lint\nUser provided custom input: nightly only";
    assert!(ask_result_matches(
        Some(both),
        &ask,
        std::slice::from_ref(&typed)
    ));
    // An own answer wins over the options: the text alone is enough when no labels are recorded...
    assert!(ask_result_matches(
        Some("User provided custom input: nightly only"),
        &ask,
        std::slice::from_ref(&typed)
    ));
    // ...but labels that are recorded must be the chosen ones.
    assert!(!ask_result_matches(
        Some("User selected: Unit tests\nUser provided custom input: nightly only"),
        &ask,
        std::slice::from_ref(&typed)
    ));
    assert!(!ask_result_matches(
        Some("User selected: Lint\nUser provided custom input: weekly"),
        &ask,
        &[typed]
    ));
    let only = pending(&[db_question()]);
    assert!(ask_result_matches(
        Some("User provided custom input: Tên khác"),
        &only,
        &[own("Tên khác")]
    ));
    assert!(!ask_result_matches(
        Some("User selected: SQLite"),
        &only,
        &[own("Tên khác")]
    ));
}

#[test]
fn several_questions_have_one_line_each() {
    let ask = form();
    let answers = [pick(&[1]), pick(&[0, 2]), own("Hà Nội")];
    let out = "User answers:\ndb: Postgres\ntools: [Integration tests, Lint]\nname: \"Hà Nội\"";
    assert!(ask_result_matches(Some(out), &ask, &answers));
    assert!(ask_result_matches(
        Some(&out.replace("\"Hà Nội\"", "“Hà Nội”")),
        &ask,
        &answers
    ));
    assert!(!ask_result_matches(
        Some(&out.replace("db: Postgres", "db: SQLite")),
        &ask,
        &answers
    ));
    assert!(
        !ask_result_matches(
            Some("User answers:\ndb: Postgres\ntools: [Lint, Integration tests]"),
            &ask,
            &answers
        ),
        "a question without a line"
    );
    assert!(
        ask_result_matches(
            Some(&out.replace(
                "tools: [Integration tests, Lint]",
                "tools: Integration tests, Lint"
            )),
            &ask,
            &answers
        ),
        "brackets are optional"
    );
}

#[test]
fn nothing_recorded_or_nothing_to_compare_is_no_match() {
    let ask = pending(&[db_question()]);
    assert!(!ask_result_matches(None, &ask, &[pick(&[0])]));
    assert!(!ask_result_matches(
        Some("User selected: SQLite"),
        &ask,
        &[]
    ));
    assert!(!ask_result_matches(
        Some("User selected: SQLite"),
        &ask,
        &[pick(&[0]), pick(&[0])]
    ));
    assert!(!ask_result_matches(
        Some("User selected: SQLite"),
        &pending(&[]),
        &[]
    ));
}

#[test]
fn the_trait_checks_through_the_same_function() {
    let ask = pending(&[db_question()]);
    assert!(OmpAsk.result_matches(Some("User selected: DuckDB"), &ask, &[pick(&[2])]));
    assert!(!OmpAsk.result_matches(Some("User selected: DuckDB"), &ask, &[pick(&[1])]));
}
