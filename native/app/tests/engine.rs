//! The engine against a scripted herdr: what the board shows, what an answer is allowed to send, what
//! survives a restart.

mod common;

use std::sync::Arc;

use common::{Rig, start, start_in, wait_for};
use herdr_core::schema::AgentStatus;
use herdr_desktop_native::engine::{Config, Engine, LinkKind, MachineInput, Split, StartAgent};
use herdr_desktop_native::fixture::Fixture;
use serde_json::{Value, json};

fn input(name: &str, dest: &str, enabled: bool) -> MachineInput {
    MachineInput {
        id: None,
        name: name.to_owned(),
        dest: dest.to_owned(),
        port: None,
        session: None,
        enabled,
    }
}

/// The scripted herdr's snapshot with one agent's status changed.
fn with_status(rig: &common::Rig, pane: &str, status: &str) -> Value {
    let mut snapshot = rig.fixture().snapshot();
    for list in ["panes", "agents"] {
        for item in snapshot[list].as_array_mut().expect("a list") {
            if item["pane_id"] == pane {
                item["agent_status"] = json!(status);
            }
        }
    }
    snapshot
}

#[test]
fn the_board_groups_a_mixed_fleet_by_project_and_counts_what_needs_the_person() {
    let rig = start("mixed");
    let board = rig.engine.board();
    let c = board.board.counts;
    assert_eq!(
        (c.needs_you, c.to_review, c.working, c.idle, c.offline),
        (2, 1, 2, 3, 0)
    );
    let needs: Vec<_> = board
        .board
        .needs_you
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    assert!(needs.contains(&"payments review"), "{needs:?}");
    assert_eq!(board.title, "(2) Herdr Desktop");
    assert!(
        board
            .status_line
            .starts_with("2 need you · 1 to review · 2 working · heard just now"),
        "{}",
        board.status_line
    );
    let in_projects: usize = board.board.projects.iter().map(|p| p.rows.len()).sum();
    assert_eq!(
        in_projects, 8,
        "every agent is in a project, whatever its state"
    );
}

#[test]
fn an_empty_herdr_says_nothing_is_running() {
    let rig = start("empty");
    let board = rig.engine.board();
    assert_eq!(board.title, "Herdr Desktop");
    assert!(
        board.status_line.starts_with("nothing running"),
        "{}",
        board.status_line
    );
}

#[test]
fn a_blocked_agent_offers_the_answers_with_their_risk() {
    let rig = start("mixed");
    let board = rig.board_with_previews();
    let row = board
        .board
        .needs_you
        .iter()
        .find(|r| r.pane_id == "w1:p1")
        .expect("the claude agent");
    let prompt = board.previews[&row.key()]
        .prompt
        .clone()
        .expect("its question is understood");
    assert_eq!(prompt.question, "Do you want to proceed?");
    assert_eq!(
        prompt.subject.as_deref(),
        Some("touch /tmp/hm-capture-claude/x.txt")
    );
    let labels: Vec<_> = prompt
        .options
        .iter()
        .map(|o| (o.label.as_str(), o.risk.is_some()))
        .collect();
    assert_eq!(labels[0], ("1. Yes", false));
    assert!(
        labels[1].0.starts_with("2. Yes, and always allow") && labels[1].1,
        "{labels:?}"
    );
    assert_eq!(labels[3], ("4. No", false));

    let plain = board
        .board
        .needs_you
        .iter()
        .find(|r| r.pane_id == "w1:p2")
        .expect("the omp agent");
    let ask = board.previews[&plain.key()]
        .prompt
        .clone()
        .expect("a plain yes/no question");
    assert_eq!(ask.options.len(), 3);
}

#[test]
fn a_card_shows_the_last_rows_of_a_working_agent() {
    let rig = start("mixed");
    let board = rig.board_with_previews();
    let row = board
        .rows()
        .find(|r| r.pane_id == "w1:p4")
        .expect("working agent");
    let preview = &board.previews[&row.key()];
    assert!(preview.prompt.is_none());
    assert_eq!(
        preview.rows.last().map(String::as_str),
        Some("  ⠋ Working (2m 14s · esc to interrupt)")
    );
}

#[test]
fn only_a_changed_state_causes_a_preview_read() {
    let rig = start("mixed");
    rig.board_with_previews();
    let reads = rig.sent("pane.read").len();
    assert_eq!(reads, 8, "one read per listed agent");
    for _ in 0..5 {
        rig.engine.board();
    }
    assert_eq!(
        rig.sent("pane.read").len(),
        reads,
        "pulling the board again reads nothing"
    );
}

