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
            "1",
            "This computer"
        )
    );
    // The fixture's tab carries herdr's default label (its number); its workspace and pane were named by a person.
    assert_eq!(
        (
            meta.pane_label.as_str(),
            meta.tab_named,
            meta.workspace_named
        ),
        ("payments review", false, true)
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

// ---- names, words for errors, messages, folders, agents, hooks ------------------------------------

/// A fixture over a snapshot of `workspaces`, `tabs` and `panes` (JSON lists) with these `answers`.
fn world(workspaces: Value, tabs: Value, panes: Value, answers: Value) -> Rig {
    common::start_with(json!({
        "snapshot": {"version": "0.9.5", "protocol": 22, "workspaces": workspaces, "tabs": tabs,
                     "panes": panes, "layouts": [], "agents": []},
        "answers": answers,
    }))
}

fn pane(id: &str, workspace: &str, tab: &str, cwd: &str) -> Value {
    json!({"pane_id": id, "workspace_id": workspace, "tab_id": tab, "terminal_id": "t", "cwd": cwd,
           "agent_status": "unknown", "revision": 1})
}

/// What `workspace.create` or `tab.create` answers for a pane that opened in `cwd`.
fn made_in(cwd: &str) -> Value {
    json!({"type": "workspace_created",
           "workspace": {"workspace_id": "w7", "number": 7, "label": "x", "agent_status": "unknown"},
           "tab": {"tab_id": "w7:t1", "workspace_id": "w7", "number": 1, "label": "1", "agent_status": "unknown"},
           "root_pane": {"pane_id": "w7:p1", "workspace_id": "w7", "tab_id": "w7:t1", "terminal_id": "t",
                         "cwd": cwd, "agent_status": "unknown", "revision": 1}})
}

fn error(code: &str, message: &str) -> Value {
    json!({"error": {"code": code, "message": message}})
}

#[test]
fn a_pane_says_which_names_the_person_gave_and_which_are_herdrs_defaults() {
    let rig = world(
        json!([
            {"workspace_id": "w1", "number": 1, "label": "web"},
            {"workspace_id": "w2", "number": 2, "label": "payments"},
            {"workspace_id": "w3", "number": 3, "label": "payments-api",
             "worktree": {"repo_key": "git:p", "repo_name": "payments-api", "repo_root": "/src/payments-api",
                          "checkout_path": "/src/payments-api", "is_linked_worktree": false}},
            {"workspace_id": "w4", "number": 4, "label": "hotfix",
             "worktree": {"repo_key": "git:p", "repo_name": "payments-api", "repo_root": "/src/payments-api",
                          "checkout_path": "/src/hotfix", "is_linked_worktree": true}}
        ]),
        json!([
            {"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "1"},
            {"tab_id": "w1:t3", "workspace_id": "w1", "number": 3, "label": "3"},
            {"tab_id": "w2:t1", "workspace_id": "w2", "number": 1, "label": "deploys"},
            {"tab_id": "w3:t1", "workspace_id": "w3", "number": 1, "label": " "},
            {"tab_id": "w4:t1", "workspace_id": "w4", "number": 1, "label": "1"}
        ]),
        json!([
            pane("w1:p1", "w1", "w1:t1", "/home/dev/web"),
            pane("w1:p3", "w1", "w1:t3", "/home/dev/web"),
            {"pane_id": "w2:p1", "workspace_id": "w2", "tab_id": "w2:t1", "terminal_id": "t",
             "cwd": "/src/api", "label": "  review ", "agent_status": "unknown", "revision": 1},
            pane("w3:p1", "w3", "w3:t1", "/elsewhere"),
            pane("w4:p1", "w4", "w4:t1", "/elsewhere")
        ]),
        json!({}),
    );
    let meta = |pane: &str| rig.engine.pane_summary("local", pane).expect("listed");
    let named = |pane: &str| {
        let m = meta(pane);
        (m.pane_label, m.tab_named, m.workspace_named)
    };
    // herdr's defaults: a tab labelled with its number, a workspace labelled with its folder.
    assert_eq!(named("w1:p1"), (String::new(), false, false));
    assert_eq!(
        named("w1:p3"),
        (String::new(), false, false),
        "tab 3 is `3`"
    );
    // Given by the person: another tab label, another workspace label, a pane label (trimmed).
    assert_eq!(named("w2:p1"), ("review".to_owned(), true, true));
    // A workspace named after its repository is not a given name; a blank tab label is not one either.
    assert_eq!(named("w3:p1"), (String::new(), false, false));
    assert_eq!(
        meta("w3:p1").tab_label,
        " ",
        "the label itself is as herdr said"
    );
    // The checkout's folder is another name herdr uses; `hotfix` is the checkout folder here.
    assert_eq!(named("w4:p1"), (String::new(), false, false));
    // A pane herdr does not have names nothing.
    assert_eq!(named("w9:p9"), (String::new(), false, false));
}

#[test]
fn a_workspace_made_with_a_name_names_its_first_tab_and_the_tab_shows_as_named() {
    let rig = start("empty");
    let made = rig
        .engine
        .create_workspace("local", Some("api"), Some("/home/dev/api"))
        .expect("made");
    assert_eq!(made.tab_id, "w9:t1");
    assert_eq!(
        rig.sent("workspace.create"),
        [json!({"focus": false, "label": "api", "cwd": "/home/dev/api"})]
    );
    assert_eq!(
        rig.sent("tab.rename"),
        [json!({"tab_id": "w9:t1", "label": "api"})]
    );
    let order: Vec<_> = rig
        .fixture()
        .requests(None)
        .into_iter()
        .map(|r| r.method)
        .filter(|m| m == "workspace.create" || m == "tab.rename")
        .collect();
    assert_eq!(order, ["workspace.create", "tab.rename"]);
    // herdr's snapshot after the rename: the tab carries the name.
    rig.fixture()
        .set_snapshot(json!({"version": "0.9.5", "protocol": 22,
        "workspaces": [{"workspace_id": "w9", "number": 9, "label": "api"}],
        "tabs": [{"tab_id": "w9:t1", "workspace_id": "w9", "number": 1, "label": "api"}],
        "panes": [pane("w9:p1", "w9", "w9:t1", "/home/dev/api")], "layouts": [], "agents": []}));
    wait_for("the snapshot with the named tab", || {
        rig.engine
            .pane_summary("local", "w9:p1")
            .is_some_and(|m| m.tab_named)
    });
    // No name, no tab rename.
    rig.engine
        .create_workspace("local", None, None)
        .expect("made");
    assert_eq!(rig.sent("tab.rename").len(), 1);
}

#[test]
fn a_tab_rename_that_fails_does_not_undo_the_workspace() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"tab.rename": error("tab_not_found", "no tab")}),
    );
    let made = rig
        .engine
        .create_workspace("local", Some("api"), None)
        .expect("the workspace exists, so the call succeeds");
    assert_eq!(made.workspace_id, "w9");
    assert!(rig.sent("workspace.close").is_empty());
}

