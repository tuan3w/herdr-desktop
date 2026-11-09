//! One live connection to one machine's herdr.
//!
//! A [`MachineLink`] keeps a current [`Snapshot`] of that machine fresh and tells you when it
//! changed, reconnecting by itself and independently of every other machine. It owns two kinds of
//! thread: a worker (the state machine and every request) and, per connection, an events reader.
//!
//! The rules are those of herdr-mobile's `MachineConnection`:
//!
//! * Reconnect delays 1, 2, 4, 8, 15, 30 s; in the background profile at least 30, 60, 120, 300 s.
//!   They start over once an event stream delivered something or lived 30 s: a stream that dies at
//!   once would otherwise retry every second for ever.
//! * Events drive updates, a safety `session.snapshot` poll runs every 20 s (4 min in the
//!   background), and refreshes caused by events are throttled to one per 250 ms, trailing edge.
//!   The global `pane.updated` firehose never reads a snapshot: the event carries the whole pane,
//!   so the snapshot is patched in place, and only a status change or a structural event asks for
//!   a read (a pane event has no `state_change_seq`).
//! * A gap in wall-clock time that monotonic time does not share (the computer slept) or
//!   [`MachineLink::network_changed`] drops the connection and reconnects at once.
//! * A fatal [`WireError`] stops the retries and shows `Attention` with the reason; only
//!   [`MachineLink::reconnect_now`] leaves it.
//!
//! Time is injected ([`Clock`]); tests move a [`ManualClock`] instead of waiting.

mod clock;
mod local;
mod worker;

use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, unbounded};
use parking_lot::Mutex;
use serde_json::Value;

pub use clock::{Clock, ManualClock, SystemClock, Timer};
pub use local::{LocalWire, default_socket_path};

use crate::schema::{Snapshot, Subscription};
use crate::store::MachineId;
use crate::wire::{Fatal, Wire};

/// Where a link is in its life.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// The first connection attempt is in flight; there is no snapshot yet.
    Connecting,
    /// The snapshot is fresh and the event stream is live.
    Online,
    /// Lost; retrying with backoff. The snapshot is the last one seen, i.e. stale.
    Offline,
    /// Needs the person (changed host key, bad credentials, no bridge): no retries until
    /// [`MachineLink::reconnect_now`]. The text says what to do.
    Attention(String),
    /// The person switched this machine off.
    Off,
}

/// Something about the link worth a banner that is not a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkNote {
    /// herdr speaks a newer protocol than this app was written for; it is used as it is.
    NewerHerdr,
}

/// Whether the person is looking at the window. The background profile spaces retries and polls out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Profile {
    #[default]
    Foreground,
    Background,
}

/// What a link shows besides its snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkStatus {
    pub state: LinkState,
    /// Why the link is `Offline` or in `Attention`; `None` while connecting or online.
    pub error: Option<String>,
    /// The class of failure when it was fatal.
    pub fatal: Option<Fatal>,
    /// While `Offline`: when the next attempt starts (`reconnecting in 4 s`).
    pub retry_at: Option<Instant>,
    /// Failed attempts since the connection last worked.
    pub attempt: u32,
    pub notes: Vec<LinkNote>,
    /// herdr's version from `ping`.
    pub herdr_version: Option<String>,
}

/// "Something changed on this machine": a new snapshot or a new status. Pull the data with
/// [`MachineLink::snapshot`] and [`MachineLink::status`]; a burst of updates may be read once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub machine: MachineId,
    /// The link's change counter after the change; strictly increasing per link.
    pub revision: u64,
}

/// "A pane's content changed" (a `pane_updated` or `pane_output_changed` event), for views that
/// re-read a pane they show. Sent for every event; the consumer filters by pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub machine: MachineId,
    pub pane_id: String,
    /// herdr's content revision of the pane.
    pub revision: u64,
}

