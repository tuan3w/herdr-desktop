//! Watched panes: who wants a pane's screen, when it is read again, and the threads that read it.
//!
//! A view that shows a pane (`PaneScreen`, the pane tab's header via `Herdr.watchPane`) holds a
//! [`WatchHandle`]. While at least one handle exists for a pane the scheduler re-reads it when herdr says
//! its content moved, at most once per [`READ_GAP`]; a pane nobody watches is never read. Reads run on the
//! pool, one at a time per pane, so a burst of events costs one read, not one per event.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_channel::{Receiver as FeedReceiver, Sender as FeedSender};
use crossbeam_channel::{Receiver, RecvTimeoutError};
use herdr_core::link::LinkState;
use herdr_core::schema::AgentStatus;
use herdr_core::screen::Screen;
use herdr_core::store::MachineId;
use herdr_core::wire::ErrorKind;
use parking_lot::Mutex;
use serde_json::json;

use super::preview::{self, read_of, read_rows};
use super::{Fleet, Job, REQUEST_TIMEOUT, pane_feed_state, unknown};
use crate::feed::{FeedState, PaneFeed, PaneSource};
use crate::metrics;

/// The shortest time between two reads of one pane (20 a second).
const READ_GAP: Duration = Duration::from_millis(50);

/// How long after a failed read the pane is tried again while its machine is still connected.
const RETRY_AFTER: Duration = Duration::from_secs(2);

/// Rows read for a scrollback view.
const SCROLLBACK_LINES: u32 = 1000;

/// A pane and the part of it a view shows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct Key {
    machine: MachineId,
    pane: String,
    source: PaneSource,
}

impl Key {
    fn wire_source(&self) -> &'static str {
        match self.source {
            PaneSource::Visible => "visible",
            PaneSource::Recent => "recent",
        }
    }
}

struct WatchState {
    screen: Arc<Screen>,
    /// The last read failed (and none succeeded since).
    read_failed: bool,
    feed: FeedState,
    attention: Option<String>,
    /// When herdr first reported the activity the screen on show was read for (`PaneFeed::activity_at`).
    activity: Option<Instant>,
}

/// What every handle of one pane and source shares: the latest screen and the notices about it.
pub(super) struct Watch {
    key: Key,
    /// Rows to read; 0 reads what herdr shows by default.
    lines: AtomicU32,
    state: Mutex<WatchState>,
    /// When herdr first reported activity that no read has picked up yet: the start of the read-to-paint
    /// clock. Later activity before the read starts does not move it, so the figure is the worst wait.
    activity: Mutex<Option<Instant>>,
    /// Held while a read runs, so a read asked for by a caller and the scheduled one never overlap.
    reading: Mutex<()>,
    /// One channel per handle: a notice is delivered to every view of the pane, not to whichever awaits first.
    subscribers: Mutex<Vec<(u64, FeedSender<()>)>>,
    next_subscriber: AtomicU64,
}

impl Watch {
    fn notify(&self) {
        // Each channel holds one notice: one already waiting covers this change too.
        self.subscribers.lock().iter().for_each(|(_, tx)| {
            let _ = tx.try_send(());
        });
    }

    fn subscribe(&self) -> (u64, FeedReceiver<()>) {
        let (tx, rx) = async_channel::bounded(1);
        let id = self.next_subscriber.fetch_add(1, Ordering::Relaxed);
        self.subscribers.lock().push((id, tx));
        (id, rx)
    }
}

/// The watches that exist, with how many handles hold each.
#[derive(Default)]
pub(super) struct Watches {
    map: Mutex<HashMap<Key, (Arc<Watch>, usize)>>,
}

impl Watches {
    pub(super) fn len(&self) -> usize {
        self.map.lock().len()
    }

    fn of_machine(&self, machine: &str) -> Vec<Arc<Watch>> {
        self.map
            .lock()
            .iter()
            .filter(|(k, _)| k.machine == machine)
            .map(|(_, (w, _))| w.clone())
            .collect()
    }

    fn of_pane(&self, machine: &str, pane: &str) -> Vec<Arc<Watch>> {
        self.map
            .lock()
            .iter()
            .filter(|(k, _)| k.machine == machine && k.pane == pane)
            .map(|(_, (w, _))| w.clone())
            .collect()
    }
}

