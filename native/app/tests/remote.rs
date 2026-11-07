//! A second machine over the system `ssh`, against the owner's live herdr (read-only). Ignored by default:
//! `HERDR_DESKTOP_SSH_TEST=localhost cargo test --test remote -- --ignored --nocapture`.
//!
//! It needs key login to the destination (`ssh -o BatchMode=yes <dest> true` must work) and python3 on it:
//! the relay only forwards `ping`, `session.snapshot`, `events.subscribe` and the engine's own `pane.read`
//! previews. Nothing is mutated, and the test prints counts and states, never pane text. The only
//! processes it signals are the ssh children the machine's own link exposes by PID.

use std::collections::BTreeSet;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use herdr_desktop_native::engine::{Config, Engine, LinkKind, MachineHealth, MachineInput};

const LONG: Duration = Duration::from_secs(40);

fn destination() -> String {
    std::env::var("HERDR_DESKTOP_SSH_TEST")
        .expect("set HERDR_DESKTOP_SSH_TEST to the destination, for example localhost")
}

fn health(engine: &Engine, id: &str) -> MachineHealth {
    engine
        .machine_statuses()
        .into_iter()
        .find(|m| m.id == id)
        .expect("the machine is listed")
}

/// Polls until `done` holds; the panic says what was waited for and the last state seen.
fn wait_until(engine: &Engine, id: &str, what: &str, mut done: impl FnMut(&MachineHealth) -> bool) {
    let deadline = Instant::now() + LONG;
    loop {
        let h = health(engine, id);
        if done(&h) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}; last state {h:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The panes (with their status) one machine shows on the board.
fn agents_of(engine: &Engine, machine: &str) -> BTreeSet<(String, String)> {
    let board = engine.board().board;
    board
        .rows()
        .filter(|r| r.machine == machine)
        .map(|r| (r.pane_id.clone(), format!("{:?}", r.status)))
        .collect()
}

/// Waits until both machines list the same agents: the same number in their snapshots and the same panes
/// in the sections that need a look. herdr may change between two reads, so a difference is retried
/// until the deadline. Returns the agent count.
fn wait_same_agents(engine: &Engine, a: &str, b: &str) -> usize {
    let deadline = Instant::now() + LONG;
    loop {
        let (left, right) = (agents_of(engine, a), agents_of(engine, b));
        let (count_a, count_b) = (health(engine, a).agents, health(engine, b).agents);
        if left == right && count_a == count_b && count_a > 0 {
            return count_a;
        }
        assert!(
            Instant::now() < deadline,
            "the two machines never showed the same agents: {count_a} ({}) against {count_b} ({})",
            left.len(),
            right.len()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn kill(pid: u32) {
    let status = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .expect("kill can run");
    assert!(status.success(), "kill {pid} failed");
}

#[test]
#[ignore = "needs sshd and key login: set HERDR_DESKTOP_SSH_TEST=localhost"]
fn a_second_machine_over_ssh_shows_the_same_agents_and_survives_a_cut_connection() {
    let dest = destination();
    let dir = tempfile::tempdir().expect("a temp dir");
    let engine = Engine::start(Config {
        data_dir: dir.path().to_path_buf(),
        fixture: None,
        on_tick: Arc::new(|| {}),
    })
    .expect("the engine starts");
    let local = herdr_core::store::LOCAL_ID;
    wait_until(&engine, local, "this computer's herdr", |h| {
        h.state == LinkKind::Online
    });

    let tested = engine.test_connection(&MachineInput {
        id: None,
        name: "over ssh".to_owned(),
        dest: dest.clone(),
        port: None,
        session: None,
        enabled: true,
    });
    println!("test connection: {}", tested.message);
    assert!(tested.ok, "{}", tested.message);

    let remote = engine
        .save_machine(MachineInput {
            id: None,
            name: "over ssh".to_owned(),
            dest,
            port: None,
            session: None,
            enabled: true,
        })
        .expect("the machine is saved")
        .id;
    wait_until(&engine, &remote, "the ssh machine to come online", |h| {
        h.state == LinkKind::Online
    });
    let agents = wait_same_agents(&engine, local, &remote);
    let h = health(&engine, &remote);
    println!(
        "online over ssh: {} agents, herdr {:?}, children {:?}",
        agents,
        h.herdr_version,
        engine.ssh_children(&remote)
    );
    assert_eq!(h.agents, health(&engine, local).agents);

    // The network dies: every ssh process of this machine goes. The link must notice, say when it
    // retries, and come back by itself.
    let children = engine.ssh_children(&remote);
    assert!(
        children.len() >= 2,
        "a relay and an event stream expected: {children:?}"
    );
    for pid in &children {
        kill(*pid);
    }
    let mut saw_countdown = false;
    wait_until(&engine, &remote, "the link to notice the cut", |h| {
        saw_countdown |= h.state == LinkKind::Offline && h.retry_in.is_some();
        h.state == LinkKind::Offline
    });
    let offline = health(&engine, &remote);
    println!(
        "after the cut: {:?}, retry in {:?}, detail {:?}",
        offline.state, offline.retry_in, offline.detail
    );
    assert!(
        offline.retry_in.is_some() || saw_countdown,
        "an offline machine says when it retries"
    );
    // The local machine is untouched by a fault in the other.
    assert_eq!(health(&engine, local).state, LinkKind::Online);

    wait_until(&engine, &remote, "the link to come back", |h| {
        h.state == LinkKind::Online
    });
    wait_same_agents(&engine, local, &remote);

    // Only the event stream's ssh dies this time (a dropped TCP session): the link notices at once
    // because the stream ends, goes through the same backoff and recovers.
    let relay_and_stream = engine.ssh_children(&remote);
    let stream = *relay_and_stream.last().expect("an event stream");
    kill(stream);
    wait_until(
        &engine,
        &remote,
        "the link to notice the lost stream",
        |h| h.state == LinkKind::Offline,
    );
    wait_until(&engine, &remote, "recovery after losing the stream", |h| {
        h.state == LinkKind::Online
    });
    wait_same_agents(&engine, local, &remote);

    engine
        .remove_machine(&remote)
        .expect("the machine is removed");
}
