//! The board: sections, counts, order, names, offline machines and reviewed episodes.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::snapshot_fixture;
use herdr_core::board::{AgentRow, Board, FirstSeen, IDLE_SHOWN};
use herdr_core::link::LinkState;
use herdr_core::schema::{AgentStatus, Snapshot};
use herdr_core::store::{MachineId, ReviewKey, Reviewed};
use serde_json::{Value, json};

type Input = (MachineId, Arc<Snapshot>, LinkState);

fn online(machine: &str, snap: Snapshot) -> Input {
    (machine.into(), Arc::new(snap), LinkState::Online)
}

fn build(machines: &[Input], reviewed: &Reviewed, first_seen: &FirstSeen, now: Instant) -> Board {
    Board::from(machines, reviewed, first_seen, now)
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

fn panes(rows: &Board) -> Vec<&str> {
    rows.needs_you
        .iter()
        .chain(&rows.to_review)
        .chain(&rows.working)
        .chain(&rows.idle)
        .map(|r| r.pane_id.as_str())
        .collect()
}

fn ids(rows: &[AgentRow]) -> Vec<&str> {
    rows.iter().map(|r| r.pane_id.as_str()).collect()
}

#[test]
fn agents_are_sorted_into_what_needs_you_what_to_review_what_works_and_what_rests() {
    let board = plain(&[online("local", snapshot_fixture("snapshot-mixed.json"))]);
    assert_eq!(ids(&board.needs_you), ["w1:p1"]);
    assert_eq!(ids(&board.to_review), ["w1:p2"]);
    assert_eq!(ids(&board.working), ["w1:p3"]);
    assert_eq!(
        ids(&board.idle),
        ["w2:p1", "w2:p2"],
        "idle first, then the agent whose status is unknown"
    );
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
        (1, 1, 1, 2, 0, 0)
    );
}

#[test]
fn names_come_from_the_label_then_the_title_then_the_folder() {
    let board = plain(&[online("local", snapshot_fixture("snapshot-mixed.json"))]);
    let name = |pane: &str| {
        board
            .needs_you
            .iter()
            .chain(&board.to_review)
            .chain(&board.working)
            .chain(&board.idle)
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
        plain(&[online("local", snap)]).idle[0].name.clone()
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
    assert_eq!(plain(&[online("local", nameless)]).idle[0].name, "Agent");
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
        assert!(board.needs_you[0].offline && board.working[0].offline);
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
fn online_rows_come_before_offline_ones_in_a_section_and_every_agent_is_counted_once() {
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
        (board.idle[0].status, board.idle[0].reviewed),
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
fn only_the_newest_idle_agents_show_and_the_rest_are_counted() {
    let base = Instant::now();
    let rows: Vec<(String, &str, u64)> = (1..=8).map(|i| (format!("w1:p{i}"), "idle", 1)).collect();
    let borrowed: Vec<(&str, &str, u64)> =
        rows.iter().map(|(p, s, q)| (p.as_str(), *s, *q)).collect();
    let empty = agents(&[]);
    let full = agents(&borrowed);
    let mut seen = FirstSeen::new();
    seen.observe("local", &empty, base);
    // Agents appear one minute apart, so p8 is the newest.
    let mut growing: Vec<(&str, &str, u64)> = Vec::new();
    for (i, row) in borrowed.iter().enumerate() {
        growing.push(*row);
        seen.observe(
            "local",
            &agents(&growing),
            base + Duration::from_secs(60 * (i as u64 + 1)),
        );
    }
    let board = build(
        &[online("local", full)],
        &Reviewed::default(),
        &seen,
        base + Duration::from_secs(3600),
    );
    assert_eq!(board.idle.len(), IDLE_SHOWN);
    assert_eq!(board.more_idle, 3);
    assert_eq!(board.counts.idle, 8);
    assert_eq!(
        ids(&board.idle),
        ["w1:p8", "w1:p7", "w1:p6", "w1:p5", "w1:p4"]
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
    assert_eq!(ids(&board.working), ["w1:p3", "w1:p1", "w1:p2"]);
}

#[test]
fn ties_are_broken_by_machine_then_pane() {
    let a = agents(&[("w1:p2", "working", 1), ("w1:p1", "working", 1)]);
    let board = plain(&[online("b", a.clone()), online("a", a)]);
    let order: Vec<_> = board
        .working
        .iter()
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
fn an_unknown_status_is_idle_inventory_listed_after_the_idle_agents() {
    let board = plain(&[online(
        "local",
        agents(&[
            ("w1:p1", "unknown", 1),
            ("w1:p2", "idle", 1),
            ("w1:p3", "gibberish", 1),
        ]),
    )]);
    assert_eq!(ids(&board.idle), ["w1:p2", "w1:p1", "w1:p3"]);
    assert_eq!(board.counts.idle, 3);
}

#[test]
fn an_episode_is_dated_when_first_seen_and_a_new_one_starts_on_a_change() {
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let since = |seen: &FirstSeen, snap: &Snapshot, now| {
        plain_with(seen, snap, now)
            .working
            .first()
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
    assert_eq!(board.working[0].since, None);
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
