//! The link's worker thread: the state machine, every request, the throttle and the backoff.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, never, select};
use serde_json::{Value, json};

use super::{
    Activity, Cmd, LinkNote, LinkState, LinkStatus, Profile, Shared, Timer, Timing, Update,
    link_subscriptions,
};
use crate::schema::{Event, PROTOCOL, PaneInfo, Snapshot};
use crate::wire::{ErrorKind, WireError};

/// How long the events thread blocks in one read. Only bounds how soon it notices it was told to
/// stop; the link's own timing never depends on it.
const EVENT_POLL: Duration = Duration::from_millis(250);

/// Why a stretch of the worker's life ended.
enum Outcome {
    Shutdown,
    /// Drop the connection and start over at once (network change, resume, `reconnect_now`).
    Reconnect,
    /// The person switched the machine off.
    Disable,
    Failed(WireError),
}

enum Wake {
    Cmd(Cmd),
    Timer,
}

/// The two moments a live link is waiting for besides its poll.
struct Live {
    /// When the throttled snapshot read caused by events is due.
    refresh_due: Option<Instant>,
    /// When the snapshot was last read.
    last_read: Instant,
}

pub(super) struct Worker {
    shared: Arc<Shared>,
    timing: Timing,
    enabled: bool,
    cmd_rx: Receiver<Cmd>,
    cmd_tx: Sender<Cmd>,
    updates: Sender<Update>,
    profile: Profile,
    /// Identifies the event stream that may talk to this worker; bumped per connection attempt.
    epoch: u64,
    stop_stream: Option<Arc<AtomicBool>>,
    threads: Vec<JoinHandle<()>>,
    /// Failed attempts in a row, as far as the delays are concerned.
    attempt: u32,
    ever_online: bool,
    protocol_seen: u32,
    /// When the current stream went live, and what it delivered since.
    live_since: Option<Instant>,
    events_seen: u64,
}

impl Worker {
    pub(super) fn new(
        shared: Arc<Shared>,
        timing: Timing,
        enabled: bool,
        cmd_rx: Receiver<Cmd>,
        cmd_tx: Sender<Cmd>,
        updates: Sender<Update>,
    ) -> Self {
        Self {
            shared,
            timing,
            enabled,
            cmd_rx,
            cmd_tx,
            updates,
            profile: Profile::Foreground,
            epoch: 0,
            stop_stream: None,
            threads: Vec::new(),
            attempt: 0,
            ever_online: false,
            protocol_seen: 0,
            live_since: None,
            events_seen: 0,
        }
    }

    pub(super) fn run(mut self) {
        loop {
            if !self.enabled {
                self.go_off();
                if !self.wait_enabled() {
                    break;
                }
                continue;
            }
            let outcome = self.connect_and_serve();
            self.stop_stream();
            match outcome {
                Outcome::Shutdown => break,
                Outcome::Disable => self.enabled = false,
                Outcome::Reconnect => self.attempt = 0,
                Outcome::Failed(e) if e.is_fatal() => {
                    self.show_attention(&e);
                    match self.wait_in_attention() {
                        Outcome::Shutdown => break,
                        Outcome::Disable => self.enabled = false,
                        _ => self.attempt = 0,
                    }
                }
                Outcome::Failed(e) => match self.back_off(&e) {
                    None => {}
                    Some(Outcome::Shutdown) => break,
                    Some(Outcome::Disable) => self.enabled = false,
                    Some(_) => self.attempt = 0,
                },
            }
        }
        self.stop_stream();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }

    fn clock_now(&self) -> Instant {
        self.shared.clock.now()
    }

    /// Publishes a change: a new snapshot, a new status, or both, as one revision and one [`Update`].
    /// Does nothing when `snapshot` is `None` and the edit changes nothing.
    fn commit(&self, snapshot: Option<Snapshot>, edit: impl FnOnce(&mut LinkStatus)) {
        let mut inner = self.shared.inner.lock();
        let mut status = inner.status.clone();
        edit(&mut status);
        if snapshot.is_none() && status == inner.status {
            return;
        }
        inner.revision += 1;
        let revision = inner.revision;
        if let Some(mut s) = snapshot {
            s.revision = revision;
            inner.snapshot = Arc::new(s);
        }
        inner.status = status;
        drop(inner);
        let _ = self.updates.send(Update {
            machine: self.shared.machine.clone(),
            revision,
        });
    }

