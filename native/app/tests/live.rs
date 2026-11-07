//! A read-only smoke test against the owner's live herdr. Ignored by default:
//! `cargo test --test live -- --ignored`.
//!
//! The engine only ever sends `ping`, `session.snapshot`, `pane.read` and `events.subscribe` here, and the
//! test prints counts, never pane text. It compares the board with a direct `session.snapshot`.

use std::sync::Arc;
use std::time::Duration;

use herdr_core::link::{LocalWire, default_socket_path};
use herdr_core::schema::{AgentStatus, Snapshot};
use herdr_core::wire::Wire;
use herdr_desktop_native::engine::{Config, Engine, LinkKind};
use serde_json::json;

#[test]
#[ignore = "talks to the live herdr (read-only)"]
fn the_board_counts_equal_the_live_snapshot_grouped_by_status() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let engine = Engine::start(Config {
        data_dir: dir.path().to_path_buf(),
        fixture: None,
        on_tick: Arc::new(|| {}),
    })
    .expect("the engine starts");

    let mut waited = 0;
    while engine.machine_statuses()[0].state != LinkKind::Online {
        assert!(
            waited < 500,
            "the local herdr did not answer: {:?}",
            engine.machine_statuses()[0]
        );
        std::thread::sleep(Duration::from_millis(20));
        waited += 1;
    }

    let direct = LocalWire::new(default_socket_path())
        .request("session.snapshot", json!({}), Duration::from_secs(10))
        .expect("session.snapshot");
    let snapshot = Snapshot::from_result(&direct).expect("a snapshot");
    let count = |statuses: &[AgentStatus]| {
        snapshot
            .agents
            .iter()
            .filter(|a| statuses.contains(&a.agent_status))
            .count()
    };

    let board = engine.board().board;
    let c = board.counts;
    println!(
        "board: needs_you={} to_review={} working={} idle={}",
        c.needs_you, c.to_review, c.working, c.idle
    );
    assert_eq!(c.needs_you, count(&[AgentStatus::Blocked]));
    assert_eq!(c.to_review, count(&[AgentStatus::Done]));
    assert_eq!(c.working, count(&[AgentStatus::Working]));
    assert_eq!(c.idle, count(&[AgentStatus::Idle, AgentStatus::Unknown]));
}