fn prompt_of(rig: &common::Rig, pane: &str) -> herdr_core::prompt::PromptInfo {
    let board = rig.board_with_previews();
    let row = board.rows().find(|r| r.pane_id == pane).expect("the agent");
    board.previews[&row.key()]
        .prompt
        .clone()
        .expect("a question")
}

#[test]
fn answering_sends_the_keys_of_the_option_the_person_saw() {
    let rig = start("mixed");
    let prompt = prompt_of(&rig, "w1:p1");
    let outcome = rig.engine.answer("local", "w1:p1", &prompt.digest, 0);
    assert_eq!(outcome, herdr_desktop_native::engine::AnswerOutcome::Sent);
    assert_eq!(
        rig.sent("pane.send_keys"),
        [json!({"pane_id": "w1:p1", "keys": ["1", "enter"]})]
    );
}

#[test]
fn a_question_that_changed_since_the_person_saw_it_is_not_answered() {
    use herdr_desktop_native::engine::AnswerOutcome::Changed;
    let rig = start("mixed");
    let seen = prompt_of(&rig, "w1:p1");
    // Between the two reads the agent moved on to another command.
    let rows: Vec<String> = rig
        .fixture()
        .screen("w1:p1")
        .iter()
        .map(|r| r.replace("x.txt", "other.sh"))
        .collect();
    rig.fixture().set_screen("w1:p1", rows);
    assert_eq!(
        rig.engine.answer("local", "w1:p1", &seen.digest, 0),
        Changed
    );
    assert!(rig.sent("pane.send_keys").is_empty(), "nothing was sent");
}

#[test]
fn a_pane_that_no_longer_asks_is_not_answered() {
    use herdr_desktop_native::engine::AnswerOutcome::{Changed, NotBlocked};
    let rig = start("mixed");
    let seen = prompt_of(&rig, "w1:p1");

    // Answered elsewhere: herdr says working now, the screen still shows the old question.
    rig.fixture()
        .set_snapshot(with_status(&rig, "w1:p1", "working"));
    assert_eq!(
        rig.engine.answer("local", "w1:p1", &seen.digest, 0),
        NotBlocked
    );

    // Back to blocked, but the question scrolled away.
    rig.fixture()
        .set_snapshot(with_status(&rig, "w1:p1", "blocked"));
    rig.fixture()
        .set_screen("w1:p1", vec!["  Running tests".to_owned()]);
    assert_eq!(
        rig.engine.answer("local", "w1:p1", &seen.digest, 0),
        Changed
    );

    // The pane is gone altogether.
    let mut gone = with_status(&rig, "w1:p1", "blocked");
    gone["panes"]
        .as_array_mut()
        .expect("panes")
        .retain(|p| p["pane_id"] != "w1:p1");
    rig.fixture().set_snapshot(gone);
    assert_eq!(
        rig.engine.answer("local", "w1:p1", &seen.digest, 0),
        Changed
    );
    assert!(rig.sent("pane.send_keys").is_empty(), "nothing was sent");
}

#[test]
fn an_option_that_does_not_exist_is_not_sent() {
    use herdr_desktop_native::engine::AnswerOutcome::{Changed, Failed};
    let rig = start("mixed");
    let seen = prompt_of(&rig, "w1:p1");
    assert_eq!(
        rig.engine.answer("local", "w1:p1", &seen.digest, 9),
        Changed
    );
    assert!(matches!(
        rig.engine.answer("nowhere", "w1:p1", &seen.digest, 0),
        Failed(_)
    ));
    assert!(rig.sent("pane.send_keys").is_empty());
}

#[test]
fn reviewing_takes_a_finished_agent_off_the_list_and_survives_a_restart() {
    let rig = start("mixed");
    let board = rig.engine.board();
    let done = board.board.to_review[0].review_key();
    rig.engine
        .review(std::slice::from_ref(&done))
        .expect("saved");
    let after = rig.engine.board().board;
    assert_eq!((after.counts.to_review, after.counts.idle), (0, 4));
    assert!(after.rows().all(|r| r.status != AgentStatus::Done));

    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("mixed", dir);
    assert_eq!(
        again.engine.board().board.counts.to_review,
        0,
        "the mark was kept"
    );
    again.engine.unreview(&[done]).expect("saved");
    assert_eq!(
        again.engine.board().board.counts.to_review,
        1,
        "undo brings it back"
    );
}

