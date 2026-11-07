//! Notifications through the engine, against a scripted herdr. The engine records them instead of
//! showing them (`Engine::recorded_notifications`), so nothing here reaches the owner's desktop; the
//! real delivery is tested against a mock notification service in `notify_dbus.rs`.

mod common;

use common::{Rig, start, wait_for};
use herdr_desktop_native::notify::{RecordedNotification, Target};
use serde_json::{Value, json};

/// The scripted herdr's snapshot with these panes blocked on a new question (a new episode each).
fn blocked(rig: &Rig, panes: &[&str]) -> Value {
    let mut snapshot = rig.fixture().snapshot();
    for list in ["panes", "agents"] {
        for item in snapshot[list].as_array_mut().expect("a list") {
            if panes.contains(&item["pane_id"].as_str().unwrap_or("")) {
                item["agent_status"] = json!("blocked");
                item["state_change_seq"] = json!(100);
            }
        }
    }
    snapshot
}

/// Shows a question on `pane`: another command, so its digest differs from `w1:p1`'s.
fn ask(rig: &Rig, pane: &str, command: &str) {
    let rows: Vec<String> = rig
        .fixture()
        .screen("w1:p1")
        .iter()
        .map(|r| r.replace("touch /tmp/hm-capture-claude/x.txt", command))
        .collect();
    rig.fixture().set_screen(pane, rows);
}

/// Makes `panes` ask `command` and tells the app (a structural event makes the link read the snapshot).
fn become_blocked(rig: &Rig, panes: &[&str], command: &str) {
    for pane in panes {
        ask(rig, pane, command);
    }
    rig.fixture().set_snapshot(blocked(rig, panes));
    rig.fixture()
        .push_event(json!({"event": "layout_updated", "data": {}}));
}

fn shown(rig: &Rig) -> Vec<RecordedNotification> {
    rig.engine
        .recorded_notifications()
        .expect("a scripted herdr records")
        .shown()
}

fn press(rig: &Rig, id: u64, action: &str) {
    rig.engine
        .recorded_notifications()
        .expect("a scripted herdr records")
        .press(id, action);
}

fn switch_on(rig: &Rig) {
    rig.engine
        .set_setting("notify.needsYou", json!(true))
        .expect("the setting is stored");
}

/// A rig with notifications on and the window away, with what was blocked at that moment taken as seen.
fn away() -> Rig {
    let rig = start("mixed");
    switch_on(&rig);
    rig.engine.set_background(true);
    rig
}

fn agent_target(pane: &str) -> Target {
    Target::Agent {
        machine: "local".to_owned(),
        pane: pane.to_owned(),
    }
}

#[test]
fn a_new_question_is_announced_with_its_command_and_answered_from_its_button() {
    let rig = away();
    become_blocked(&rig, &["w1:p4"], "echo hello");
    wait_for("the announcement", || !shown(&rig).is_empty());

    let all = shown(&rig);
    assert_eq!(
        all.len(),
        1,
        "what was blocked when the window left is not news: {all:?}"
    );
    let n = &all[0];
    assert!(n.title.ends_with(" needs you"), "{}", n.title);
    assert!(n.body.contains("Do you want to proceed?"), "{}", n.body);
    assert!(n.body.contains("echo hello"), "the command is in the text");
    assert_eq!(n.target, agent_target("w1:p4"));
    assert!(n.buttons.len() <= 2);
    assert_eq!(n.buttons[0], "1. Yes");
    assert!(
        n.buttons.iter().all(|b| !b.contains("always")),
        "a standing grant is never one tap: {:?}",
        n.buttons
    );

    press(&rig, n.id, "answer:0");
    wait_for("the answer to be sent", || {
        !rig.sent("pane.send_keys").is_empty()
    });
    assert_eq!(
        rig.sent("pane.send_keys"),
        [json!({"pane_id": "w1:p4", "keys": ["1", "enter"]})]
    );
    wait_for("the notification to go", || !shown(&rig)[0].open);
}

