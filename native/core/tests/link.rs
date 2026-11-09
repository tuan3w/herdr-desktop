//! `MachineLink` against an in-memory herdr on a manual clock: no test waits for a real backoff.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::{FakeWire, Plan, fixture, wait_for};
use crossbeam_channel::{Receiver, bounded, unbounded};
use herdr_core::link::{
    Activity, Clock, LinkConfig, LinkNote, LinkState, MachineLink, ManualClock, Profile, Timing,
    Update,
};
use herdr_core::schema::{AgentStatus, Snapshot};
use herdr_core::wire::{EventStream, Fatal, Wire, WireError};
use serde_json::{Value, json};

const SECOND: Duration = Duration::from_secs(1);

struct Rig {
    clock: Arc<ManualClock>,
    wire: Arc<FakeWire>,
    link: MachineLink,
    updates: Receiver<Update>,
    activity: Receiver<Activity>,
    sentinels: u32,
}

fn rig() -> Rig {
    rig_with(true, |_| {})
}

fn rig_with(enabled: bool, prepare: impl FnOnce(&FakeWire)) -> Rig {
    let clock = Arc::new(ManualClock::new());
    let wire = FakeWire::new(clock.clone(), "snapshot-mixed.json");
    prepare(&wire);
    let (tx, updates) = unbounded();
    let link = MachineLink::start(
        LinkConfig {
            machine: "box".into(),
            wire: wire.clone(),
            clock: clock.clone(),
            timing: Timing::default(),
            enabled,
            seed: None,
        },
        tx,
    );
    let activity = link.activity();
    Rig {
        clock,
        wire,
        link,
        updates,
        activity,
        sentinels: 0,
    }
}

impl Rig {
    fn online(&self) {
        wait_for("the link to be online", || {
            self.link.state() == LinkState::Online
        });
    }

    /// Sends an event nothing acts on but the activity feed and waits until the link has seen it:
    /// everything sent (and every timer fired) before it has been handled when this returns.
    /// Returns the pane ids of the activity seen on the way.
    fn barrier(&mut self) -> Vec<String> {
        self.sentinels += 1;
        let id = format!("sentinel-{}", self.sentinels);
        self.wire.send_event(json!({"event": "pane_output_changed", "data": {"pane_id": id, "workspace_id": "w1", "revision": 1}}));
        let mut seen = Vec::new();
        loop {
            let a = self
                .activity
                .recv_timeout(Duration::from_secs(10))
                .expect("the link stopped reporting activity");
            if a.pane_id == id {
                return seen;
            }
            seen.push(a.pane_id);
        }
    }

    /// How long the link will sleep before its next attempt; waits until it sleeps.
    fn retry_delay(&self) -> Duration {
        wait_for("the link to sleep before retrying", || {
            let s = self.link.status();
            s.state == LinkState::Offline && s.retry_at.is_some_and(|t| t > self.clock.now())
        });
        self.link.status().retry_at.unwrap() - self.clock.now()
    }

    /// Reads the retry delay, then lets it pass.
    fn sleep_through(&self) -> Duration {
        let delay = self.retry_delay();
        self.clock
            .advance_to_next_timer(Duration::from_secs(10))
            .expect("no timer was waiting");
        delay
    }

    fn drain_updates(&self) -> Vec<Update> {
        self.updates.try_iter().collect()
    }
}