#[test]
fn a_restart_lists_the_last_known_agents_dimmed_before_herdr_answers() {
    let rig = start("mixed");
    // Previews are asked for once the forwarder has taken the online snapshot in, which is also when it
    // queues the copy that dropping the engine writes.
    let mut known: Vec<String> = rig.board_with_previews().rows().map(|r| r.key()).collect();
    known.sort();
    assert_eq!(known.len(), 8);

    let Rig { engine, dir, .. } = rig;
    drop(engine);
    // A herdr whose snapshot never reads: its link cannot get past connecting.
    let silent = Fixture::from_json(&json!({"snapshot": {"panes": 5}})).expect("a fixture");
    let again = Engine::start(Config {
        data_dir: dir.path().to_path_buf(),
        fixture: Some(silent),
        on_tick: Arc::new(|| {}),
    })
    .expect("the engine starts");

    assert_ne!(again.machine_statuses()[0].state, LinkKind::Online);
    let board = again.board().board;
    let mut shown: Vec<String> = board.rows().map(|r| r.key()).collect();
    shown.sort();
    assert_eq!(shown, known, "the agents of the last run are listed");
    assert!(board.rows().all(|r| r.offline), "and dimmed");
    let c = board.counts;
    assert_eq!(
        (c.needs_you, c.to_review, c.working, c.idle, c.offline),
        (0, 0, 0, 0, 8),
        "none of them is counted"
    );
}

#[test]
fn a_pinned_project_lists_first_and_stays_pinned_after_a_restart() {
    let rig = start("mixed");
    let names = |rig: &Rig| -> Vec<String> {
        rig.engine
            .board()
            .board
            .projects
            .iter()
            .map(|p| p.name.clone())
            .collect()
    };
    assert_eq!(names(&rig), ["payments", "web"]);
    let web = rig.engine.board().board.projects[1].key.clone();
    rig.engine.pin_project(&web, true).expect("saved");
    assert_eq!(names(&rig), ["web", "payments"]);
    assert!(rig.engine.board().board.projects[0].pinned);

    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("mixed", dir);
    assert_eq!(names(&again), ["web", "payments"], "the pin was kept");
    again.engine.pin_project(&web, false).expect("saved");
    assert_eq!(names(&again), ["payments", "web"]);
}

#[test]
fn machines_are_validated_before_anything_starts_and_survive_a_restart() {
    let rig = start("empty");
    let bad = rig
        .engine
        .save_machine(input("Evil", "-oProxyCommand=touch pwned", true));
    assert!(bad.unwrap_err().contains("destination"));
    assert!(
        rig.engine
            .save_machine(input("", "box.example", true))
            .is_err(),
        "a name is required"
    );
    assert!(
        rig.engine
            .save_machine(MachineInput {
                id: Some("local".to_owned()),
                ..input("Me", "x", true)
            })
            .is_err()
    );

    let saved = rig
        .engine
        .save_machine(input("Build box", "dev@build.example", false))
        .expect("valid");
    assert_eq!(saved.id, "m1");
    let listed = rig.engine.machines();
    assert_eq!(
        listed.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["This computer", "Build box"]
    );
    let statuses = rig.engine.machine_statuses();
    assert_eq!(
        statuses[1].state,
        herdr_desktop_native::engine::LinkKind::Off,
        "switched off: no connection is made"
    );

    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("empty", dir);
    assert_eq!(again.engine.machines().len(), 2);
    again.engine.remove_machine("m1").expect("removed");
    assert_eq!(again.engine.machines().len(), 1);
    assert!(again.engine.remove_machine("local").is_err());
}

#[test]
fn a_connection_test_reports_what_herdr_said_or_why_not() {
    let rig = start("mixed");
    let ok = rig.engine.test_connection(&input("Here", "", true));
    assert!(ok.ok);
    assert_eq!(ok.message, "Connected · herdr 0.9.5 · 2 workspaces");
    let refused = rig
        .engine
        .test_connection(&input("Bad", "not a host", true));
    assert!(!refused.ok);
    assert!(
        refused.message.contains("destination"),
        "{}",
        refused.message
    );
}