/// One view's claim on a pane. Dropping it releases the claim; the last release stops the reads.
pub struct WatchHandle {
    watch: Arc<Watch>,
    fleet: Weak<Fleet>,
    subscriber: u64,
    changed: FeedReceiver<()>,
}

impl PaneFeed for WatchHandle {
    fn screen(&self) -> Arc<Screen> {
        self.watch.state.lock().screen.clone()
    }

    fn state(&self) -> FeedState {
        self.watch.state.lock().feed
    }

    fn attention(&self) -> Option<String> {
        self.watch.state.lock().attention.clone()
    }

    fn activity_at(&self) -> Option<Instant> {
        self.watch.state.lock().activity
    }

    fn changed(&self) -> FeedReceiver<()> {
        self.changed.clone()
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.watch
            .subscribers
            .lock()
            .retain(|(id, _)| *id != self.subscriber);
        if let Some(fleet) = self.fleet.upgrade() {
            fleet.unwatch(&self.watch.key);
        }
    }
}

impl Fleet {
    /// Starts watching `pane` of `machine`; `None` when the machine is unknown. The first handle of a pane
    /// starts its reads at once.
    pub fn watch(
        self: &Arc<Self>,
        machine: &str,
        pane: &str,
        source: PaneSource,
    ) -> Option<WatchHandle> {
        self.link(machine)?;
        let key = Key {
            machine: machine.to_owned(),
            pane: pane.to_owned(),
            source,
        };
        let mut map = self.watches.map.lock();
        let entry = map.entry(key.clone()).or_insert_with(|| {
            let watch = Arc::new(Watch {
                key: key.clone(),
                lines: AtomicU32::new(match source {
                    PaneSource::Visible => 0,
                    PaneSource::Recent => SCROLLBACK_LINES,
                }),
                state: Mutex::new(WatchState {
                    screen: Arc::new(Screen::default()),
                    read_failed: false,
                    feed: FeedState::Live,
                    attention: None,
                    activity: None,
                }),
                activity: Mutex::new(None),
                reading: Mutex::new(()),
                subscribers: Mutex::new(Vec::new()),
                next_subscriber: AtomicU64::new(1),
            });
            let _ = self.sched.send(Sched::Open(watch.clone()));
            (watch, 0)
        });
        entry.1 += 1;
        let watch = entry.0.clone();
        drop(map);
        refresh(self, &watch);
        let (subscriber, changed) = watch.subscribe();
        Some(WatchHandle {
            watch,
            fleet: Arc::downgrade(self),
            subscriber,
            changed,
        })
    }

    fn unwatch(&self, key: &Key) {
        let mut map = self.watches.map.lock();
        if let Some(entry) = map.get_mut(key) {
            entry.1 -= 1;
            if entry.1 == 0 {
                map.remove(key);
                let _ = self.sched.send(Sched::Close(key.clone()));
            }
        }
    }

