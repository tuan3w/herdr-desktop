//! Shared test support: fixtures, an in-memory herdr wire driven by a manual clock, and a polling wait.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, unbounded};
use herdr_core::link::{Clock, ManualClock};
use herdr_core::schema::Snapshot;
use herdr_core::wire::{EventStream, Wire, WireError};
use parking_lot::Mutex;
use serde_json::{Value, json};

/// A fixture file as JSON.
pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}

/// The `snapshot` of a `session.snapshot` fixture.
pub fn snapshot_fixture(name: &str) -> Snapshot {
    Snapshot::from_result(&fixture(name)).unwrap()
}

/// Polls `cond` until it holds; panics with `what` after ten seconds.
pub fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// How the next event stream behaves.
#[derive(Clone)]
pub enum Plan {
    /// Stays up until the test ends it.
    Open,
    /// Ends the moment it is read.
    DieAtOnce,
    /// Delivers one event, then ends.
    EventThenDie,
    /// The subscription itself fails.
    Refuse(WireError),
}

struct State {
    snapshot: Value,
    protocol: u64,
    ping_error: Option<WireError>,
    unreadable_snapshots: u32,
    snapshot_error: Option<WireError>,
    plans: VecDeque<Plan>,
    default_plan: Plan,
    snapshot_requests: Vec<Instant>,
    pings: usize,
    subscriptions: usize,
    senders: Vec<Sender<Value>>,
}

/// An in-memory herdr: answers `ping` and `session.snapshot` from what the test sets, hands out
/// event streams by plan, and records when each snapshot was read (on the manual clock).
pub struct FakeWire {
    clock: Arc<ManualClock>,
    state: Mutex<State>,
}

impl FakeWire {
    pub fn new(clock: Arc<ManualClock>, snapshot: &str) -> Arc<Self> {
        Arc::new(Self {
            clock,
            state: Mutex::new(State {
                snapshot: fixture(snapshot),
                protocol: 22,
                ping_error: None,
                unreadable_snapshots: 0,
                snapshot_error: None,
                plans: VecDeque::new(),
                default_plan: Plan::Open,
                snapshot_requests: Vec::new(),
                pings: 0,
                subscriptions: 0,
                senders: Vec::new(),
            }),
        })
    }

    pub fn set_default_plan(&self, plan: Plan) {
        self.state.lock().default_plan = plan;
    }

    pub fn queue_plan(&self, plan: Plan) {
        self.state.lock().plans.push_back(plan);
    }

    pub fn set_snapshot(&self, snapshot: Value) {
        self.state.lock().snapshot = snapshot;
    }

    /// The snapshot as the fake serves it (the fixture's, edited).
    pub fn edit_snapshot(&self, edit: impl FnOnce(&mut Value)) {
        let mut st = self.state.lock();
        let body = st.snapshot.get_mut("snapshot").unwrap();
        edit(body);
    }

    pub fn set_protocol(&self, protocol: u64) {
        self.state.lock().protocol = protocol;
    }

    pub fn fail_ping(&self, error: Option<WireError>) {
        self.state.lock().ping_error = error;
    }

    pub fn fail_snapshot(&self, error: Option<WireError>) {
        self.state.lock().snapshot_error = error;
    }

    /// The next `n` snapshot answers are not snapshots.
    pub fn garble_snapshots(&self, n: u32) {
        self.state.lock().unreadable_snapshots = n;
    }

    pub fn snapshot_requests(&self) -> Vec<Instant> {
        self.state.lock().snapshot_requests.clone()
    }

    pub fn pings(&self) -> usize {
        self.state.lock().pings
    }

    pub fn subscriptions(&self) -> usize {
        self.state.lock().subscriptions
    }

    /// Sends an event line on the newest stream.
    pub fn send_event(&self, event: Value) {
        if let Some(tx) = self.state.lock().senders.last() {
            let _ = tx.send(event);
        }
    }

    /// Ends every open stream, as a dropped connection does.
    pub fn end_streams(&self) {
        self.state.lock().senders.clear();
    }
}

impl Wire for FakeWire {
    fn request(
        &self,
        method: &str,
        _params: Value,
        _timeout: Duration,
    ) -> Result<Value, WireError> {
        let mut st = self.state.lock();
        match method {
            "ping" => {
                st.pings += 1;
                match &st.ping_error {
                    Some(e) => Err(e.clone()),
                    None => {
                        Ok(json!({"type": "pong", "version": "9.9.9", "protocol": st.protocol}))
                    }
                }
            }
            "session.snapshot" => {
                st.snapshot_requests.push(self.clock.now());
                if let Some(e) = &st.snapshot_error {
                    return Err(e.clone());
                }
                if st.unreadable_snapshots > 0 {
                    st.unreadable_snapshots -= 1;
                    return Ok(json!({"type": "session_snapshot", "snapshot": "not a snapshot"}));
                }
                Ok(st.snapshot.clone())
            }
            other => Err(WireError::api(
                "unknown_method",
                format!("no script for {other}"),
            )),
        }
    }

    fn events(&self, _subscriptions: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
        let mut st = self.state.lock();
        st.subscriptions += 1;
        let plan = st
            .plans
            .pop_front()
            .unwrap_or_else(|| st.default_plan.clone());
        let (tx, rx) = unbounded();
        match plan {
            Plan::Refuse(e) => Err(e),
            Plan::DieAtOnce => Ok(Box::new(FakeStream {
                rx,
                first: None,
                die_at_once: true,
            })),
            Plan::EventThenDie => Ok(Box::new(FakeStream {
                rx,
                first: Some(
                    json!({"event": "workspace_created", "data": {"type": "workspace_created"}}),
                ),
                die_at_once: true,
            })),
            Plan::Open => {
                st.senders.push(tx);
                Ok(Box::new(FakeStream {
                    rx,
                    first: None,
                    die_at_once: false,
                }))
            }
        }
    }
}

struct FakeStream {
    rx: Receiver<Value>,
    first: Option<Value>,
    die_at_once: bool,
}

impl EventStream for FakeStream {
    fn next(&mut self, timeout: Duration) -> Result<Option<Value>, WireError> {
        if let Some(v) = self.first.take() {
            return Ok(Some(v));
        }
        if self.die_at_once {
            return Err(WireError::retryable("connection closed"));
        }
        match self.rx.recv_timeout(timeout) {
            Ok(v) => Ok(Some(v)),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => Ok(None),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                Err(WireError::retryable("connection closed"))
            }
        }
    }
}