fn pane_updated(pane_id: &str, edit: impl FnOnce(&mut Value)) -> Value {
    let fx = fixture("snapshot-mixed.json");
    let mut pane = fx["snapshot"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["pane_id"] == pane_id)
        .unwrap()
        .clone();
    edit(&mut pane);
    json!({"event": "pane_updated", "data": {"pane": pane}})
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[test]
fn comes_online_with_the_machines_snapshot_and_announces_it() {
    let r = rig();
    r.online();
    let snap = r.link.snapshot();
    assert_eq!(snap.agents.len(), 5);
    assert_eq!(r.link.status().herdr_version.as_deref(), Some("9.9.9"));
    let updates = r.drain_updates();
    assert!(updates.iter().all(|u| u.machine == "box"));
    assert!(
        updates.windows(2).all(|w| w[0].revision < w[1].revision),
        "revisions strictly increase"
    );
    assert_eq!(updates.last().unwrap().revision, r.link.revision());
    assert!(snap.revision > 0 && snap.revision <= r.link.revision());
}

#[test]
fn reconnect_delays_double_while_streams_keep_dying() {
    let r = rig_with(true, |w| w.set_default_plan(Plan::DieAtOnce));
    let delays: Vec<_> = (0..7).map(|_| r.sleep_through()).collect();
    assert_eq!(delays, [1, 2, 4, 8, 15, 30, 30].map(secs));
}

#[test]
fn background_reconnect_delays_are_longer() {
    let r = rig();
    r.online();
    r.link.set_profile(Profile::Background);
    r.wire.set_default_plan(Plan::DieAtOnce);
    r.wire.end_streams();
    let delays: Vec<_> = (0..5).map(|_| r.sleep_through()).collect();
    assert_eq!(delays, [30, 60, 120, 300, 300].map(secs));
}

#[test]
fn a_stream_that_delivered_an_event_counts_as_having_worked() {
    let r = rig_with(true, |w| {
        w.queue_plan(Plan::DieAtOnce);
        w.queue_plan(Plan::DieAtOnce);
        w.queue_plan(Plan::EventThenDie);
        w.set_default_plan(Plan::DieAtOnce);
    });
    let delays: Vec<_> = (0..4).map(|_| r.sleep_through()).collect();
    assert_eq!(delays, [1, 2, 1, 2].map(secs));
}

#[test]
fn a_stream_that_stayed_up_counts_as_having_worked() {
    let r = rig_with(true, |w| w.queue_plan(Plan::DieAtOnce));
    assert_eq!(r.sleep_through(), SECOND);
    r.online();
    r.clock.advance(secs(31));
    r.wire.end_streams();
    let after_long_stream = r.retry_delay();
    r.wire.set_default_plan(Plan::DieAtOnce);
    r.clock.advance_to_next_timer(secs(10)).unwrap();
    let after_short_stream = r.sleep_through();
    assert_eq!((after_long_stream, after_short_stream), (SECOND, secs(2)));
}

#[test]
fn an_unreadable_snapshot_is_a_failed_attempt_that_is_retried() {
    let r = rig_with(true, |w| w.garble_snapshots(2));
    assert_eq!(r.sleep_through(), SECOND);
    assert!(r.link.status().error.is_some(), "the person is told why");
    assert_eq!(r.sleep_through(), secs(2));
    r.online();
    assert_eq!(r.link.status().error, None);
}

#[test]
fn the_last_snapshot_stays_while_offline_and_reconnecting_brings_it_back_fresh() {
    let r = rig();
    r.online();
    r.wire
        .fail_ping(Some(WireError::retryable("no route to host")));
    r.wire.end_streams();
    r.retry_delay();
    assert_eq!(r.link.snapshot().agents.len(), 5, "stale, but still shown");
    r.clock.advance_to_next_timer(secs(10)).unwrap();
    wait_for("the failed attempt to be reported", || {
        r.link.status().error.as_deref() == Some("no route to host")
    });
    assert_eq!(r.link.state(), LinkState::Offline);
    assert_eq!(r.link.snapshot().agents.len(), 5);
    r.retry_delay();
    r.wire.fail_ping(None);
    r.clock.advance_to_next_timer(secs(10)).unwrap();
    r.online();
    assert_eq!(r.link.status().retry_at, None);
}

#[test]
fn a_fatal_error_stops_the_retries_until_the_person_retries() {
    let r = rig_with(true, |w| {
        w.fail_ping(Some(WireError::fatal(
            Fatal::HostKeyChanged,
            "The host key of box changed",
        )))
    });
    wait_for("attention", || {
        matches!(r.link.state(), LinkState::Attention(_))
    });
    let status = r.link.status();
    assert_eq!(
        status.state,
        LinkState::Attention("The host key of box changed".into())
    );
    assert_eq!(status.fatal, Some(Fatal::HostKeyChanged));

    // Neither time nor the network moving is what needs fixing.
    r.clock.advance(secs(3600));
    r.link.network_changed();
    r.wire.fail_ping(None);
    r.link.reconnect_now();
    r.online();
    assert_eq!(
        r.wire.pings(),
        2,
        "no attempt was made between the failure and the retry"
    );
}

#[test]
fn a_fatal_subscription_error_asks_for_attention() {
    let r = rig_with(true, |w| {
        w.queue_plan(Plan::Refuse(WireError::fatal(
            Fatal::AuthFailed,
            "Permission denied",
        )))
    });
    wait_for("attention", || {
        matches!(r.link.state(), LinkState::Attention(_))
    });
    assert_eq!(r.link.status().fatal, Some(Fatal::AuthFailed));
}

#[test]
fn an_api_error_from_herdr_is_retried_like_any_failure() {
    let r = rig_with(true, |w| {
        w.fail_snapshot(Some(WireError::api("internal", "busy")))
    });
    assert_eq!(r.retry_delay(), SECOND);
    assert_eq!(r.link.status().error.as_deref(), Some("busy"));
    r.wire.fail_snapshot(None);
    r.clock.advance_to_next_timer(secs(10)).unwrap();
    r.online();
}

#[test]
fn the_snapshot_is_read_again_every_20_seconds() {
    let r = rig();
    r.online();
    r.clock.advance(secs(20));
    wait_for("the poll", || r.wire.snapshot_requests().len() == 2);
    let at = r.wire.snapshot_requests();
    assert_eq!(at[1] - at[0], secs(20));
}

#[test]
fn in_the_background_the_poll_is_every_four_minutes() {
    let mut r = rig();
    r.online();
    r.link.set_profile(Profile::Background);
    r.barrier();
    r.clock.advance(secs(20));
    r.barrier();
    assert_eq!(
        r.wire.snapshot_requests().len(),
        1,
        "nobody is looking: no 20 s poll"
    );
    r.clock.advance(secs(220));
    wait_for("the slow poll", || r.wire.snapshot_requests().len() == 2);
    let at = r.wire.snapshot_requests();
    assert_eq!(at[1] - at[0], secs(240));
}

#[test]
fn a_burst_of_structural_events_costs_one_snapshot_read_on_the_trailing_edge() {
    let mut r = rig();
    r.online();
    r.wire.edit_snapshot(|s| {
        s["workspaces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"workspace_id": "w3", "label": "new"}));
    });
    for _ in 0..50 {
        r.wire.send_event(
            json!({"event": "workspace_created", "data": {"type": "workspace_created"}}),
        );
    }
    r.barrier();
    assert_eq!(
        r.wire.snapshot_requests().len(),
        1,
        "nothing is read before the throttle allows"
    );
    r.clock.advance(Duration::from_millis(250));
    wait_for("the throttled read", || {
        r.wire.snapshot_requests().len() == 2
    });
    wait_for("the new workspace", || {
        r.link.snapshot().workspaces.len() == 3
    });
    r.clock.advance(secs(20));
    wait_for("the next poll", || r.wire.snapshot_requests().len() == 3);
    let at = r.wire.snapshot_requests();
    assert_eq!(at[1] - at[0], Duration::from_millis(250));
    assert_eq!(at[2] - at[1], secs(20), "the burst caused exactly one read");
}

#[test]
fn the_pane_updated_firehose_reads_nothing_and_announces_nothing() {
    let mut r = rig();
    r.online();
    r.drain_updates();
    let frames = ["⠋", "⠙", "⠹", "⠸"];
    for i in 0..100u64 {
        r.wire.send_event(pane_updated("w1:p3", |p| {
            p["revision"] = json!(100 + i);
            p["terminal_title"] = json!(format!("{} π > payments-api", frames[i as usize % 4]));
        }));
    }
    let seen = r.barrier();
    assert_eq!(
        seen.iter().filter(|id| *id == "w1:p3").count(),
        100,
        "every event is reported as pane activity"
    );
    r.clock.advance(Duration::from_millis(300));
    r.barrier();
    assert_eq!(r.wire.snapshot_requests().len(), 1);
    assert!(
        r.drain_updates().is_empty(),
        "spinner and revision churn is not news"
    );
}

#[test]
fn a_pane_updated_that_changes_what_is_shown_patches_the_snapshot_without_reading_it() {
    let mut r = rig();
    r.online();
    r.drain_updates();
    r.wire.send_event(pane_updated("w1:p3", |p| {
        p["cwd"] = json!("/home/dev/elsewhere")
    }));
    r.barrier();
    let snap = r.link.snapshot();
    assert_eq!(
        snap.agent("w1:p3").unwrap().cwd.as_deref(),
        Some("/home/dev/elsewhere")
    );
    assert_eq!(
        snap.pane("w1:p3").unwrap().cwd.as_deref(),
        Some("/home/dev/elsewhere")
    );
    let updates = r.drain_updates();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].revision, snap.revision);
    r.clock.advance(Duration::from_millis(300));
    r.barrier();
    assert_eq!(r.wire.snapshot_requests().len(), 1);
}

