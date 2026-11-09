//! An agent in a pane, shown as a chat from its own log, through the engine: the pane is a scripted herdr's,
//! the log is a synthetic omp log in the test seam's home, the keeper is herdr-mobile's real script.

mod common;

use std::io::Write;

use common::{start, wait_for};
use herdr_core::session::{ItemKind, ObservedLink, SessionPhase};
use serde_json::{Value, json};

fn snapshot(log: &str, title: &str) -> Value {
    json!({"version": "0.9.5", "protocol": 22, "focused_workspace_id": "w1",
        "workspaces": [{"workspace_id": "w1", "number": 1, "label": "payments", "focused": true, "pane_count": 1, "tab_count": 1, "active_tab_id": "w1:t1", "agent_status": "idle"}],
        "tabs": [{"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "1", "focused": true, "pane_count": 1, "agent_status": "idle"}],
        "panes": [{"pane_id": "w1:p1", "terminal_id": "tw1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "focused": true, "agent_status": "idle",
            "revision": 1, "agent": "omp", "cwd": "/home/dev/payments-api", "terminal_title": title}],
        "layouts": [],
        "agents": [{"terminal_id": "tw1:p1", "agent_status": "idle", "workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "focused": true,
            "revision": 1, "agent": "omp", "cwd": "/home/dev/payments-api", "state_change_seq": 1, "terminal_title": title,
            "agent_session": {"kind": "path", "value": log}}]})
}

fn line(v: Value) -> String {
    format!("{v}\n")
}

#[test]
fn an_omp_pane_opens_as_a_chat_and_its_log_names_it_on_the_board_when_its_title_is_only_the_folder()
{
    let rig = start("empty");
    let home = rig.dir.path().join("session-home");
    let log = home.join(".omp/agent/sessions/-payments-api/2026-11-06_abc.jsonl");
    std::fs::create_dir_all(log.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &log,
        [
            line(json!({"type": "session", "id": "sess", "cwd": "/home/dev/payments-api", "title": "Round ledger totals"})),
            line(json!({"type": "message", "id": "u1", "message": {"role": "user", "content": [{"type": "text", "text": "fix the rounding"}]}})),
            line(json!({"type": "message", "id": "a1", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "Done."}]}})),
        ]
        .concat(),
    )
    .expect("log");
    let log_path = log.display().to_string();
    rig.fixture()
        .set_snapshot(snapshot(&log_path, "payments-api"));
    let pane = snapshot(&log_path, "payments-api")["panes"][0].clone();
    rig.fixture().push_event(common::pane_updated(pane, 2));

    wait_for("herdr to list the agent", || {
        rig.engine.board().rows().any(|r| r.pane_id == "w1:p1")
    });
    assert!(
        rig.engine.observed_kind("local", "w1:p1").is_some(),
        "an omp pane with a log is a chat"
    );
    assert!(rig.engine.observed_kind("local", "w9:p9").is_none());

    // The terminal's title says nothing (only the folder): the log's own name is what the board shows.
    wait_for("the log's name on the board", || {
        rig.engine
            .board()
            .rows()
            .any(|r| r.pane_id == "w1:p1" && r.name == "Round ledger totals")
    });

    let chat = rig.engine.observe("local", "w1:p1").expect("observe");
    let s = {
        let mut seen = None;
        wait_for("the chat", || {
            let s = chat.snapshot();
            let ready = s.phase == SessionPhase::Idle && s.items.len() == 2;
            seen = ready.then_some(s);
            seen.is_some()
        });
        seen.expect("snapshot")
    };
    assert_eq!(
        s.observed.as_ref().expect("observed").link,
        ObservedLink::Following
    );
    assert_eq!(s.title.as_deref(), Some("Round ledger totals"));
    let said: Vec<_> = s
        .items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(said, ["fix the rounding", "Done."]);

    // Typing into the chat sends the message to the agent in the pane with `agent.prompt` (herdr checks it is
    // not waiting for an answer, and presses Enter itself): the scripted herdr served the request.
    chat.send("now the tests").expect("sent");
    let prompts = rig.sent("agent.prompt");
    assert_eq!(
        prompts,
        [json!({"target": "w1:p1", "text": "now the tests"})]
    );
    assert!(rig.sent("pane.send_input").is_empty());

    // The agent writes its answer: the chat has it without anyone asking.
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .expect("log");
    write!(f, "{}{}", line(json!({"type": "message", "id": "u2", "message": {"role": "user", "content": [{"type": "text", "text": "now the tests"}]}})),
        line(json!({"type": "message", "id": "a2", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "Tests pass."}]}}))).expect("append");
    wait_for("the new messages", || chat.snapshot().items.len() == 4);

    rig.engine.sessions().stop_observing("local", "w1:p1");
    assert!(!chat.is_open());
}