#[test]
fn closing_something_herdr_no_longer_has_is_closing_it_and_other_errors_have_words() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({
            "pane.close": error("pane_not_found", "no pane w1:p1"),
            "tab.close": error("tab_not_found", "no tab"),
            "workspace.close": error("workspace_not_found", "no workspace"),
            "pane.rename": error("pane_not_found", "no pane w1:p1"),
            "workspace.rename": error("workspace_not_found", "no workspace"),
            "tab.rename": error("tab_not_found", "no tab"),
            "pane.zoom": error("invalid_request", "unknown variant `pane.zoom`, expected one of `ping`"),
            "pane.send_keys": error("permission_denied", "the pane is read only"),
        }),
    );
    let e = &rig.engine;
    assert_eq!(e.close_pane("local", "w1:p1"), Ok(()));
    assert_eq!(e.close_tab("local", "w1:t1"), Ok(()));
    assert_eq!(e.close_workspace("local", "w1"), Ok(()));
    assert_eq!(rig.sent("pane.close").len(), 1, "the close was asked for");
    // Anything but a close is told what is gone.
    assert_eq!(
        e.rename_pane("local", "w1:p1", "x"),
        Err("That pane is gone.".into())
    );
    assert_eq!(
        e.rename_workspace("local", "w1", "x"),
        Err("That workspace is gone.".into())
    );
    assert_eq!(
        e.rename_tab("local", "w1:t1", "x"),
        Err("That tab is gone.".into())
    );
    assert_eq!(
        e.zoom_pane("local", "w1:p1", true),
        Err("This herdr is too old for that. Update herdr on that machine.".into())
    );
    // Other errors are herdr's own words; an unknown machine too.
    assert_eq!(
        e.send_keys("local", "w1:p1", &["esc".to_owned()]),
        Err("the pane is read only".into())
    );
    assert_eq!(
        e.close_pane("nowhere", "w1:p1"),
        Err("There is no machine nowhere".into())
    );
}

#[test]
fn a_close_that_herdr_refuses_for_another_reason_is_an_error() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"pane.close": error("permission_denied", "not yours")}),
    );
    assert_eq!(
        rig.engine.close_pane("local", "w1:p1"),
        Err("not yours".into())
    );
}