#[test]
fn a_pane_header_knows_its_names_its_state_and_its_question() {
    let rig = start("mixed");
    let meta = rig
        .engine
        .pane_summary("local", "w1:p1")
        .expect("the machine is listed");
    assert_eq!(
        (
            meta.name.as_str(),
            meta.agent.as_str(),
            meta.workspace_label.as_str(),
            meta.tab_label.as_str(),
            meta.machine_name.as_str()
        ),
        (
            "payments review",
            "claude",
            "payments",
            "main",
            "This computer"
        )
    );
    assert_eq!(
        (meta.workspace_id.as_str(), meta.tab_id.as_str()),
        ("w1", "w1:t1")
    );
    assert_eq!(meta.status, AgentStatus::Blocked);
    assert_eq!(meta.feed, herdr_desktop_native::feed::FeedState::Live);
    wait_for("the question to be read", || {
        rig.engine
            .pane_summary("local", "w1:p1")
            .is_some_and(|m| m.prompt.is_some())
    });
    let shell = rig
        .engine
        .pane_summary("local", "w2:p4")
        .expect("a plain terminal");
    assert_eq!((shell.name.as_str(), shell.agent.as_str()), ("bash", ""));
    assert_eq!(
        (shell.workspace_id.as_str(), shell.tab_id.as_str()),
        ("w2", "w2:t1"),
        "a plain shell is not on the board but can be duplicated"
    );
    let gone = rig
        .engine
        .pane_summary("local", "w9:p9")
        .expect("the machine is listed");
    assert_eq!(gone.feed, herdr_desktop_native::feed::FeedState::Gone);
    assert!(rig.engine.pane_summary("nowhere", "w1:p1").is_none());
}

#[test]
fn settings_are_kept() {
    let rig = start("empty");
    assert_eq!(rig.engine.setting("announce"), None);
    rig.engine
        .set_setting("announce", json!(true))
        .expect("saved");
    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("empty", dir);
    assert_eq!(again.engine.setting("announce"), Some(json!(true)));
    again
        .engine
        .set_setting("announce", Value::Null)
        .expect("cleared");
    assert_eq!(again.engine.setting("announce"), None);
}

#[test]
fn typing_into_a_pane_is_one_request_and_names_follow_herdrs_api() {
    let rig = start("mixed");
    let e = &rig.engine;
    e.send_input("local", "w1:p4", "run the tests", &["enter".to_owned()])
        .expect("sent");
    e.send_keys("local", "w1:p4", &["esc".to_owned()])
        .expect("sent");
    e.rename_pane("local", "w1:p4", "").expect("sent");
    assert_eq!(
        rig.sent("pane.send_input"),
        [json!({"pane_id": "w1:p4", "text": "run the tests", "keys": ["enter"]})]
    );
    assert_eq!(
        rig.sent("pane.send_keys"),
        [json!({"pane_id": "w1:p4", "keys": ["esc"]})]
    );
    assert_eq!(
        rig.sent("pane.rename"),
        [json!({"pane_id": "w1:p4", "label": null})],
        "an empty label clears the name"
    );
    assert_eq!(
        e.split_pane("local", "w1:p4", Split::Down).expect("split"),
        "w1:p8"
    );
    assert!(e.send_text("nowhere", "w1:p4", "x").is_err());
}

#[test]
fn an_agent_is_started_in_a_new_tab_or_workspace_of_the_given_folder() {
    let rig = start("mixed");
    let e = &rig.engine;
    let start = StartAgent {
        cwd: "/home/dev/web".to_owned(),
        agent: "claude".to_owned(),
        name: Some("site".to_owned()),
        workspace_id: Some("w2".to_owned()),
        args: vec![],
    };
    let made = e.start_agent("local", &start).expect("started");
    assert_eq!(made.pane_id, "w1:p9");
    assert_eq!(
        rig.sent("tab.create"),
        [json!({"focus": false, "workspace_id": "w2", "label": "site", "cwd": "/home/dev/web"})]
    );
    assert_eq!(
        rig.sent("agent.start"),
        [json!({"name": "site", "kind": "claude", "pane_id": "w1:p9"})]
    );

    let in_new_workspace = StartAgent {
        workspace_id: None,
        name: None,
        ..start.clone()
    };
    let made = e.start_agent("local", &in_new_workspace).expect("started");
    assert_eq!(made.workspace_id, "w9");
    assert_eq!(rig.sent("workspace.create").len(), 1);
    assert_eq!(
        rig.sent("agent.start")[1]["name"],
        "claude",
        "the kind names it when no name is given"
    );
    assert!(
        e.start_agent(
            "local",
            &StartAgent {
                agent: " ".to_owned(),
                ..start
            }
        )
        .is_err()
    );
}