#[test]
fn a_status_change_in_a_pane_event_reads_the_snapshot_because_only_it_has_the_sequence() {
    let mut r = rig();
    r.online();
    r.wire.edit_snapshot(|s| {
        s["agents"][2]["agent_status"] = json!("blocked");
        s["agents"][2]["state_change_seq"] = json!(4);
        s["panes"][2]["agent_status"] = json!("blocked");
    });
    r.wire.send_event(pane_updated("w1:p3", |p| {
        p["agent_status"] = json!("blocked")
    }));
    r.barrier();
    assert_eq!(
        r.link.snapshot().agent("w1:p3").unwrap().agent_status,
        AgentStatus::Working,
        "not guessed from the event"
    );
    r.clock.advance(Duration::from_millis(250));
    wait_for("the status read", || r.wire.snapshot_requests().len() == 2);
    wait_for("the new status", || {
        let s = r.link.snapshot();
        let a = s.agent("w1:p3").unwrap();
        a.agent_status == AgentStatus::Blocked && a.state_change_seq == 4
    });
}

#[test]
fn pane_events_for_an_unknown_pane_read_the_snapshot() {
    let mut r = rig();
    r.online();
    r.wire.send_event(json!({"event": "pane_updated", "data": {"pane": {
        "pane_id": "w9:p1", "workspace_id": "w9", "tab_id": "w9:t1", "terminal_id": "t-9", "agent_status": "idle", "revision": 1
    }}}));
    r.barrier();
    r.clock.advance(Duration::from_millis(250));
    wait_for("the read", || r.wire.snapshot_requests().len() == 2);
}