/// Every delay and threshold of a link. The defaults are the product's; tests shorten nothing
/// (they move a [`ManualClock`]) but may change one value to isolate a rule.
#[derive(Debug, Clone)]
pub struct Timing {
    /// Reconnect delays by failed attempt, the last one repeating.
    pub backoff: [Duration; 6],
    /// Reconnect delays in the background profile; the longer of this and `backoff` applies.
    pub background_backoff: [Duration; 4],
    /// Spacing of the safety-net snapshot poll.
    pub poll: Duration,
    /// The same in the background profile.
    pub background_poll: Duration,
    /// Minimum spacing of snapshot reads caused by events.
    pub refresh_gap: Duration,
    /// How long an event waits for others to join the same read.
    pub coalesce: Duration,
    /// How often a live link checks that the computer did not sleep.
    pub tick: Duration,
    /// How far wall-clock time may run ahead of monotonic time before the link presumes it slept.
    pub resume_gap: Duration,
    /// Time limit of one request.
    pub request_timeout: Duration,
    /// How long a new event subscription may take to be acknowledged.
    pub subscribe_wait: Duration,
    /// An event stream that lived this long, or delivered an event, counts as having worked.
    pub stream_proven_after: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        let s = Duration::from_secs;
        Self {
            backoff: [s(1), s(2), s(4), s(8), s(15), s(30)],
            background_backoff: [s(30), s(60), s(120), s(300)],
            poll: s(20),
            background_poll: s(240),
            refresh_gap: Duration::from_millis(250),
            coalesce: Duration::from_millis(20),
            tick: s(1),
            resume_gap: s(5),
            request_timeout: s(10),
            subscribe_wait: s(30),
            stream_proven_after: s(30),
        }
    }
}

/// What a link needs to start.
pub struct LinkConfig {
    pub machine: MachineId,
    /// How to reach herdr: [`LocalWire`] here, an ssh wire for a remote machine.
    pub wire: Arc<dyn Wire>,
    pub clock: Arc<dyn Clock>,
    pub timing: Timing,
    /// `false` starts the link `Off`; [`MachineLink::set_enabled`] switches it on later.
    pub enabled: bool,
    /// What the machine last reported on an earlier run. It is shown while the link is `Connecting` (so
    /// the state is never `Online` on it) and the first live snapshot replaces it. Ignored when the link
    /// starts `Off`.
    pub seed: Option<Snapshot>,
}

impl LinkConfig {
    /// An enabled link on the real clock with the product's timing.
    pub fn new(machine: impl Into<MachineId>, wire: Arc<dyn Wire>) -> Self {
        Self {
            machine: machine.into(),
            wire,
            clock: Arc::new(SystemClock),
            timing: Timing::default(),
            enabled: true,
            seed: None,
        }
    }
}

/// The subscriptions a link needs: every structural event plus the `pane.updated` firehose.
/// Focus events are left out: nothing here shows focus, and each would cost a snapshot read.
pub(crate) fn link_subscriptions() -> Vec<Value> {
    const KINDS: &[&str] = &[
        "workspace.created",
        "workspace.updated",
        "workspace.renamed",
        "workspace.moved",
        "workspace.reordered",
        "workspace.closed",
        "tab.created",
        "tab.closed",
        "tab.renamed",
        "tab.moved",
        "pane.created",
        "pane.closed",
        "pane.updated",
        "pane.moved",
        "pane.exited",
        "pane.agent_detected",
        "layout.updated",
    ];
    KINDS
        .iter()
        .map(|k| Subscription::global(k).to_value())
        .collect()
}

pub(crate) struct Inner {
    pub snapshot: Arc<Snapshot>,
    pub status: LinkStatus,
    pub revision: u64,
    pub last_heard: Option<Instant>,
}

pub(crate) struct Shared {
    pub machine: MachineId,
    pub inner: Mutex<Inner>,
    pub activity: Mutex<Vec<Sender<Activity>>>,
    pub wire: Arc<dyn Wire>,
    pub clock: Arc<dyn Clock>,
}

pub(crate) enum Cmd {
    Event(u64, Value),
    StreamUp(u64),
    StreamEnded(u64, crate::wire::WireError),
    Reconnect,
    NetworkChanged,
    Refresh,
    SetProfile(Profile),
    SetEnabled(bool),
    Shutdown,
}