#[test]
fn an_answer_for_a_question_that_changed_sends_nothing_and_says_so() {
    let rig = away();
    become_blocked(&rig, &["w1:p4"], "echo hello");
    wait_for("the announcement", || !shown(&rig).is_empty());
    let id = shown(&rig)[0].id;

    // Between the notification and the press the agent asks about something else.
    ask(&rig, "w1:p4", "rm -rf build");
    press(&rig, id, "answer:0");
    wait_for("the refusal", || shown(&rig)[0].title == "Answer not sent");

    let n = &shown(&rig)[0];
    assert_eq!(n.id, id, "it replaces the question");
    assert!(n.body.contains("question changed"), "{}", n.body);
    assert!(n.buttons.is_empty());
    assert!(rig.sent("pane.send_keys").is_empty(), "nothing was sent");
    assert_eq!(
        n.target,
        agent_target("w1:p4"),
        "its click still opens the agent"
    );
}

#[test]
fn a_click_reaches_whoever_listens_and_the_window_coming_back_withdraws_everything() {
    let rig = away();
    let (_id, clicks) = rig.engine.notifier().subscribe();
    become_blocked(&rig, &["w1:p4"], "echo hello");
    wait_for("the announcement", || !shown(&rig).is_empty());
    let id = shown(&rig)[0].id;

    press(&rig, id, "default");
    let target = clicks.recv_blocking().expect("the click is handed on");
    assert_eq!(target, agent_target("w1:p4"));

    rig.engine.set_background(false);
    wait_for("everything to be withdrawn", || {
        shown(&rig).iter().all(|n| !n.open)
    });
}

#[test]
fn what_became_blocked_while_the_window_was_in_front_or_the_switch_was_off_is_not_announced() {
    let rig = start("mixed");
    // Switch off, window away: not announced.
    rig.engine.set_background(true);
    become_blocked(&rig, &["w1:p4"], "echo one");
    wait_for("the board to show it", || {
        rig.engine
            .board()
            .board
            .needs_you
            .iter()
            .any(|r| r.pane_id == "w1:p4")
    });
    // Switched on while away: what is blocked now is taken as seen.
    switch_on(&rig);
    // A newcomer is announced, so everything before it had its chance to be.
    become_blocked(&rig, &["w1:p4", "w1:p5"], "echo two");
    wait_for("the newcomer", || !shown(&rig).is_empty());
    let titles: Vec<_> = shown(&rig).iter().map(|n| n.target.clone()).collect();
    assert_eq!(titles, [agent_target("w1:p5")]);
}

#[test]
fn a_burst_of_five_gives_three_notifications_and_one_summary() {
    let rig = away();
    let five = ["w1:p3", "w1:p4", "w1:p5", "w2:p1", "w2:p2"];
    become_blocked(&rig, &five, "echo hello");
    wait_for("three agents and the summary", || {
        let all = shown(&rig);
        all.len() == 4 && all.iter().any(|n| n.title == "5 agents need you")
    });
    let all = shown(&rig);
    assert_eq!(all.iter().filter(|n| n.target != Target::Board).count(), 3);
    assert!(all.iter().all(|n| n.open));

    // Back in front: all four go.
    rig.engine.set_background(false);
    wait_for("everything to be withdrawn", || {
        shown(&rig).iter().all(|n| !n.open)
    });
}

#[test]
fn a_notification_goes_when_its_agent_stops_needing_you() {
    let rig = away();
    become_blocked(&rig, &["w1:p4"], "echo hello");
    wait_for("the announcement", || !shown(&rig).is_empty());

    let mut working = rig.fixture().snapshot();
    for list in ["panes", "agents"] {
        for item in working[list].as_array_mut().expect("a list") {
            if item["pane_id"] == "w1:p4" {
                item["agent_status"] = json!("working");
                item["state_change_seq"] = json!(101);
            }
        }
    }
    rig.fixture().set_snapshot(working);
    rig.fixture()
        .push_event(json!({"event": "layout_updated", "data": {}}));
    wait_for("the withdrawal", || !shown(&rig)[0].open);
}
