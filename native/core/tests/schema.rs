//! What the app understands of herdr's JSON, and a guard against the schema drifting away from it.

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;

use common::{fixture, snapshot_fixture};
use herdr_core::schema::{
    AgentInfo, AgentStatus, Event, PROTOCOL, PaneInfo, Request, Response, Snapshot, Subscription,
    TabInfo, WorkspaceInfo, clean_terminal_title,
};
use herdr_core::wire::ErrorKind;
use serde_json::{Value, json};

#[test]
fn reads_a_snapshot_and_leaves_out_the_row_it_cannot_read() {
    let snap = snapshot_fixture("snapshot-mixed.json");
    assert_eq!((snap.version.as_str(), snap.protocol), ("0.9.5", 22));
    assert_eq!(snap.workspaces.len(), 2);
    assert_eq!(
        snap.panes.len(),
        6,
        "the pane without an id is dropped, the other six read"
    );
    assert_eq!(snap.agents.len(), 5);
    assert_eq!(snap.focused_pane_id.as_deref(), Some("w1:p1"));
    let blocked = snap.agent("w1:p1").unwrap();
    assert_eq!(blocked.agent_status, AgentStatus::Blocked);
    assert_eq!(blocked.state_change_seq, 10);
    assert_eq!(
        blocked.agent_session.as_ref().unwrap().value,
        "/home/dev/.omp/sessions/a.jsonl"
    );
    assert_eq!(snap.agent("w1:p2").unwrap().completion_seq, Some(3));
}

#[test]
fn a_status_this_app_does_not_know_is_unknown_not_an_error() {
    let snap = snapshot_fixture("snapshot-mixed.json");
    assert_eq!(
        snap.agent("w2:p2").unwrap().agent_status,
        AgentStatus::Unknown
    );
}

#[test]
fn a_bare_snapshot_object_reads_like_the_wrapped_answer() {
    let wrapped = fixture("snapshot-mixed.json");
    let bare = wrapped["snapshot"].clone();
    assert!(
        Snapshot::from_result(&bare)
            .unwrap()
            .same_content(&Snapshot::from_result(&wrapped).unwrap())
    );
}

#[test]
fn something_that_is_not_a_snapshot_is_a_retryable_error() {
    for bad in [
        json!("nope"),
        json!({"snapshot": "nope"}),
        json!({"snapshot": {"agents": {"not": "a list"}}}),
    ] {
        let err = Snapshot::from_result(&bad).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Retryable, "{bad}");
    }
}

#[test]
fn events_are_sorted_into_what_the_link_acts_on() {
    let pane = fixture("snapshot-mixed.json")["snapshot"]["panes"][0].clone();
    match Event::parse(&json!({"event": "pane_updated", "data": {"pane": pane}})) {
        Some(Event::PaneUpdated(p)) => assert_eq!(p.pane_id, "w1:p1"),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        Event::parse(
            &json!({"event": "pane_output_changed", "data": {"pane_id": "w1:p2", "workspace_id": "w1", "revision": 7}})
        ),
        Some(Event::PaneOutputChanged {
            pane_id: "w1:p2".into(),
            revision: 7
        })
    );
    assert_eq!(
        Event::parse(
            &json!({"event": "pane_agent_status_changed", "data": {"pane_id": "w1:p2", "workspace_id": "w1", "agent_status": "blocked"}})
        ),
        Some(Event::PaneAgentStatusChanged {
            pane_id: "w1:p2".into(),
            status: AgentStatus::Blocked
        })
    );
    assert_eq!(
        Event::parse(&json!({"event": "tab_created", "data": {}})),
        Some(Event::Structural("tab_created".into()))
    );
    assert_eq!(
        Event::parse(&json!({"event": "teleported", "data": {}})),
        Some(Event::Other("teleported".into()))
    );
    assert_eq!(
        Event::parse(&json!({"id": "x", "result": {}})),
        None,
        "an answer line is not an event"
    );
}

#[test]
fn a_pane_updated_without_a_readable_pane_is_kept_as_an_unknown_event() {
    assert_eq!(
        Event::parse(&json!({"event": "pane_updated", "data": {"pane": 3}})),
        Some(Event::Other("pane_updated".into()))
    );
}

