//! The board: projects, counts, order, names, offline machines and reviewed episodes.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::snapshot_fixture;
use herdr_core::board::{AgentRow, Board, BoardExtras, FirstSeen, LogNames, SessionRow};
use herdr_core::link::LinkState;
use herdr_core::observed::names::PaneName;
use herdr_core::schema::{AgentStatus, Snapshot};
use herdr_core::store::{MachineId, ReviewKey, Reviewed};
use serde_json::{Value, json};

type Input = (MachineId, Arc<Snapshot>, LinkState);

fn online(machine: &str, snap: Snapshot) -> Input {
    (machine.into(), Arc::new(snap), LinkState::Online)
}

fn build(machines: &[Input], reviewed: &Reviewed, first_seen: &FirstSeen, now: Instant) -> Board {
    Board::from(machines, BoardExtras::NONE, reviewed, first_seen, now)
}

fn plain(machines: &[Input]) -> Board {
    build(
        machines,
        &Reviewed::default(),
        &FirstSeen::new(),
        Instant::now(),
    )
}

/// A snapshot with one agent per `(pane, status, seq)`.
fn agents(list: &[(&str, &str, u64)]) -> Snapshot {
    let rows: Vec<Value> = list
        .iter()
        .map(|(pane, status, seq)| json!({"pane_id": pane, "workspace_id": "w1", "tab_id": "w1:t1", "agent": "omp", "agent_status": status, "state_change_seq": seq}))
        .collect();
    Snapshot::from_result(&json!({"snapshot": {"agents": rows}})).unwrap()
}

/// Every pane on the board, project by project.
fn panes(board: &Board) -> Vec<&str> {
    board.rows().map(|r| r.pane_id.as_str()).collect()
}

/// The panes in `status`, in board order.
fn with(board: &Board, status: AgentStatus) -> Vec<&str> {
    board
        .rows()
        .filter(|r| r.status == status)
        .map(|r| r.pane_id.as_str())
        .collect()
}

fn first_row(board: &Board) -> &AgentRow {
    board.rows().next().expect("a row")
}

fn ids(rows: &[AgentRow]) -> Vec<&str> {
    rows.iter().map(|r| r.pane_id.as_str()).collect()
}

#[test]
fn counts_and_inboxes_hold_every_agent_once_whatever_the_projects() {
    let board = plain(&[online("local", snapshot_fixture("snapshot-mixed.json"))]);
    assert_eq!(ids(&board.needs_you), ["w1:p1"]);
    assert_eq!(ids(&board.to_review), ["w1:p2"]);
    assert_eq!(with(&board, AgentStatus::Working), ["w1:p3"]);
    let c = board.counts;
    assert_eq!(
        (
            c.needs_you,
            c.to_review,
            c.working,
            c.idle,
            c.offline,
            c.machines_not_connected
        ),
        (1, 1, 1, 2, 0, 0),
        "the same numbers as when the board was grouped by state"
    );
    assert_eq!(
        panes(&board).len(),
        5,
        "each agent is in exactly one project"
    );
    let chips: usize = board
        .projects
        .iter()
        .map(|p| p.needs_you + p.to_review + p.working)
        .sum();
    assert_eq!(chips, 3, "the projects' chips add up to the same attention");
}

#[test]
fn names_come_from_the_label_then_the_title_then_the_folder() {
    let board = plain(&[online("local", snapshot_fixture("snapshot-mixed.json"))]);
    let name = |pane: &str| {
        board
            .rows()
            .find(|r| r.pane_id == pane)
            .unwrap()
            .name
            .clone()
    };
    assert_eq!(
        name("w1:p1"),
        "payments review",
        "the name the person gave the pane wins over its title"
    );
    assert_eq!(
        name("w1:p2"),
        "Fix login flow",
        "the stripped title, without the spinner"
    );
    assert_eq!(
        name("w1:p3"),
        "payments-api",
        "omp's `π > folder` title is the folder"
    );
    assert_eq!(
        name("w2:p1"),
        "web",
        "an empty title falls back to the folder"
    );
    assert_eq!(
        name("w2:p2"),
        "pi",
        "`terminal` says nothing and there is no folder: the agent's kind"
    );
}