    /// Reads a watched pane now (past the throttle), with `lines` rows when given, and returns once every
    /// view of it shows the result. Nothing happens for a pane nobody watches: there is no view to fill.
    pub fn read_now(
        &self,
        machine: &str,
        pane: &str,
        source: PaneSource,
        lines: Option<u32>,
    ) -> Result<(), String> {
        self.link(machine).ok_or_else(|| unknown(machine))?;
        let watches = self.watches.of_pane(machine, pane);
        for watch in watches.iter().filter(|w| w.key.source == source) {
            if let Some(lines) = lines {
                watch.lines.store(lines, Ordering::Relaxed);
            }
            read_screen(self, watch).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Messages to the scheduler.
pub(super) enum Sched {
    /// A watch was created: read it at once.
    Open(Arc<Watch>),
    /// The last handle of a watch was dropped.
    Close(Key),
    /// herdr says the pane's content moved. The event's revision is not used to skip reads: `pane.read`
    /// answers revision 0 for a visible screen, so the two counters cannot be compared, and the 50 ms gap
    /// already bounds the rate.
    Activity {
        machine: MachineId,
        pane: String,
    },
    /// The machine's link reported a change.
    Link(MachineId),
    /// A read finished.
    Done {
        key: Key,
        ok: bool,
    },
    Stop,
}

struct Entry {
    watch: Arc<Watch>,
    /// When the next read starts.
    due: Option<Instant>,
    in_flight: bool,
    /// More activity arrived while a read ran.
    dirty: bool,
    last_start: Option<Instant>,
}

impl Entry {
    /// Asks for a read: after the gap since the last one, once, however many events ask.
    fn want(&mut self, now: Instant) {
        if self.in_flight {
            self.dirty = true;
        } else if self.due.is_none() {
            self.due = Some(self.last_start.map_or(now, |t| (t + READ_GAP).max(now)));
        }
    }
}

pub(super) fn schedule(fleet: &Fleet, rx: &Receiver<Sched>) {
    let mut entries: HashMap<Key, Entry> = HashMap::new();
    loop {
        let next = entries
            .values()
            .filter(|e| !e.in_flight)
            .filter_map(|e| e.due)
            .min();
        let message = match next {
            Some(due) => match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        let now = Instant::now();
        match message {
            None => {}
            Some(Sched::Stop) => return,
            Some(Sched::Open(watch)) => {
                let mut entry = Entry {
                    watch: watch.clone(),
                    due: None,
                    in_flight: false,
                    dirty: false,
                    last_start: None,
                };
                entry.want(now);
                entries.insert(watch.key.clone(), entry);
            }
            Some(Sched::Close(key)) => {
                entries.remove(&key);
            }
            Some(Sched::Activity { machine, pane }) => {
                for entry in entries.values_mut() {
                    let k = &entry.watch.key;
                    if k.machine == machine && k.pane == pane {
                        entry.watch.activity.lock().get_or_insert(now);
                        entry.want(now);
                    }
                }
            }
            Some(Sched::Link(machine)) => {
                for entry in entries
                    .values_mut()
                    .filter(|e| e.watch.key.machine == machine)
                {
                    // Back from stale (the machine reconnected): events were missed, read again.
                    if refresh(fleet, &entry.watch) {
                        entry.want(now);
                    }
                }
            }
            Some(Sched::Done { key, ok }) => {
                if let Some(entry) = entries.get_mut(&key) {
                    entry.in_flight = false;
                    if ok {
                        if std::mem::take(&mut entry.dirty) {
                            entry.want(now);
                        }
                    } else {
                        entry.dirty = false;
                        // While the machine is connected a failed read is a hiccup: try again soon. When it
                        // is not, the link coming back (`Sched::Link`) restarts the reads.
                        if fleet
                            .link(&key.machine)
                            .is_some_and(|l| l.state() == LinkState::Online)
                        {
                            entry.due = Some(now + RETRY_AFTER);
                        }
                    }
                }
            }
        }
        for entry in entries.values_mut() {
            if !entry.in_flight && entry.due.is_some_and(|t| t <= now) {
                entry.due = None;
                entry.in_flight = true;
                entry.last_start = Some(now);
                let _ = fleet.jobs.send(Job::Feed(entry.watch.clone()));
            }
        }
    }
}

pub(super) fn work(fleet: &Fleet, jobs: &Receiver<Job>) {
    while let Ok(job) = jobs.recv() {
        match job {
            Job::Stop => return,
            Job::Feed(watch) => {
                let ok = read_screen(fleet, &watch).is_ok();
                let _ = fleet.sched.send(Sched::Done {
                    key: watch.key.clone(),
                    ok,
                });
            }
            Job::Preview {
                machine,
                pane,
                stamp,
            } => read_preview(fleet, &machine, &pane, stamp),
        }
    }
}

/// Reads one pane's screen into its watch.
fn read_screen(fleet: &Fleet, watch: &Watch) -> Result<(), String> {
    let _reading = watch.reading.lock();
    let key = &watch.key;
    let link = fleet
        .link(&key.machine)
        .ok_or_else(|| unknown(&key.machine))?;
    if link.state() != LinkState::Online {
        refresh(fleet, watch);
        return Err("the machine is not connected".to_owned());
    }
    // Taken before the request: activity that arrives while it runs belongs to the next read.
    let activity = watch.activity.lock().take();
    let mut params = json!({
        "pane_id": key.pane,
        "source": key.wire_source(),
        "format": "ansi",
        "strip_ansi": false,
    });
    match watch.lines.load(Ordering::Relaxed) {
        0 => {}
        lines => params["lines"] = json!(lines),
    }
    let result = link.wire().request("pane.read", params, REQUEST_TIMEOUT);
    match result {
        Ok(value) => {
            let text = value
                .pointer("/read/text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| "herdr's pane.read answer has no text".to_owned());
            let text = match text {
                Ok(text) => text,
                Err(e) => {
                    fail(fleet, watch, false);
                    return Err(e);
                }
            };
            metrics::pane_read();
            let changed = {
                let mut state = watch.state.lock();
                let parse_started = Instant::now();
                let screen = Screen::parse(text, Some(&state.screen));
                metrics::screen_parsed(screen.rows.len(), parse_started.elapsed());
                let moved = screen.cols != state.screen.cols
                    || screen.rows.len() != state.screen.rows.len()
                    || screen
                        .rows
                        .iter()
                        .zip(&state.screen.rows)
                        .any(|(a, b)| !Arc::ptr_eq(a, b));
                if moved {
                    state.screen = Arc::new(screen);
                    state.activity = activity;
                }
                let recovered = std::mem::take(&mut state.read_failed);
                moved || recovered
            };
            refresh(fleet, watch);
            if changed {
                watch.notify();
            }
            Ok(())
        }
        Err(e) => {
            // A pane herdr no longer has is `Gone`, which the snapshot says; anything else is a failed read.
            let gone = matches!(&e.kind, ErrorKind::Api { code } if code.ends_with("_not_found"));
            fail(fleet, watch, gone);
            Err(e.message)
        }
    }
}

/// A read failed: the screen on show is now the last one, so say so.
fn fail(fleet: &Fleet, watch: &Watch, gone: bool) {
    if !gone {
        watch.state.lock().read_failed = true;
    }
    refresh(fleet, watch);
    watch.notify();
}

/// Recomputes what a watch tells its views besides the rows (is the screen current, what is the agent
/// asking) and notifies them if it changed. True when the watch just stopped being stale.
fn refresh(fleet: &Fleet, watch: &Watch) -> bool {
    let key = &watch.key;
    let (mut feed, attention) = match fleet.link(&key.machine) {
        None => (FeedState::Gone, None),
        Some(link) => {
            let state = link.state();
            let snapshot = link.snapshot();
            let feed = pane_feed_state(&state, &snapshot, &key.pane);
            let attention = match (state == LinkState::Online)
                .then(|| snapshot.agent(&key.pane))
                .flatten()
            {
                Some(agent) if agent.agent_status == AgentStatus::Blocked => Some(
                    fleet
                        .previews
                        .prompt(
                            &key.machine,
                            &key.pane,
                            (AgentStatus::Blocked, agent.state_change_seq),
                        )
                        .map_or_else(|| "Waiting for an answer".to_owned(), |p| p.question),
                ),
                _ => None,
            };
            (feed, attention)
        }
    };
    let mut state = watch.state.lock();
    if feed == FeedState::Live && state.read_failed {
        feed = FeedState::Stale;
    }
    let was_stale = state.feed == FeedState::Stale;
    let changed = state.feed != feed || state.attention != attention;
    state.feed = feed;
    state.attention = attention;
    drop(state);
    if changed {
        watch.notify();
    }
    was_stale && feed == FeedState::Live
}

/// Reads the rows and question a board card shows for one episode of one agent.
fn read_preview(fleet: &Fleet, machine: &str, pane: &str, stamp: preview::Stamp) {
    let now = Instant::now();
    let Some(link) = fleet
        .link(machine)
        .filter(|l| l.state() == LinkState::Online)
    else {
        fleet.previews.fail(machine, pane, now);
        return;
    };
    match read_rows(&*link.wire(), pane, REQUEST_TIMEOUT) {
        Ok(rows) => {
            let read = read_of(rows, stamp.0 == AgentStatus::Blocked);
            if fleet.previews.store(machine, pane, stamp, read) {
                for watch in fleet.watches.of_pane(machine, pane) {
                    refresh(fleet, &watch);
                }
                fleet.bump();
            }
        }
        Err(_) => fleet.previews.fail(machine, pane, now),
    }
}

impl Fleet {
    /// Refreshes the watches of a machine after its state changed outside the scheduler's view (a machine
    /// was removed or switched off).
    pub(super) fn refresh_machine_watches(&self, machine: &str) {
        for watch in self.watches.of_machine(machine) {
            refresh(self, &watch);
        }
    }
}