#[test]
fn heard_ago_grows_in_silence_and_resets_with_an_event() {
    let r = rig();
    r.online();
    r.clock.advance(secs(5));
    assert_eq!(r.link.heard_ago(), Some(secs(5)));
    r.wire.send_event(json!({"event": "pane_output_changed", "data": {"pane_id": "x", "workspace_id": "w1", "revision": 2}}));
    wait_for("heard just now", || {
        r.link.heard_ago() == Some(Duration::ZERO)
    });
}

#[test]
fn the_computer_waking_from_sleep_reconnects_at_once() {
    let r = rig();
    r.online();
    // Monotonic time stands still while the computer sleeps; wall-clock time does not.
    r.clock.suspend(secs(10));
    r.clock.advance(SECOND);
    wait_for("a second subscription", || r.wire.subscriptions() == 2);
    r.online();
    wait_for("a second snapshot", || {
        r.wire.snapshot_requests().len() == 2
    });
    assert_eq!(r.link.status().retry_at, None, "no backoff was involved");
}

#[test]
fn a_network_change_reconnects_at_once() {
    let r = rig();
    r.online();
    r.link.network_changed();
    wait_for("a second subscription", || r.wire.subscriptions() == 2);
    wait_for("a second snapshot", || {
        r.wire.snapshot_requests().len() == 2
    });
    r.online();
}