    fn wait(&self, deadline: Option<Instant>) -> Wake {
        let timer = deadline.map(|d| self.shared.clock.timer(d));
        let idle = never::<Instant>();
        let timer_rx = timer.as_ref().map_or(&idle, Timer::receiver);
        select! {
            recv(self.cmd_rx) -> msg => Wake::Cmd(msg.unwrap_or(Cmd::Shutdown)),
            recv(timer_rx) -> _ => Wake::Timer,
        }
    }

    /// What a command means when the link is not live: the commands that end the current stretch,
    /// and the profile, which is remembered. Everything else (stale events, refresh requests) is dropped.
    fn passive(&mut self, cmd: Cmd) -> Option<Outcome> {
        match cmd {
            Cmd::Shutdown => Some(Outcome::Shutdown),
            Cmd::Reconnect | Cmd::NetworkChanged => Some(Outcome::Reconnect),
            Cmd::SetEnabled(false) => Some(Outcome::Disable),
            Cmd::SetProfile(p) => {
                self.profile = p;
                None
            }
            _ => None,
        }
    }

    /// Applies the commands already waiting, between two blocking requests.
    fn pending_interrupt(&mut self) -> Option<Outcome> {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            if let Some(outcome) = self.passive(cmd) {
                return Some(outcome);
            }
        }
        None
    }

    fn go_off(&mut self) {
        self.ever_online = false;
        self.attempt = 0;
        if self.shared.inner.lock().status.state == LinkState::Off {
            return;
        }
        self.commit(Some(Snapshot::default()), |s| {
            s.state = LinkState::Off;
            s.error = None;
            s.fatal = None;
            s.retry_at = None;
            s.attempt = 0;
            s.notes.clear();
        });
    }

    /// Blocks while the machine is switched off; false when the link is shutting down.
    fn wait_enabled(&mut self) -> bool {
        loop {
            match self.wait(None) {
                Wake::Cmd(Cmd::Shutdown) => return false,
                Wake::Cmd(Cmd::SetEnabled(true)) => {
                    self.enabled = true;
                    return true;
                }
                Wake::Cmd(Cmd::SetProfile(p)) => self.profile = p,
                Wake::Cmd(_) | Wake::Timer => {}
            }
        }
    }

    fn show_attention(&mut self, e: &WireError) {
        let ErrorKind::Fatal(fatal) = e.kind else {
            return;
        };
        let attempt = self.attempt;
        self.commit(None, |s| {
            s.state = LinkState::Attention(e.message.clone());
            s.error = Some(e.message.clone());
            s.fatal = Some(fatal);
            s.retry_at = None;
            s.attempt = attempt;
        });
    }

    /// Waits for the person to fix what needs fixing. A network change is not it.
    fn wait_in_attention(&mut self) -> Outcome {
        loop {
            match self.wait(None) {
                Wake::Cmd(Cmd::NetworkChanged) | Wake::Timer => {}
                Wake::Cmd(cmd) => {
                    if let Some(outcome) = self.passive(cmd) {
                        return outcome;
                    }
                }
            }
        }
    }

    fn retry_delay(&self, attempt: u32) -> Duration {
        let at = attempt as usize;
        let normal = self.timing.backoff[at.min(self.timing.backoff.len() - 1)];
        match self.profile {
            Profile::Foreground => normal,
            Profile::Background => {
                // The longer of the two: a machine that sleeps is not tried every 30 s all night.
                normal.max(
                    self.timing.background_backoff
                        [at.min(self.timing.background_backoff.len() - 1)],
                )
            }
        }
    }

    /// Sleeps the reconnect delay; `Some` when something ended the wait early.
    fn back_off(&mut self, error: &WireError) -> Option<Outcome> {
        let attempt = self.attempt;
        self.attempt += 1;
        let started = self.clock_now();
        loop {
            // Recomputed each pass: a change of profile changes the delay of the wait in progress.
            let deadline = started + self.retry_delay(attempt);
            self.commit(None, |s| {
                s.state = LinkState::Offline;
                s.error = Some(error.message.clone());
                s.fatal = None;
                s.retry_at = Some(deadline);
                s.attempt = attempt + 1;
            });
            match self.wait(Some(deadline)) {
                Wake::Timer if self.clock_now() >= deadline => return None,
                Wake::Timer => {}
                Wake::Cmd(cmd) => {
                    if let Some(outcome) = self.passive(cmd) {
                        return Some(outcome);
                    }
                }
            }
        }
    }

    fn connect_and_serve(&mut self) -> Outcome {
        self.epoch += 1;
        let epoch = self.epoch;
        self.stop_stream();
        self.live_since = None;
        self.events_seen = 0;
        let waiting_state = if self.ever_online {
            LinkState::Offline
        } else {
            LinkState::Connecting
        };
        self.commit(None, |s| {
            if matches!(s.state, LinkState::Off | LinkState::Attention(_)) {
                s.state = waiting_state;
                s.error = None;
                s.fatal = None;
            }
            s.retry_at = None;
        });
        if let Some(outcome) = self.pending_interrupt() {
            return outcome;
        }

        match self
            .shared
            .wire
            .request("ping", json!({}), self.timing.request_timeout)
        {
            Ok(pong) => self.note_ping(&pong),
            // An older herdr without `ping` is still a herdr.
            Err(WireError {
                kind: ErrorKind::Api { .. },
                ..
            }) => {}
            Err(e) => return Outcome::Failed(e),
        }
        if let Some(outcome) = self.pending_interrupt() {
            return outcome;
        }

        // Subscribe before reading, so nothing that happens in between is missed.
        self.start_stream(epoch);
        if let Err(outcome) = self.await_stream(epoch) {
            return outcome;
        }
        let snapshot = match self.read_snapshot() {
            Ok(s) => s,
            Err(e) => return Outcome::Failed(e),
        };
        let now = self.clock_now();
        self.ever_online = true;
        self.live_since = Some(now);
        self.shared.inner.lock().last_heard = Some(now);
        self.protocol_seen = self.protocol_seen.max(snapshot.protocol);
        let notes = self.notes();
        self.commit(Some(snapshot), |s| {
            s.state = LinkState::Online;
            s.error = None;
            s.fatal = None;
            s.retry_at = None;
            s.attempt = 0;
            s.notes = notes;
        });
        self.serve(epoch, now)
    }

    fn note_ping(&mut self, pong: &Value) {
        let protocol = pong.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        self.protocol_seen = self
            .protocol_seen
            .max(u32::try_from(protocol).unwrap_or(u32::MAX));
        let version = pong
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let notes = self.notes();
        self.commit(None, |s| {
            s.herdr_version = version;
            s.notes = notes;
        });
    }

    fn notes(&self) -> Vec<LinkNote> {
        if self.protocol_seen > PROTOCOL {
            vec![LinkNote::NewerHerdr]
        } else {
            Vec::new()
        }
    }

    fn read_snapshot(&self) -> Result<Snapshot, WireError> {
        let result =
            self.shared
                .wire
                .request("session.snapshot", json!({}), self.timing.request_timeout)?;
        Snapshot::from_result(&result)
    }

    fn start_stream(&mut self, epoch: u64) {
        let stop = Arc::new(AtomicBool::new(false));
        self.stop_stream = Some(stop.clone());
        let (finished, running): (Vec<_>, Vec<_>) =
            self.threads.drain(..).partition(|t| t.is_finished());
        self.threads = running;
        for t in finished {
            let _ = t.join();
        }
        let wire = self.shared.wire.clone();
        let tx = self.cmd_tx.clone();
        let handle = std::thread::Builder::new()
            .name(format!("herdr-events-{}", self.shared.machine))
            .spawn(move || events_loop(wire.as_ref(), epoch, &stop, &tx))
            .expect("the OS can start a thread");
        self.threads.push(handle);
    }

    fn stop_stream(&mut self) {
        if let Some(stop) = self.stop_stream.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Waits for the events thread to report that the subscription was acknowledged.
    fn await_stream(&mut self, epoch: u64) -> Result<(), Outcome> {
        let deadline = self.clock_now() + self.timing.subscribe_wait;
        loop {
            match self.wait(Some(deadline)) {
                Wake::Cmd(Cmd::StreamUp(g)) if g == epoch => return Ok(()),
                Wake::Cmd(Cmd::StreamEnded(g, e)) if g == epoch => return Err(Outcome::Failed(e)),
                Wake::Cmd(cmd) => {
                    if let Some(outcome) = self.passive(cmd) {
                        return Err(outcome);
                    }
                }
                Wake::Timer => {
                    if self.clock_now() >= deadline {
                        return Err(Outcome::Failed(WireError::retryable(
                            "herdr did not acknowledge the event subscription in time",
                        )));
                    }
                }
            }
        }
    }

    fn poll_interval(&self) -> Duration {
        match self.profile {
            Profile::Foreground => self.timing.poll,
            Profile::Background => self.timing.background_poll,
        }
    }

    /// The live stretch: events, the throttled refresh, the poll and the sleep check.
    fn serve(&mut self, epoch: u64, start: Instant) -> Outcome {
        let clock = self.shared.clock.clone();
        let mut live = Live {
            refresh_due: None,
            last_read: start,
        };
        let mut poll_due = start + self.poll_interval();
        let mut tick_due = start + self.timing.tick;
        let mut last_tick = (start, clock.wall());
        loop {
            let now = clock.now();
            if now >= tick_due {
                let wall = clock.wall();
                let monotonic_gap = now.saturating_duration_since(last_tick.0);
                let wall_gap = wall.duration_since(last_tick.1).unwrap_or_default();
                if wall_gap > monotonic_gap + self.timing.resume_gap {
                    return Outcome::Reconnect;
                }
                last_tick = (now, wall);
                tick_due = now + self.timing.tick;
            }
            if live.refresh_due.is_some_and(|d| now >= d) || now >= poll_due {
                live.refresh_due = None;
                match self.read_snapshot() {
                    Ok(snapshot) => {
                        self.apply_snapshot(snapshot);
                        live.last_read = clock.now();
                        poll_due = live.last_read + self.poll_interval();
                    }
                    Err(e) => return self.live_failed(e),
                }
            }
            let next = [live.refresh_due, Some(poll_due), Some(tick_due)]
                .into_iter()
                .flatten()
                .min();
            match self.wait(next) {
                Wake::Timer => {}
                Wake::Cmd(Cmd::Event(g, value)) => {
                    if g == epoch {
                        self.on_event(&value, &mut live);
                    }
                }
                Wake::Cmd(Cmd::StreamEnded(g, e)) => {
                    if g == epoch {
                        return self.live_failed(e);
                    }
                }
                Wake::Cmd(Cmd::Refresh) => self.want_refresh(&mut live, clock.now()),
                Wake::Cmd(Cmd::SetProfile(p)) => {
                    let was = self.profile;
                    self.profile = p;
                    poll_due = live.last_read + self.poll_interval();
                    // Coming back to the window: whatever happened while it was hidden is read once.
                    if was == Profile::Background && p == Profile::Foreground {
                        self.want_refresh(&mut live, clock.now());
                    }
                }
                Wake::Cmd(cmd) => {
                    if let Some(outcome) = self.passive(cmd) {
                        return outcome;
                    }
                }
            }
        }
    }

    /// A live stretch ended in failure: the reconnect delays start over if the stream had worked.
    fn live_failed(&mut self, e: WireError) -> Outcome {
        if let Some(since) = self.live_since {
            let lived = self.clock_now().saturating_duration_since(since);
            if self.events_seen > 0 || lived >= self.timing.stream_proven_after {
                self.attempt = 0;
            }
        }
        Outcome::Failed(e)
    }

    fn want_refresh(&self, live: &mut Live, now: Instant) {
        if live.refresh_due.is_none() {
            live.refresh_due =
                Some((now + self.timing.coalesce).max(live.last_read + self.timing.refresh_gap));
        }
    }

    fn apply_snapshot(&mut self, snapshot: Snapshot) {
        self.shared.inner.lock().last_heard = Some(self.clock_now());
        self.protocol_seen = self.protocol_seen.max(snapshot.protocol);
        let notes = self.notes();
        let unchanged = self.shared.inner.lock().snapshot.same_content(&snapshot);
        self.commit((!unchanged).then_some(snapshot), |s| s.notes = notes);
    }

    fn on_event(&mut self, value: &Value, live: &mut Live) {
        let Some(event) = Event::parse(value) else {
            return;
        };
        let now = self.clock_now();
        self.events_seen += 1;
        self.shared.inner.lock().last_heard = Some(now);
        match event {
            Event::PaneUpdated(pane) => {
                self.send_activity(&pane.pane_id, pane.revision);
                self.patch_pane(&pane, live, now);
            }
            Event::PaneOutputChanged { pane_id, revision } => {
                self.send_activity(&pane_id, revision)
            }
            Event::PaneAgentStatusChanged { .. } | Event::Structural(_) | Event::Other(_) => {
                self.want_refresh(live, now)
            }
        }
    }

    fn send_activity(&self, pane_id: &str, revision: u64) {
        let mut subscribers = self.shared.activity.lock();
        if subscribers.is_empty() {
            return;
        }
        let activity = Activity {
            machine: self.shared.machine.clone(),
            pane_id: pane_id.to_owned(),
            revision,
        };
        subscribers.retain(|tx| tx.send(activity.clone()).is_ok());
    }

    /// Applies a `pane_updated` to the snapshot without reading it, unless the event says something
    /// only a read can settle: a status or agent change (`state_change_seq` is not on a pane), or a
    /// pane or agent the snapshot does not know.
    fn patch_pane(&mut self, pane: &PaneInfo, live: &mut Live, now: Instant) {
        let current = self.shared.inner.lock().snapshot.clone();
        let Some(known) = current.pane(&pane.pane_id) else {
            self.want_refresh(live, now);
            return;
        };
        let has_agent = current.agent(&pane.pane_id).is_some();
        if known.agent_status != pane.agent_status
            || known.agent != pane.agent
            || (pane.agent.is_some() && !has_agent)
        {
            self.want_refresh(live, now);
            return;
        }
        if known.same_view(pane) {
            return;
        }
        let mut next = (*current).clone();
        if let Some(slot) = next.panes.iter_mut().find(|p| p.pane_id == pane.pane_id) {
            *slot = pane.clone();
        }
        if let Some(agent) = next.agents.iter_mut().find(|a| a.pane_id == pane.pane_id) {
            agent.apply_pane(pane);
        }
        self.commit(Some(next), |_| {});
    }
}

/// Reads one connection's events and hands them to the worker, until told to stop or the stream ends.
fn events_loop(wire: &dyn crate::wire::Wire, epoch: u64, stop: &AtomicBool, tx: &Sender<Cmd>) {
    let mut stream = match wire.events(&link_subscriptions()) {
        Ok(stream) => stream,
        Err(e) => {
            if !stop.load(Ordering::Relaxed) {
                let _ = tx.send(Cmd::StreamEnded(epoch, e));
            }
            return;
        }
    };
    if stop.load(Ordering::Relaxed) || tx.send(Cmd::StreamUp(epoch)).is_err() {
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        match stream.next(EVENT_POLL) {
            Ok(Some(value)) => {
                if tx.send(Cmd::Event(epoch, value)).is_err() {
                    return;
                }
            }
            Ok(None) => {}
            Err(e) => {
                if !stop.load(Ordering::Relaxed) {
                    let _ = tx.send(Cmd::StreamEnded(epoch, e));
                }
                return;
            }
        }
    }
}
