//! `LocalWire` against the fake herdr server, and a link running over a real socket.

mod common;

use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::time::Duration;

use common::{fixture, wait_for};
use crossbeam_channel::unbounded;
use herdr_core::link::{LinkConfig, LinkState, LocalWire, MachineLink};
use herdr_core::testing::{FakeHerdr, Script};
use herdr_core::wire::{ErrorKind, Wire};
use serde_json::{Value, json};
use tempfile::tempdir;

const PATIENCE: Duration = Duration::from_secs(5);

fn pong() -> Value {
    json!({"type": "pong", "version": "0.9.5", "protocol": 22})
}

#[test]
fn a_request_returns_herdrs_result_and_sends_its_params() {
    let dir = tempdir().unwrap();
    let fake = FakeHerdr::start(
        dir.path(),
        Script::new()
            .on("ping", pong())
            .on("pane.read", json!({"type": "pane_read"})),
    )
    .unwrap();
    let wire = LocalWire::new(fake.socket_path());
    assert_eq!(
        wire.request("ping", json!({}), PATIENCE).unwrap()["protocol"],
        22
    );
    wire.request(
        "pane.read",
        json!({"pane_id": "w1:p1", "format": "ansi"}),
        PATIENCE,
    )
    .unwrap();
    assert_eq!(
        fake.requests_of("pane.read")[0].params,
        json!({"pane_id": "w1:p1", "format": "ansi"})
    );
}

#[test]
fn herdrs_error_answer_is_an_api_error_not_a_connection_problem() {
    let dir = tempdir().unwrap();
    let fake = FakeHerdr::start(
        dir.path(),
        Script::new().on_with("pane.read", |_| {
            Err(("pane_not_found".into(), "no such pane".into()))
        }),
    )
    .unwrap();
    let err = LocalWire::new(fake.socket_path())
        .request("pane.read", json!({}), PATIENCE)
        .unwrap_err();
    assert_eq!(
        err.kind,
        ErrorKind::Api {
            code: "pane_not_found".into()
        }
    );
    assert_eq!(err.message, "no such pane");
    assert!(!err.is_fatal());
}

#[test]
fn a_missing_socket_is_retryable_because_herdr_may_be_starting() {
    let dir = tempdir().unwrap();
    let err = LocalWire::new(dir.path().join("none.sock"))
        .request("ping", json!({}), PATIENCE)
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Retryable);
    assert!(err.message.contains("none.sock"), "{}", err.message);
    assert_eq!(
        LocalWire::new(dir.path().join("none.sock"))
            .events(&[])
            .err()
            .unwrap()
            .kind,
        ErrorKind::Retryable
    );
}

#[test]
fn a_herdr_that_never_answers_times_out_as_retryable() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mute.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let held = std::thread::spawn(move || listener.accept().map(|(s, _)| s));
    let err = LocalWire::new(&path)
        .request("ping", json!({}), Duration::from_millis(100))
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Retryable);
    drop(held);
}

#[test]
fn a_herdr_that_hangs_up_without_answering_is_retryable() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rude.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::thread::spawn(move || drop(listener.accept()));
    let err = LocalWire::new(&path)
        .request("ping", json!({}), PATIENCE)
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Retryable);
}

#[test]
fn events_arrive_in_order_after_the_ack_and_a_quiet_interval_is_none() {
    let dir = tempdir().unwrap();
    let first = json!({"event": "workspace_created", "data": {"type": "workspace_created"}});
    let fake = FakeHerdr::start(dir.path(), Script::new().on_events([first.clone()])).unwrap();
    let wire = LocalWire::new(fake.socket_path());
    let mut stream = wire.events(&[json!({"type": "pane.updated"})]).unwrap();
    assert_eq!(
        fake.requests_of("events.subscribe")[0].params,
        json!({"subscriptions": [{"type": "pane.updated"}]})
    );
    assert_eq!(stream.next(PATIENCE).unwrap(), Some(first));
    assert_eq!(stream.next(Duration::from_millis(20)).unwrap(), None);
    let later = json!({"event": "pane_closed", "data": {"pane_id": "w1:p1", "workspace_id": "w1"}});
    fake.push_event(later.clone());
    assert_eq!(stream.next(PATIENCE).unwrap(), Some(later));
}

#[test]
fn a_dropped_connection_ends_the_event_stream_with_a_retryable_error() {
    let dir = tempdir().unwrap();
    let fake = FakeHerdr::start(dir.path(), Script::new()).unwrap();
    let wire = LocalWire::new(fake.socket_path());
    let mut stream = wire.events(&[]).unwrap();
    drop(fake);
    let err = stream.next(PATIENCE).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Retryable);
}

#[test]
fn a_subscription_herdr_refuses_is_an_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("odd.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let (mut s, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(s.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        s.write_all(b"{\"id\":\"1\",\"error\":{\"code\":\"bad_subscription\",\"message\":\"unknown type\"}}\n").unwrap();
    });
    let err = LocalWire::new(&path)
        .events(&[json!({"type": "nope"})])
        .err()
        .unwrap();
    assert_eq!(
        err.kind,
        ErrorKind::Api {
            code: "bad_subscription".into()
        }
    );
}

#[test]
fn a_link_over_a_real_socket_shows_the_machines_agents_and_follows_its_events() {
    let dir = tempdir().unwrap();
    let fake = FakeHerdr::start(
        dir.path(),
        Script::new()
            .on("ping", pong())
            .on("session.snapshot", fixture("snapshot-mixed.json")),
    )
    .unwrap();
    let (tx, updates) = unbounded();
    let link = MachineLink::start(
        LinkConfig::new("local", Arc::new(LocalWire::new(fake.socket_path()))),
        tx,
    );
    wait_for("online", || link.state() == LinkState::Online);
    assert_eq!(link.snapshot().agents.len(), 5);
    assert!(updates.try_iter().count() > 0);

    wait_for("the event stream", || fake.subscribers() == 1);
    let mut pane = fixture("snapshot-mixed.json")["snapshot"]["panes"][2].clone();
    pane["cwd"] = json!("/home/dev/moved");
    fake.push_event(json!({"event": "pane_updated", "data": {"pane": pane}}));
    wait_for("the patched cwd", || {
        link.snapshot()
            .agent("w1:p3")
            .and_then(|a| a.cwd.clone())
            .as_deref()
            == Some("/home/dev/moved")
    });
    assert_eq!(
        fake.requests_of("session.snapshot").len(),
        1,
        "a pane event does not read the snapshot"
    );
    link.shutdown();
}