/// A live view of one machine's herdr. Dropping it shuts it down.
pub struct MachineLink {
    shared: Arc<Shared>,
    cmd: Sender<Cmd>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl MachineLink {
    /// Starts the link's threads. Changes are announced on `updates` (one channel may serve every
    /// machine: each [`Update`] names its machine).
    pub fn start(config: LinkConfig, updates: Sender<Update>) -> Self {
        let LinkConfig {
            machine,
            wire,
            clock,
            timing,
            enabled,
            seed,
        } = config;
        let shared = Arc::new(Shared {
            machine,
            inner: Mutex::new(Inner {
                snapshot: Arc::new(seed.filter(|_| enabled).unwrap_or_default()),
                status: LinkStatus {
                    state: if enabled {
                        LinkState::Connecting
                    } else {
                        LinkState::Off
                    },
                    error: None,
                    fatal: None,
                    retry_at: None,
                    attempt: 0,
                    notes: Vec::new(),
                    herdr_version: None,
                },
                revision: 0,
                last_heard: None,
            }),
            activity: Mutex::new(Vec::new()),
            wire,
            clock,
        });
        let (cmd_tx, cmd_rx) = unbounded();
        let worker = worker::Worker::new(
            shared.clone(),
            timing,
            enabled,
            cmd_rx,
            cmd_tx.clone(),
            updates,
        );
        let handle = std::thread::Builder::new()
            .name(format!("herdr-link-{}", shared.machine))
            .spawn(move || worker.run())
            .expect("the OS can start a thread");
        Self {
            shared,
            cmd: cmd_tx,
            handle: Mutex::new(Some(handle)),
        }
    }

    /// Which machine this is.
    pub fn machine(&self) -> &MachineId {
        &self.shared.machine
    }

    /// The latest snapshot: empty before the first one (or the seed, while `Connecting`), stale while `Offline`.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.shared.inner.lock().snapshot.clone()
    }

    /// The link's state and why.
    pub fn status(&self) -> LinkStatus {
        self.shared.inner.lock().status.clone()
    }

    /// Just the state.
    pub fn state(&self) -> LinkState {
        self.shared.inner.lock().status.state.clone()
    }

    /// The change counter: the `revision` of the last [`Update`].
    pub fn revision(&self) -> u64 {
        self.shared.inner.lock().revision
    }

    /// When the machine last said anything (a snapshot or an event), on the link's clock. Events
    /// arrive many times a second and do not produce [`Update`]s, so a status line reads this on
    /// its own slow step to say `heard just now`.
    pub fn last_heard(&self) -> Option<Instant> {
        self.shared.inner.lock().last_heard
    }

    /// [`MachineLink::last_heard`] as an age.
    pub fn heard_ago(&self) -> Option<Duration> {
        let at = self.last_heard()?;
        Some(self.shared.clock.now().saturating_duration_since(at))
    }

    /// The wire this link uses, for pane reads, answers and every other request: they reuse the
    /// machine's one connection (ssh `ControlMaster`) instead of opening their own.
    pub fn wire(&self) -> Arc<dyn Wire> {
        self.shared.wire.clone()
    }

    /// A stream of pane-content events. Each call is an independent stream; drain it or drop it
    /// (an undrained one grows with the event rate, about 25 per second across 26 busy panes).
    pub fn activity(&self) -> Receiver<Activity> {
        let (tx, rx) = unbounded();
        self.shared.activity.lock().push(tx);
        rx
    }

    /// The window is hidden or shown again.
    pub fn set_profile(&self, profile: Profile) {
        let _ = self.cmd.send(Cmd::SetProfile(profile));
    }

    /// Switches the machine on or off (`Off` drops the connection and the snapshot).
    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.cmd.send(Cmd::SetEnabled(enabled));
    }

    /// Retries now: skips the backoff and leaves `Attention`.
    pub fn reconnect_now(&self) {
        let _ = self.cmd.send(Cmd::Reconnect);
    }

    /// The network interface changed or the computer resumed: the socket is presumed dead, so
    /// drop it and reconnect at once. Does not leave `Attention` (the network is not what needs fixing).
    pub fn network_changed(&self) {
        let _ = self.cmd.send(Cmd::NetworkChanged);
    }

    /// Reads the snapshot soon (throttled like event-driven reads); for after a change this app made.
    pub fn refresh(&self) {
        let _ = self.cmd.send(Cmd::Refresh);
    }

    /// Stops the link and joins its threads. Idempotent.
    pub fn shutdown(&self) {
        let _ = self.cmd.send(Cmd::Shutdown);
        if let Some(handle) = self.handle.lock().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for MachineLink {
    fn drop(&mut self) {
        self.shutdown();
    }
}