#[test]
fn naming_fallbacks_in_order() {
    let name_of = |agent: Value, pane: Value| {
        let mut a = json!({"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "t", "agent": "claude", "agent_status": "idle"});
        a.as_object_mut()
            .unwrap()
            .extend(agent.as_object().unwrap().clone());
        let mut p = json!({"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "t"});
        p.as_object_mut()
            .unwrap()
            .extend(pane.as_object().unwrap().clone());
        let snap =
            Snapshot::from_result(&json!({"snapshot": {"agents": [a], "panes": [p]}})).unwrap();
        first_row(&plain(&[online("local", snap)])).name.clone()
    };
    let table: [(Value, Value, &str); 9] = [
        (json!({}), json!({"label": "  build box  "}), "build box"),
        (json!({"name": "renamed"}), json!({}), "renamed"),
        (
            json!({"name": "renamed"}),
            json!({"label": "label"}),
            "label",
        ),
        (
            json!({"terminal_title": "⠋ Fix login"}),
            json!({"cwd": "/a/b"}),
            "Fix login",
        ),
        (
            json!({"terminal_title_stripped": "Fix login", "terminal_title": "⠋ Fix login"}),
            json!({}),
            "Fix login",
        ),
        (
            json!({"terminal_title": "terminal", "cwd": "/home/dev/api/"}),
            json!({}),
            "api",
        ),
        (
            json!({"terminal_title": "Claude", "cwd": "/home/dev/api"}),
            json!({}),
            "api",
        ),
        (json!({"cwd": "/"}), json!({}), "/"),
        (json!({}), json!({}), "claude"),
    ];
    for (agent, pane, expected) in table {
        assert_eq!(
            name_of(agent.clone(), pane.clone()),
            expected,
            "{agent} {pane}"
        );
    }
    let nameless = Snapshot::from_result(&json!({"snapshot": {"agents": [{"pane_id": "p", "workspace_id": "w", "tab_id": "t", "agent_status": "idle"}]}})).unwrap();
    assert_eq!(
        first_row(&plain(&[online("local", nameless)])).name,
        "Agent"
    );
}

#[test]
fn an_unconnected_machine_lists_its_agents_dimmed_and_never_counts_them_as_needing_you() {
    let snap = Arc::new(snapshot_fixture("snapshot-mixed.json"));
    for state in [
        LinkState::Offline,
        LinkState::Connecting,
        LinkState::Attention("host key changed".into()),
    ] {
        let board = plain(&[("lab".into(), snap.clone(), state.clone())]);
        assert_eq!(
            ids(&board.needs_you),
            ["w1:p1"],
            "{state:?}: still listed, as last known"
        );
        assert!(board.rows().all(|r| r.offline) && board.projects.iter().all(|p| p.offline));
        let c = board.counts;
        assert_eq!(
            (
                c.needs_you,
                c.to_review,
                c.working,
                c.idle,
                c.offline,
                c.machines_not_connected
            ),
            (0, 0, 0, 0, 5, 1),
            "{state:?}"
        );
        assert_eq!(board.triage().count(), 0, "nothing offline can be answered");
    }
}

#[test]
fn a_machine_that_is_switched_off_is_not_on_the_board() {
    let snap = Arc::new(snapshot_fixture("snapshot-mixed.json"));
    let board = plain(&[("lab".into(), snap, LinkState::Off)]);
    assert!(panes(&board).is_empty());
    assert_eq!(
        board.counts.machines_not_connected, 0,
        "switching a machine off is not a problem to fix"
    );
}

#[test]
fn online_rows_come_before_offline_ones_in_the_inbox_and_every_agent_is_counted_once() {
    let a = agents(&[
        ("w1:p1", "blocked", 1),
        ("w1:p2", "done", 1),
        ("w1:p3", "working", 1),
        ("w1:p4", "idle", 1),
        ("w1:p5", "unknown", 1),
    ]);
    let b = agents(&[
        ("w1:p1", "blocked", 1),
        ("w1:p2", "done", 1),
        ("w1:p3", "working", 1),
        ("w1:p4", "idle", 1),
    ]);
    let board = plain(&[
        ("a".into(), Arc::new(a), LinkState::Offline),
        online("b", b),
    ]);
    let machines: Vec<_> = board
        .needs_you
        .iter()
        .map(|r| (r.machine.as_str(), r.offline))
        .collect();
    assert_eq!(machines, [("b", false), ("a", true)]);
    let c = board.counts;
    assert_eq!(
        c.needs_you + c.to_review + c.working + c.idle + c.offline,
        9
    );
    assert_eq!(
        (c.needs_you, c.to_review, c.working, c.idle, c.offline),
        (1, 1, 1, 1, 5)
    );
}

#[test]
fn a_finished_state_is_to_review_until_that_very_episode_is_reviewed() {
    let machines = [online("local", agents(&[("w1:p1", "done", 7)]))];
    let first = plain(&machines);
    let row = first.to_review[0].clone();
    assert!(!row.reviewed);

    let mut reviewed = Reviewed::default();
    reviewed.review(row.review_key());
    let board = build(&machines, &reviewed, &FirstSeen::new(), Instant::now());
    assert!(board.to_review.is_empty());
    assert_eq!((board.counts.to_review, board.counts.idle), (0, 1));
    assert_eq!(
        (first_row(&board).status, first_row(&board).reviewed),
        (AgentStatus::Idle, true),
        "reviewed shows as idle"
    );

    // The agent finished again: a new episode, to review again.
    let again = [online("local", agents(&[("w1:p1", "done", 9)]))];
    let board = build(&again, &reviewed, &FirstSeen::new(), Instant::now());
    assert_eq!(ids(&board.to_review), ["w1:p1"]);

    // Another machine's pane with the same id is not the reviewed one.
    let other = [online("lab", agents(&[("w1:p1", "done", 7)]))];
    assert_eq!(
        build(&other, &reviewed, &FirstSeen::new(), Instant::now())
            .to_review
            .len(),
        1
    );
    assert!(reviewed.is_reviewed(&ReviewKey::new("local", "w1:p1", 7)));
}

#[test]
fn inside_a_project_what_needs_you_comes_first_then_the_newest_state() {
    let base = Instant::now();
    let mut seen = FirstSeen::new();
    let start = agents(&[("w1:p1", "idle", 1), ("w1:p2", "idle", 1)]);
    seen.observe("local", &start, base);
    // p3 starts working a minute later, p4 starts waiting two minutes later, p5 is idle from minute 3.
    let list = [
        ("w1:p1", "idle", 1),
        ("w1:p2", "idle", 1),
        ("w1:p3", "working", 1),
    ];
    seen.observe("local", &agents(&list), base + Duration::from_secs(60));
    let list = [
        ("w1:p1", "idle", 1),
        ("w1:p2", "idle", 1),
        ("w1:p3", "working", 1),
        ("w1:p4", "blocked", 1),
    ];
    seen.observe("local", &agents(&list), base + Duration::from_secs(120));
    let list = [
        ("w1:p1", "idle", 1),
        ("w1:p2", "idle", 1),
        ("w1:p3", "working", 1),
        ("w1:p4", "blocked", 1),
        ("w1:p5", "idle", 1),
    ];
    let full = agents(&list);
    seen.observe("local", &full, base + Duration::from_secs(180));
    let board = build(
        &[online("local", full)],
        &Reviewed::default(),
        &seen,
        base + Duration::from_secs(3600),
    );
    assert_eq!(board.projects.len(), 1);
    assert_eq!(
        panes(&board),
        ["w1:p4", "w1:p5", "w1:p3", "w1:p1", "w1:p2"],
        "the waiting one, then newest first, undated ones after the dated"
    );
    assert_eq!(
        board.counts.idle, 3,
        "idle is counted, never hidden by the board"
    );
}

#[test]
fn needs_you_lists_the_longest_waiting_first_and_undated_ones_after_the_dated() {
    let t0 = Instant::now();
    let mut seen = FirstSeen::new();
    seen.observe(
        "local",
        &agents(&[("w1:p1", "blocked", 1), ("w1:p2", "blocked", 1)]),
        t0,
    );
    seen.observe(
        "local",
        &agents(&[
            ("w1:p1", "blocked", 1),
            ("w1:p2", "blocked", 1),
            ("w1:p4", "blocked", 1),
        ]),
        t0 + Duration::from_secs(10),
    );
    let all = agents(&[
        ("w1:p1", "blocked", 1),
        ("w1:p2", "blocked", 1),
        ("w1:p4", "blocked", 1),
        ("w1:p3", "blocked", 1),
    ]);
    seen.observe("local", &all, t0 + Duration::from_secs(20));
    let board = build(
        &[online("local", all)],
        &Reviewed::default(),
        &seen,
        t0 + Duration::from_secs(30),
    );
    // p4 has waited 20 s, p3 10 s; p1 and p2 were already waiting when the machine was first seen.
    assert_eq!(ids(&board.needs_you), ["w1:p4", "w1:p3", "w1:p1", "w1:p2"]);
    assert_eq!(
        board.needs_you[0].age(t0 + Duration::from_secs(30)),
        Some(Duration::from_secs(20))
    );
    assert_eq!(board.needs_you[2].age(t0 + Duration::from_secs(30)), None);
}

#[test]
fn working_is_newest_first_with_unknown_times_between_recent_and_old() {
    let hour = Duration::from_secs(3600);
    let t0 = Instant::now();
    let mut seen = FirstSeen::new();
    seen.observe("local", &agents(&[("w1:p1", "working", 1)]), t0);
    seen.observe(
        "local",
        &agents(&[("w1:p1", "working", 1), ("w1:p2", "working", 1)]),
        t0 + hour,
    );
    let all = agents(&[
        ("w1:p1", "working", 1),
        ("w1:p2", "working", 1),
        ("w1:p3", "working", 1),
    ]);
    seen.observe("local", &all, t0 + 20 * hour);
    // 30 h in: p2 began 29 h ago (old), p3 10 h ago (recent), p1 has no date.
    let board = build(
        &[online("local", all)],
        &Reviewed::default(),
        &seen,
        t0 + 30 * hour,
    );
    assert_eq!(
        with(&board, AgentStatus::Working),
        ["w1:p3", "w1:p1", "w1:p2"]
    );
}

#[test]
fn ties_are_broken_by_machine_then_pane() {
    let a = agents(&[("w1:p2", "working", 1), ("w1:p1", "working", 1)]);
    let board = plain(&[online("b", a.clone()), online("a", a)]);
    let order: Vec<_> = board
        .rows()
        .map(|r| (r.machine.as_str(), r.pane_id.as_str()))
        .collect();
    assert_eq!(
        order,
        [
            ("a", "w1:p1"),
            ("a", "w1:p2"),
            ("b", "w1:p1"),
            ("b", "w1:p2")
        ]
    );
}

#[test]
fn an_unknown_status_counts_as_idle() {
    let board = plain(&[online(
        "local",
        agents(&[
            ("w1:p1", "unknown", 1),
            ("w1:p2", "idle", 1),
            ("w1:p3", "gibberish", 1),
        ]),
    )]);
    assert_eq!(board.counts.idle, 3);
    assert_eq!(panes(&board).len(), 3);
}

#[test]
fn an_episode_is_dated_when_first_seen_and_a_new_one_starts_on_a_change() {
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let since = |seen: &FirstSeen, snap: &Snapshot, now| {
        plain_with(seen, snap, now)
            .rows()
            .find(|r| r.status == AgentStatus::Working)
            .and_then(|r| r.since)
    };
    fn plain_with(seen: &FirstSeen, snap: &Snapshot, now: Instant) -> Board {
        build(
            &[online("m", snap.clone())],
            &Reviewed::default(),
            seen,
            now,
        )
    }

    let working = agents(&[("p1", "working", 5)]);
    let mut seen = FirstSeen::new();
    seen.observe("m", &working, at(0));
    assert_eq!(
        since(&seen, &working, at(1)),
        None,
        "present at the first sight: no date"
    );

    seen.observe("m", &working, at(50));
    assert_eq!(
        since(&seen, &working, at(51)),
        None,
        "seeing it again does not date it"
    );

    let blocked = agents(&[("p1", "blocked", 6)]);
    seen.observe("m", &blocked, at(60));
    let board = plain_with(&seen, &blocked, at(61));
    assert_eq!(
        board.needs_you[0].since,
        Some(at(60)),
        "a new episode is dated when it is first seen"
    );

    // The same status again with a new sequence number is a new episode (it finished and started again).
    let again = agents(&[("p1", "working", 7)]);
    seen.observe("m", &again, at(70));
    assert_eq!(since(&seen, &again, at(71)), Some(at(70)));

    // A snapshot the record has not seen yet dates nothing.
    let newer = agents(&[("p1", "working", 8)]);
    assert_eq!(since(&seen, &newer, at(72)), None);

    // An agent that leaves is forgotten: when it returns it is new, and dated.
    seen.observe("m", &agents(&[]), at(80));
    seen.observe("m", &again, at(90));
    assert_eq!(since(&seen, &again, at(91)), Some(at(90)));
}

#[test]
fn a_machine_removed_from_the_app_starts_undated_if_it_comes_back() {
    let t0 = Instant::now();
    let snap = agents(&[("p1", "working", 1)]);
    let mut seen = FirstSeen::new();
    seen.observe("m", &snap, t0);
    seen.forget_machine("m");
    seen.observe("m", &snap, t0 + Duration::from_secs(5));
    let board = build(
        &[online("m", snap)],
        &Reviewed::default(),
        &seen,
        t0 + Duration::from_secs(6),
    );
    assert_eq!(first_row(&board).since, None);
}

#[test]
fn rows_carry_what_the_screens_need_to_open_and_review_an_agent() {
    let board = plain(&[online("local", snapshot_fixture("snapshot-mixed.json"))]);
    let row = &board.to_review[0];
    assert_eq!(row.key(), "local/w1:p2");
    assert_eq!(
        (
            row.workspace_id.as_str(),
            row.tab_id.as_str(),
            row.agent.as_str()
        ),
        ("w1", "w1:t1", "claude")
    );
    assert_eq!(row.cwd.as_deref(), Some("/home/dev/auth"));
    assert_eq!(row.review_key(), ReviewKey::new("local", "w1:p2", 7));
    assert_eq!(board.needs_you[0].agent, "omp");
}

// ---- sessions ----------------------------------------------------------------------------------

fn session(machine: &str, id: &str, status: AgentStatus, since: Option<Instant>) -> SessionRow {
    SessionRow {
        machine: machine.into(),
        id: id.into(),
        agent: "omp".into(),
        name: format!("chat {id}"),
        cwd: "/work".into(),
        status,
        since,
        last_message: None,
    }
}

fn with_sessions(machines: &[Input], sessions: &[SessionRow]) -> Board {
    Board::from(
        machines,
        BoardExtras {
            sessions,
            names: &LogNames::new(),
            pins: &BTreeSet::new(),
        },
        &Reviewed::default(),
        &FirstSeen::new(),
        Instant::now(),
    )
}

#[test]
fn a_session_that_needs_you_is_counted_and_listed_with_the_terminal_agents_that_do() {
    let t0 = Instant::now();
    let machines = [online(
        "local",
        agents(&[("p1", "blocked", 1), ("p2", "working", 1)]),
    )];
    let board = with_sessions(
        &machines,
        &[
            session("local", "abc234", AgentStatus::Blocked, Some(t0)),
            session("local", "def567", AgentStatus::Working, None),
            session("local", "ghj789", AgentStatus::Idle, None),
        ],
    );
    // One number feeds every surface: the terminal agent and the session are both in it.
    assert_eq!(board.counts.needs_you, 2);
    assert_eq!(board.counts.working, 2);
    assert_eq!(board.counts.idle, 1);
    assert_eq!(board.needs_you.len(), 2);
    let chat = board
        .needs_you
        .iter()
        .find(|r| r.session)
        .expect("the session");
    assert_eq!(chat.key(), "local/session:abc234");
    assert_eq!(chat.name, "chat abc234");
    assert_eq!(chat.cwd.as_deref(), Some("/work"));
    // Dated before undated, whichever kind it is: the session has waited since t0.
    assert_eq!(board.needs_you[0].pane_id, "abc234");
}

#[test]
fn sessions_of_a_machine_that_is_not_connected_are_dimmed_and_off_ones_are_left_out() {
    let machines = [
        (
            "far".to_owned(),
            Arc::new(Snapshot::default()),
            LinkState::Offline,
        ),
        (
            "away".to_owned(),
            Arc::new(Snapshot::default()),
            LinkState::Off,
        ),
        online("local", Snapshot::default()),
    ];
    let board = with_sessions(
        &machines,
        &[
            session("far", "abc234", AgentStatus::Blocked, None),
            session("away", "def567", AgentStatus::Blocked, None),
            session("nowhere", "ghj789", AgentStatus::Blocked, None),
        ],
    );
    assert_eq!(board.counts.needs_you, 0);
    assert_eq!(board.counts.offline, 1);
    assert_eq!(board.needs_you.len(), 1);
    assert!(board.needs_you[0].offline);
}

// ---- names from session logs -------------------------------------------------------------------

fn named_by_log(title: Option<&str>, label: Option<&str>, name: &PaneName) -> String {
    let mut pane = json!({"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "cwd": "/home/dev/payments-api", "agent": "omp"});
    if let Some(t) = title {
        pane["terminal_title"] = json!(t);
    }
    if let Some(l) = label {
        pane["label"] = json!(l);
    }
    let agent = json!({"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "agent": "omp",
        "agent_status": "idle", "cwd": "/home/dev/payments-api", "terminal_title": title});
    let snap = Snapshot::from_result(&json!({"snapshot": {"panes": [pane], "agents": [agent],
        "workspaces": [{"workspace_id": "w1", "label": "payments-api"}]}}))
    .unwrap();
    let mut names = LogNames::new();
    names.insert(("local".to_owned(), "w1:p1".to_owned()), name.clone());
    let board = Board::from(
        &[online("local", snap)],
        BoardExtras {
            sessions: &[],
            names: &names,
            pins: &BTreeSet::new(),
        },
        &Reviewed::default(),
        &FirstSeen::new(),
        Instant::now(),
    );
    first_row(&board).name.clone()
}

#[test]
fn a_title_that_is_only_the_folder_gives_way_to_the_name_the_session_log_gives() {
    let name = PaneName::title("Fix the ledger rounding");
    assert_eq!(
        named_by_log(Some("payments-api"), None, &name),
        "Fix the ledger rounding"
    );
    assert_eq!(named_by_log(None, None, &name), "Fix the ledger rounding");
    // A title that says something about the work stays, and so does a name the person gave the pane.
    assert_eq!(
        named_by_log(Some("Refactor ledger"), None, &name),
        "Refactor ledger"
    );
    assert_eq!(
        named_by_log(Some("payments-api"), Some("mine"), &name),
        "mine"
    );
}

// ---- projects ----------------------------------------------------------------------------------

/// A workspace of a git repository: `(id, label, repo_key, repo_name, repo_root, checkout, linked)`.
fn repo_workspace(
    id: &str,
    label: &str,
    repo: (&str, &str, &str),
    checkout: &str,
    linked: bool,
) -> Value {
    json!({"workspace_id": id, "label": label, "worktree": {
        "repo_key": repo.0, "repo_name": repo.1, "repo_root": repo.2,
        "checkout_path": checkout, "is_linked_worktree": linked}})
}

/// One agent per `(pane, workspace, status, cwd)`.
fn agent_in(pane: &str, workspace: &str, status: &str, cwd: &str) -> Value {
    json!({"pane_id": pane, "workspace_id": workspace, "tab_id": "t", "agent": "omp",
        "agent_status": status, "state_change_seq": 1, "cwd": cwd})
}

fn world(workspaces: Vec<Value>, agents: Vec<Value>) -> Snapshot {
    Snapshot::from_result(&json!({"snapshot": {"workspaces": workspaces, "agents": agents}}))
        .unwrap()
}

const API: (&str, &str, &str) = ("git:api", "payments-api", "/home/dev/payments-api");

fn names(board: &Board) -> Vec<&str> {
    board.projects.iter().map(|p| p.name.as_str()).collect()
}

fn project<'a>(board: &'a Board, name: &str) -> &'a herdr_core::project::Project {
    board
        .projects
        .iter()
        .find(|p| p.name == name)
        .unwrap_or_else(|| panic!("no project {name}: {:?}", names(board)))
}

#[test]
fn agents_of_one_repository_share_a_project_across_its_workspaces_and_worktrees() {
    let snap = world(
        vec![
            repo_workspace("w1", "payments", API, "/home/dev/payments-api", false),
            repo_workspace("w2", "second look", API, "/home/dev/payments-api", false),
            repo_workspace("w3", "hotfix", API, "/home/dev/payments-api-hotfix", true),
            json!({"workspace_id": "w4", "label": "web"}),
        ],
        vec![
            agent_in("p1", "w1", "blocked", "/home/dev/payments-api"),
            agent_in("p2", "w2", "working", "/home/dev/payments-api"),
            agent_in("p3", "w3", "done", "/home/dev/payments-api-hotfix"),
            agent_in("p4", "w4", "idle", "/home/dev/web"),
        ],
    );
    let board = plain(&[online("local", snap)]);
    assert_eq!(names(&board), ["payments-api", "web"]);
    let api = project(&board, "payments-api");
    assert_eq!(
        api.rows.len(),
        3,
        "three workspaces, one repository, one project"
    );
    assert_eq!(api.key, "local/repo:git:api");
    let checkouts: Vec<_> = api
        .checkouts
        .iter()
        .map(|c| (c.name.as_str(), c.linked))
        .collect();
    assert_eq!(
        checkouts,
        [("payments-api", false), ("payments-api-hotfix", true)],
        "the main checkout first, then linked worktrees"
    );
    let hotfix = api.rows.iter().find(|r| r.pane_id == "p3").unwrap();
    assert_eq!(
        hotfix.checkout.as_deref(),
        Some("/home/dev/payments-api-hotfix")
    );
    assert_eq!(
        (api.needs_you, api.to_review, api.working),
        (1, 1, 1),
        "the header chips count what the rows show"
    );
    let web = project(&board, "web");
    assert!(
        web.checkouts.is_empty(),
        "a label-only project has no checkouts"
    );
    assert_eq!(web.key, "local/workspace:web");
}

#[test]
fn workspaces_without_git_info_group_by_label_and_then_by_folder() {
    let snap = world(
        vec![
            json!({"workspace_id": "w1", "label": "notes"}),
            json!({"workspace_id": "w2", "label": " notes "}),
            json!({"workspace_id": "w3", "label": ""}),
        ],
        vec![
            agent_in("p1", "w1", "idle", "/a"),
            agent_in("p2", "w2", "idle", "/b"),
            agent_in("p3", "w3", "idle", "/home/dev/scratch"),
            agent_in("p4", "gone", "idle", "/home/dev/scratch"),
            json!({"pane_id": "p5", "workspace_id": "w9", "tab_id": "t", "agent_status": "idle"}),
        ],
    );
    let board = plain(&[online("local", snap)]);
    assert_eq!(names(&board), ["No project", "notes", "scratch"]);
    assert_eq!(
        project(&board, "notes").rows.len(),
        2,
        "same label, same project"
    );
    assert_eq!(
        project(&board, "scratch").rows.len(),
        2,
        "no label: the folder"
    );
}

fn chat(id: &str, cwd: &str, status: AgentStatus) -> SessionRow {
    SessionRow {
        cwd: cwd.into(),
        ..session("local", id, status, None)
    }
}

#[test]
fn a_chat_session_joins_the_project_whose_checkout_holds_its_folder() {
    let snap = world(
        vec![
            repo_workspace("w1", "payments", API, "/home/dev/payments-api", false),
            repo_workspace(
                "w2",
                "hotfix",
                API,
                "/home/dev/payments-api/.worktrees/hotfix",
                true,
            ),
        ],
        vec![agent_in("p1", "w1", "working", "/home/dev/payments-api")],
    );
    let board = with_sessions(
        &[online("local", snap)],
        &[
            chat("aaa111", "/home/dev/payments-api/src", AgentStatus::Idle),
            chat(
                "bbb222",
                "/home/dev/payments-api/.worktrees/hotfix/src",
                AgentStatus::Blocked,
            ),
            chat("ccc333", "/home/dev/payments-api-other", AgentStatus::Idle),
            chat("ddd444", "/home/dev/blog", AgentStatus::Idle),
            chat("eee555", "/home/dev/blog", AgentStatus::Working),
        ],
    );
    assert_eq!(
        names(&board),
        ["blog", "payments-api", "payments-api-other"]
    );
    let api = project(&board, "payments-api");
    let at = |id: &str| {
        api.rows
            .iter()
            .find(|r| r.pane_id == id)
            .and_then(|r| r.checkout.clone())
    };
    assert_eq!(at("aaa111").as_deref(), Some("/home/dev/payments-api"));
    assert_eq!(
        at("bbb222").as_deref(),
        Some("/home/dev/payments-api/.worktrees/hotfix"),
        "the deepest checkout wins over the repository root that contains it"
    );
    assert!(
        api.rows.iter().all(|r| r.pane_id != "ccc333"),
        "a sibling folder with the same prefix is not inside the repository"
    );
    assert_eq!(
        project(&board, "payments-api-other").rows.len(),
        1,
        "an unmatched folder is a project of its own"
    );
    assert_eq!(
        project(&board, "blog").rows.len(),
        2,
        "one folder, one project"
    );
    assert_eq!(
        (api.needs_you, api.working),
        (1, 1),
        "chats and terminal agents are counted together"
    );
}

#[test]
fn the_same_repository_on_two_machines_is_two_projects() {
    let one = |pane: &str| {
        world(
            vec![repo_workspace(
                "w1",
                "payments",
                API,
                "/home/dev/payments-api",
                false,
            )],
            vec![agent_in(pane, "w1", "idle", "/home/dev/payments-api")],
        )
    };
    let board = plain(&[online("a", one("p1")), online("b", one("p2"))]);
    assert_eq!(board.projects.len(), 2);
    assert_eq!(
        board
            .projects
            .iter()
            .map(|p| p.machine.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_ne!(board.projects[0].key, board.projects[1].key);
    // A chat on machine b matches b's checkout, not a's.
    let chats = [SessionRow {
        machine: "b".into(),
        cwd: "/home/dev/payments-api".into(),
        ..session("b", "zzz999", AgentStatus::Idle, None)
    }];
    let board = with_sessions(&[online("a", one("p1")), online("b", one("p2"))], &chats);
    assert_eq!(board.projects[0].rows.len(), 1);
    assert_eq!(board.projects[1].rows.len(), 2);
}

#[test]
fn a_project_on_a_machine_that_is_not_connected_is_dimmed_and_counts_nothing() {
    let snap = world(
        vec![repo_workspace(
            "w1",
            "payments",
            API,
            "/home/dev/payments-api",
            false,
        )],
        vec![agent_in("p1", "w1", "blocked", "/home/dev/payments-api")],
    );
    let board = plain(&[("lab".into(), Arc::new(snap), LinkState::Offline)]);
    let p = &board.projects[0];
    assert!(p.offline && p.rows[0].offline);
    assert_eq!((p.needs_you, p.to_review, p.working), (0, 0, 0));
    assert_eq!(board.counts.needs_you, 0);
}

#[test]
fn projects_keep_their_order_when_agents_change_state_and_the_person_pins_one() {
    let snaps = |statuses: [&str; 3]| {
        world(
            vec![
                json!({"workspace_id": "w1", "label": "zeta"}),
                json!({"workspace_id": "w2", "label": "Alpha"}),
                json!({"workspace_id": "w3", "label": "mid"}),
            ],
            vec![
                agent_in("p1", "w1", statuses[0], "/z"),
                agent_in("p2", "w2", statuses[1], "/a"),
                agent_in("p3", "w3", statuses[2], "/m"),
            ],
        )
    };
    let order = |statuses| names(&plain(&[online("local", snaps(statuses))])).join(",");
    assert_eq!(order(["idle", "idle", "idle"]), "Alpha,mid,zeta");
    assert_eq!(
        order(["blocked", "idle", "working"]),
        "Alpha,mid,zeta",
        "a project that starts needing you does not jump up the list"
    );
    assert_eq!(order(["done", "blocked", "idle"]), "Alpha,mid,zeta");

    let machines = [online("local", snaps(["idle", "idle", "idle"]))];
    let pins: BTreeSet<String> = ["local/workspace:zeta".to_owned()].into();
    let board = Board::from(
        &machines,
        BoardExtras {
            pins: &pins,
            ..BoardExtras::NONE
        },
        &Reviewed::default(),
        &FirstSeen::new(),
        Instant::now(),
    );
    assert_eq!(names(&board), ["zeta", "Alpha", "mid"]);
    assert!(board.projects[0].pinned && !board.projects[1].pinned);
}

#[test]
fn an_unreadable_worktree_field_costs_the_grouping_not_the_snapshot() {
    let snap = world(
        vec![json!({"workspace_id": "w1", "label": "notes", "worktree": "nonsense"})],
        vec![agent_in("p1", "w1", "idle", "/a")],
    );
    assert_eq!(names(&plain(&[online("local", snap)])), ["notes"]);
}