#[test]
fn a_message_goes_through_agent_prompt_and_a_refusal_types_nothing() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({
            "agent.prompt": {"type": "agent_prompted"},
        }),
    );
    rig.engine
        .prompt("local", "w1:p1", "run the tests")
        .expect("sent");
    assert_eq!(
        rig.sent("agent.prompt"),
        [json!({"target": "w1:p1", "text": "run the tests"})]
    );
    assert!(rig.sent("pane.send_input").is_empty());

    let refusals = [
        (
            "agent_blocked",
            "The agent is waiting for an answer, so the message wasn't sent. Answer it first.",
        ),
        (
            "agent_not_ready",
            "The agent isn't at its prompt, so the message wasn't sent.",
        ),
        (
            "agent_not_found",
            "No agent runs in that pane any more, so the message wasn't sent.",
        ),
    ];
    for (code, words) in refusals {
        let rig = world(
            json!([]),
            json!([]),
            json!([]),
            json!({"agent.prompt": error(code, "herdr's own sentence")}),
        );
        assert_eq!(
            rig.engine.prompt("local", "w1:p1", "go"),
            Err(words.to_owned())
        );
        assert!(
            rig.sent("pane.send_input").is_empty() && rig.sent("pane.send_keys").is_empty(),
            "{code}: nothing is typed after a refusal"
        );
    }
}

#[test]
fn a_herdr_that_predates_agent_prompt_gets_the_text_and_enter() {
    for refusal in [
        error(
            "invalid_request",
            "unknown variant `agent.prompt`, expected one of `ping`",
        ),
        error("unknown_method", "no such method"),
    ] {
        let rig = world(
            json!([]),
            json!([]),
            json!([]),
            json!({"agent.prompt": refusal}),
        );
        rig.engine
            .prompt("local", "w1:p1", "hello")
            .expect("sent the old way");
        assert_eq!(
            rig.sent("pane.send_input"),
            [json!({"pane_id": "w1:p1", "text": "hello", "keys": ["enter"]})]
        );
    }
}

#[test]
fn a_folder_herdr_could_not_use_is_an_error_and_what_was_made_is_closed() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"workspace.create": made_in("/home/dev"), "tab.create": {
            "type": "tab_created",
            "tab": {"tab_id": "w1:t7", "workspace_id": "w1", "number": 7, "label": "x", "agent_status": "unknown"},
            "root_pane": {"pane_id": "w1:p7", "workspace_id": "w1", "tab_id": "w1:t7", "terminal_id": "t",
                          "cwd": "/home/dev", "agent_status": "unknown", "revision": 1}}}),
    );
    let said = "/src/missing doesn't exist on that machine, so herdr would have opened /home/dev. Nothing was started.";
    assert_eq!(
        rig.engine
            .create_workspace("local", Some("api"), Some("/src/missing"))
            .map(drop),
        Err(said.to_owned())
    );
    assert_eq!(rig.sent("workspace.close"), [json!({"workspace_id": "w7"})]);
    assert!(
        rig.sent("tab.rename").is_empty(),
        "a closed workspace is not named"
    );
    assert_eq!(
        rig.engine
            .create_tab("local", "w1", None, Some("/src/missing"))
            .map(drop),
        Err(said.to_owned())
    );
    assert_eq!(rig.sent("tab.close"), [json!({"tab_id": "w1:t7"})]);

    let start = StartAgent {
        cwd: "/src/missing".to_owned(),
        agent: "claude".to_owned(),
        ..StartAgent::default()
    };
    assert_eq!(
        rig.engine.start_agent("local", &start).map(drop),
        Err(said.to_owned())
    );
    assert!(
        rig.sent("agent.start").is_empty(),
        "no agent starts in the wrong folder"
    );

    // The folder herdr opened is the one asked for, give or take a trailing slash; none asked for is any.
    assert!(
        rig.engine
            .create_workspace("local", None, Some("/home/dev"))
            .is_ok()
    );
    assert!(
        rig.engine
            .create_workspace("local", None, Some("/home/dev/"))
            .is_ok()
    );
    assert!(rig.engine.create_workspace("local", None, None).is_ok());
    assert_eq!(
        rig.sent("workspace.close").len(),
        2,
        "only the two that failed were closed"
    );
}

#[test]
fn a_root_folder_is_compared_as_it_is() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"workspace.create": made_in("/")}),
    );
    assert!(
        rig.engine
            .create_workspace("local", None, Some("/"))
            .is_ok()
    );
    assert!(
        rig.engine
            .create_workspace("local", None, Some("//"))
            .is_ok()
    );
    assert!(
        rig.engine
            .create_workspace("local", None, Some("/home"))
            .is_err()
    );
}