#[test]
fn visits_are_kept_newest_first_across_a_restart_and_a_forgotten_one_is_gone() {
    let rig = start("empty");
    assert!(rig.engine.recents().is_empty());
    rig.engine.visit("agent:local/w1:p1").expect("saved");
    rig.engine.visit("project:payments").expect("saved");
    rig.engine.visit("agent:local/w1:p1").expect("saved");
    let keys =
        |rig: &Rig| -> Vec<String> { rig.engine.recents().into_iter().map(|r| r.0).collect() };
    assert_eq!(keys(&rig), ["agent:local/w1:p1", "project:payments"]);
    assert_eq!(rig.engine.recents()[0].2, 2, "two visits counted");

    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("empty", dir);
    assert_eq!(keys(&again), ["agent:local/w1:p1", "project:payments"]);
    again.engine.forget("agent:local/w1:p1").expect("saved");
    assert_eq!(keys(&again), ["project:payments"]);
}

// ---- worktrees ---------------------------------------------------------------------------------

#[test]
fn a_lookup_names_the_branch_of_each_checkout_on_the_board() {
    let rig = start("worktrees-missing");
    let branches = |rig: &Rig| -> Vec<(String, Option<String>)> {
        let board = rig.engine.board();
        let api = board
            .board
            .projects
            .iter()
            .find(|p| p.name == "payments-api")
            .expect("the project");
        api.checkouts
            .iter()
            .map(|c| (c.name.clone(), c.branch.clone()))
            .collect()
    };
    assert_eq!(
        branches(&rig),
        [
            ("payments-api".to_owned(), None),
            ("payments-api-hotfix".to_owned(), None)
        ],
        "the snapshot has no branches"
    );
    let ticks = rig.ticks.load(std::sync::atomic::Ordering::Relaxed);
    let list = rig
        .engine
        .worktrees("local", "/home/dev/payments-api")
        .expect("listed");
    assert_eq!(list.worktrees.len(), 2);
    assert_eq!(
        branches(&rig),
        [
            ("payments-api".to_owned(), Some("main".to_owned())),
            (
                "payments-api-hotfix".to_owned(),
                Some("hotfix/2.1".to_owned())
            )
        ]
    );
    wait_for("the UI to be told", || {
        rig.ticks.load(std::sync::atomic::Ordering::Relaxed) > ticks
    });
}

#[test]
fn a_created_worktree_is_sent_as_params_only_and_shows_its_branch() {
    let rig = start("worktrees-missing");
    let made = rig
        .engine
        .create_worktree(
            "local",
            "/home/dev/payments-api",
            Some("worktree/brave-meadow-45e8"),
        )
        .expect("created");
    assert_eq!(
        made.worktree.path,
        "/home/dev/payments-api-brave-meadow-45e8"
    );
    assert_eq!(
        rig.sent("worktree.create"),
        [
            json!({"cwd": "/home/dev/payments-api", "branch": "worktree/brave-meadow-45e8", "focus": false})
        ]
    );
    let board = rig.engine.board();
    let api = board
        .board
        .projects
        .iter()
        .find(|p| p.name == "payments-api")
        .unwrap();
    // The new checkout has no agent yet, so the board does not list it; the branch is kept for when it does.
    assert!(api.checkouts.iter().all(|c| c.path != made.worktree.path));
    assert!(rig.sent("agent.start").is_empty() && rig.sent("workspace.create").is_empty());
}

#[test]
fn a_bad_branch_never_reaches_herdr_and_an_untrusted_repository_is_never_trusted_from_here() {
    let rig = start("worktrees-missing");
    for bad in ["a;touch x", "$(x)", "--force", "a\nb", "a b", "ünï"] {
        let error = rig
            .engine
            .create_worktree("local", "/home/dev/payments-api", Some(bad))
            .expect_err(bad);
        assert_eq!(
            error.problem,
            herdr_core::worktree::Problem::Invalid,
            "{bad:?}"
        );
    }
    assert!(rig.sent("worktree.create").is_empty());

    let error = rig
        .engine
        .create_worktree("local", "/home/dev/web", Some("a"))
        .expect_err("refused");
    assert_eq!(error.problem, herdr_core::worktree::Problem::Untrusted);
    assert!(
        error
            .explain()
            .contains("never trusts a repository for you")
    );
    assert!(
        rig.fixture()
            .requests(None)
            .iter()
            .all(|r| r.params.get("trust_repository").is_none())
    );
}

#[test]
fn a_herdr_without_worktrees_and_an_unknown_machine_are_errors_not_panics() {
    let rig = start("empty");
    let error = rig
        .engine
        .worktrees("local", "/x")
        .expect_err("unsupported");
    assert_eq!(error.problem, herdr_core::worktree::Problem::Unsupported);
    assert!(rig.engine.worktrees("nowhere", "/x").is_err());
}