#[test]
fn reconnect_now_skips_the_backoff() {
    let r = rig_with(true, |w| w.queue_plan(Plan::DieAtOnce));
    r.retry_delay();
    r.link.reconnect_now();
    wait_for("a second subscription", || r.wire.subscriptions() == 2);
    r.online();
}

#[test]
fn a_newer_herdr_is_a_note_not_a_failure() {
    let r = rig_with(true, |w| w.set_protocol(23));
    r.online();
    assert_eq!(r.link.status().notes, vec![LinkNote::NewerHerdr]);
}

#[test]
fn a_switched_off_machine_does_nothing_until_switched_on() {
    let r = rig_with(false, |_| {});
    assert_eq!(r.link.state(), LinkState::Off);
    r.link.set_enabled(true);
    r.online();
    assert_eq!(r.link.snapshot().agents.len(), 5);
    r.link.set_enabled(false);
    wait_for("off", || r.link.state() == LinkState::Off);
    assert!(
        r.link.snapshot().agents.is_empty(),
        "an off machine shows nothing"
    );
    r.link.set_enabled(true);
    r.online();
    assert_eq!(r.link.snapshot().agents.len(), 5);
}

#[test]
fn shutdown_returns_even_while_a_stream_is_open() {
    let r = rig();
    r.online();
    let link = Arc::new(r.link);
    let done = Arc::new(AtomicBool::new(false));
    let (l, d) = (link.clone(), done.clone());
    std::thread::spawn(move || {
        l.shutdown();
        d.store(true, Ordering::SeqCst);
    });
    wait_for("shutdown to finish", || done.load(Ordering::SeqCst));
}

/// A herdr that answers nothing until the gate is opened (its sender dropped or sent to).
struct Gated {
    inner: Arc<FakeWire>,
    gate: Receiver<()>,
}

impl Wire for Gated {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, WireError> {
        let _ = self.gate.recv();
        self.inner.request(method, params, timeout)
    }

    fn events(&self, subscriptions: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
        self.inner.events(subscriptions)
    }
}

/// What a machine showed on an earlier run: the mixed fixture, with fewer agents than the live one has.
fn earlier_snapshot() -> Snapshot {
    let mut seed = common::snapshot_fixture("snapshot-mixed.json");
    seed.agents.truncate(2);
    seed.panes.truncate(2);
    seed
}

#[test]
fn a_seeded_link_shows_the_last_snapshot_while_connecting_and_the_live_one_replaces_it() {
    let clock = Arc::new(ManualClock::new());
    let wire = FakeWire::new(clock.clone(), "snapshot-mixed.json");
    let (open, gate) = bounded::<()>(0);
    let (tx, _updates) = unbounded();
    let link = MachineLink::start(
        LinkConfig {
            machine: "box".into(),
            wire: Arc::new(Gated { inner: wire, gate }),
            clock: clock.clone(),
            timing: Timing::default(),
            enabled: true,
            seed: Some(earlier_snapshot()),
        },
        tx,
    );
    // Declared after the link so a failing assertion drops (and opens) the gate before the link joins its thread.
    let mut open = Some(open);
    assert_eq!(link.state(), LinkState::Connecting);
    assert_eq!(link.snapshot().agents.len(), 2);
    assert_eq!(link.snapshot().panes.len(), 2);
    assert_eq!(link.revision(), 0, "nothing has been published yet");

    drop(open.take());
    wait_for("the link to be online", || {
        link.state() == LinkState::Online
    });
    assert_eq!(link.snapshot().agents.len(), 5);
}

#[test]
fn a_seed_is_ignored_by_a_machine_that_starts_switched_off() {
    let clock = Arc::new(ManualClock::new());
    let wire = FakeWire::new(clock.clone(), "snapshot-mixed.json");
    let (tx, _updates) = unbounded();
    let link = MachineLink::start(
        LinkConfig {
            machine: "box".into(),
            wire,
            clock,
            timing: Timing::default(),
            enabled: false,
            seed: Some(earlier_snapshot()),
        },
        tx,
    );
    assert_eq!(link.state(), LinkState::Off);
    assert!(link.snapshot().agents.is_empty());
}