#[test]
fn the_agents_a_machine_can_start_come_from_its_manifests_and_an_old_herdr_says_nothing() {
    let rig = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"server.agent_manifests": {"type": "agent_manifest_status", "manifests": [
            {"agent": "claude", "source": "builtin", "source_kind": "builtin", "local_override_shadowing_remote": false},
            {"agent": "omp", "source": "builtin", "source_kind": "builtin", "local_override_shadowing_remote": false}]}}),
    );
    assert_eq!(
        rig.engine.agent_manifests("local"),
        Ok(vec!["claude".to_owned(), "omp".to_owned()])
    );
    for refusal in [
        None,
        Some(error(
            "invalid_request",
            "unknown variant `server.agent_manifests`",
        )),
    ] {
        let answers = match refusal {
            Some(e) => json!({"server.agent_manifests": e}),
            None => json!({}),
        };
        let rig = world(json!([]), json!([]), json!([]), answers);
        assert_eq!(rig.engine.agent_manifests("local"), Ok(vec![]));
    }
    assert!(rig.engine.agent_manifests("nowhere").is_err());
}

#[test]
fn a_hook_is_installed_for_the_three_agents_and_nothing_else() {
    let rig = start("empty");
    assert_eq!(
        rig.engine.install_integration("local", "claude"),
        Ok(vec!["Installed the claude hook.".to_owned()])
    );
    assert_eq!(
        rig.sent("integration.install"),
        [json!({"target": "claude"})]
    );
    assert!(rig.engine.install_integration("local", "omp").is_ok());
    assert!(rig.engine.install_integration("local", "codex").is_ok());
    for bad in ["", "pi", "claude; rm -rf ~", "Claude"] {
        assert_eq!(
            rig.engine.install_integration("local", bad),
            Err("Unknown agent".to_owned()),
            "{bad:?}"
        );
    }
    assert_eq!(
        rig.sent("integration.install").len(),
        3,
        "the unknown ones were never sent"
    );

    let refused = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"integration.install": error("integration_failed", "cannot write ~/.claude/settings.json")}),
    );
    assert_eq!(
        refused.engine.install_integration("local", "claude"),
        Err("cannot write ~/.claude/settings.json".to_owned())
    );
    let none = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"integration.install": {"type": "integration_install", "target": "omp", "details": {"messages": []}}}),
    );
    assert_eq!(none.engine.install_integration("local", "omp"), Ok(vec![]));
}

#[test]
fn a_worktree_is_removed_by_workspace_id_alone_and_a_refusal_has_words() {
    use herdr_core::worktree::Problem;
    let rig = start("worktrees-missing");
    rig.engine.remove_worktree("local", "w21").expect("removed");
    assert_eq!(
        rig.sent("worktree.remove"),
        [json!({"workspace_id": "w21"})]
    );

    let dirty = world(
        json!([]),
        json!([]),
        json!([]),
        json!({"worktree.remove": error("worktree_dirty", "the worktree has uncommitted changes")}),
    );
    assert_eq!(
        dirty.engine.remove_worktree("local", "w21"),
        Err("the worktree has uncommitted changes".to_owned())
    );
    assert!(
        dirty
            .fixture()
            .requests(None)
            .iter()
            .all(|r| r.params.get("force").is_none() && r.params.get("trust_repository").is_none())
    );

    // A herdr that lacks the method.
    let old = start("empty");
    assert_eq!(
        old.engine.remove_worktree("local", "w21"),
        Err("This herdr can't remove worktrees. Update herdr on that machine.".to_owned())
    );
    assert!(old.engine.remove_worktree("nowhere", "w21").is_err());
    let _ = Problem::Unsupported;
}

#[test]
fn a_chat_name_is_kept_trimmed_cut_and_taken_back_by_an_empty_one() {
    let rig = start("empty");
    let e = &rig.engine;
    assert_eq!(e.chat_name("local", "s1"), None);
    e.rename_chat("local", "s1", "  Billing  ").expect("saved");
    e.rename_chat("local", "s2", &"x".repeat(300))
        .expect("saved");
    assert_eq!(e.chat_name("local", "s1").as_deref(), Some("Billing"));
    assert_eq!(
        e.chat_name("local", "s2").map(|n| n.chars().count()),
        Some(200)
    );
    assert_eq!(
        e.setting("chats.names")
            .and_then(|v| v.get("local/s1").cloned()),
        Some(json!("Billing"))
    );
    let ticks = rig.ticks.load(std::sync::atomic::Ordering::Relaxed);
    e.rename_chat("local", "s1", "   ").expect("saved");
    assert_eq!(
        e.chat_name("local", "s1"),
        None,
        "empty takes the name back"
    );
    wait_for("the UI to be told", || {
        rig.ticks.load(std::sync::atomic::Ordering::Relaxed) > ticks
    });
    e.rename_chat("local", "s2", "").expect("saved");
    assert_eq!(e.setting("chats.names"), None, "no names, no setting");

    // It survives a restart.
    e.rename_chat("local", "s3", "Keep").expect("saved");
    let Rig { engine, dir, .. } = rig;
    drop(engine);
    let again = start_in("empty", dir);
    assert_eq!(
        again.engine.chat_name("local", "s3").as_deref(),
        Some("Keep")
    );
}