#[test]
fn answers_become_results_or_classified_errors() {
    let ok = Response::parse(br#"{"id":"1","result":{"type":"pong"}}"#).unwrap();
    assert_eq!(ok.id, "1");
    assert_eq!(ok.into_result().unwrap(), json!({"type": "pong"}));

    let err = Response::parse(
        br#"{"id":"2","error":{"code":"pane_not_found","message":"no pane w1:p9"}}"#,
    )
    .unwrap()
    .into_result()
    .unwrap_err();
    assert_eq!(
        err.kind,
        ErrorKind::Api {
            code: "pane_not_found".into()
        }
    );
    assert_eq!(err.message, "no pane w1:p9");

    for garbage in [&b"not json"[..], br#"{"id":"3"}"#, b"[]"] {
        assert_eq!(
            Response::parse(garbage).unwrap_err().kind,
            ErrorKind::Retryable
        );
    }
}

#[test]
fn requests_are_one_json_line_and_never_send_null_params() {
    let line = Request::new("7", "ping", Value::Null).to_line();
    assert!(line.ends_with(b"\n") && line.iter().filter(|b| **b == b'\n').count() == 1);
    let v: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(v, json!({"id": "7", "method": "ping", "params": {}}));
}

#[test]
fn subscriptions_use_dots_and_only_per_pane_ones_carry_a_pane() {
    assert_eq!(
        Subscription::global("pane.updated").to_value(),
        json!({"type": "pane.updated"})
    );
    assert_eq!(
        Subscription::pane("pane.agent_status_changed", "w1:p2").to_value(),
        json!({"type": "pane.agent_status_changed", "pane_id": "w1:p2"})
    );
}

#[test]
fn spinner_frames_and_agent_marks_are_cleaned_from_titles() {
    assert_eq!(
        clean_terminal_title("⠋ π > Fix login flow"),
        "Fix login flow"
    );
    assert_eq!(clean_terminal_title("  ⠙⠹ "), "");
    assert_eq!(clean_terminal_title("claude"), "claude");
}

#[test]
fn two_snapshots_differing_only_in_churn_show_the_same_thing() {
    let base = snapshot_fixture("snapshot-mixed.json");
    let mut churned = base.clone();
    for p in &mut churned.panes {
        p.revision += 50;
        p.terminal_title = p.terminal_title.as_ref().map(|t| format!("⠹ {t}"));
    }
    for a in &mut churned.agents {
        a.revision += 50;
    }
    assert!(base.same_content(&churned));

    let mut moved = base.clone();
    moved.agents[0].agent_status = AgentStatus::Idle;
    assert!(!base.same_content(&moved));
    let mut renamed = base.clone();
    renamed.panes[0].label = Some("another name".into());
    assert!(!base.same_content(&renamed));
}

fn schema() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/herdr-api.schema.json");
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}

fn fields_of<T: serde::Serialize + Default>() -> BTreeSet<String> {
    serde_json::to_value(T::default())
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

#[test]
fn every_field_the_schema_requires_exists_in_the_types_that_read_it() {
    let schema = schema();
    let defs = &schema["schemas"]["success_response"]["$defs"];
    let cases: [(&str, BTreeSet<String>); 5] = [
        ("WorkspaceInfo", fields_of::<WorkspaceInfo>()),
        ("TabInfo", fields_of::<TabInfo>()),
        ("PaneInfo", fields_of::<PaneInfo>()),
        ("AgentInfo", fields_of::<AgentInfo>()),
        ("SessionSnapshot", fields_of::<Snapshot>()),
    ];
    for (name, ours) in cases {
        let required = defs[name]["required"]
            .as_array()
            .unwrap_or_else(|| panic!("{name} has no required list"));
        for field in required {
            let field = field.as_str().unwrap();
            assert!(
                ours.contains(field),
                "{name}.{field} is required by the schema but missing from the Rust type"
            );
        }
    }
}

#[test]
fn the_status_values_and_protocol_match_the_schema() {
    let schema = schema();
    assert_eq!(
        schema["protocol"].as_u64(),
        Some(u64::from(PROTOCOL)),
        "docs/herdr-api.schema.json is for another protocol"
    );
    let values: BTreeSet<String> =
        schema["schemas"]["success_response"]["$defs"]["AgentStatus"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
    let ours: BTreeSet<String> = [
        AgentStatus::Idle,
        AgentStatus::Working,
        AgentStatus::Blocked,
        AgentStatus::Done,
        AgentStatus::Unknown,
    ]
    .iter()
    .map(|s| {
        serde_json::to_value(s)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    })
    .collect();
    assert_eq!(values, ours);
}

#[test]
fn no_event_kind_in_the_schema_is_unknown_to_the_link() {
    let schema = schema();
    let kinds = schema["schemas"]["event"]["$defs"]["EventKind"]["enum"]
        .as_array()
        .unwrap();
    let needs_data = [
        "pane_updated",
        "pane_output_changed",
        "pane_agent_status_changed",
    ];
    for kind in kinds
        .iter()
        .map(|k| k.as_str().unwrap())
        .filter(|k| !needs_data.contains(k))
    {
        let parsed = Event::parse(&json!({"event": kind, "data": {}}));
        assert!(
            matches!(parsed, Some(Event::Structural(_))),
            "{kind} is in the schema but the link does not know it: {parsed:?}"
        );
    }
}
