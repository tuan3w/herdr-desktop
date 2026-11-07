//! The forwarder: link updates in, at most one tick per [`TICK_GAP`] out.
//!
//! Besides ticking it keeps the state that depends on what a link reports in step with it: an agent's
//! state episode is dated the moment it is first seen, a reviewed mark is dropped once its agent left the
//! finished state (herdr's sequence numbers start over when its server restarts, and a stale mark must
//! never match a later episode), and previews of panes that are gone are forgotten.

use std::collections::HashSet;
use std::time::Instant;

use crossbeam_channel::{Receiver, RecvTimeoutError, select};
use herdr_core::link::{LinkState, Update};

use super::panes::Sched;
use super::{Fleet, Note, TICK_GAP};

/// What the forwarder woke for.
enum Wake {
    Update(Update),
    Bump,
    Stop,
}

pub(super) fn run(fleet: &Fleet, updates: &Receiver<Update>, notes: &Receiver<Note>) {
    let mut last_tick: Option<Instant> = None;
    loop {
        let Some(first) = wait(updates, notes) else {
            return;
        };
        if !handle(fleet, first) {
            return;
        }
        // Later updates join this tick until the gap since the previous one has passed. After a quiet
        // spell the deadline is already past, so the first change is delivered at once.
        let deadline = last_tick.map_or_else(Instant::now, |t| t + TICK_GAP);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let more = select! {
                recv(updates) -> u => u.map(Wake::Update).map_err(|_| RecvTimeoutError::Disconnected),
                recv(notes) -> n => n.map(|n| match n { Note::Bump => Wake::Bump, Note::Stop => Wake::Stop })
                    .map_err(|_| RecvTimeoutError::Disconnected),
                default(left) => Err(RecvTimeoutError::Timeout),
            };
            match more {
                Ok(wake) => {
                    if !handle(fleet, wake) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        last_tick = Some(Instant::now());
        fleet
            .revision
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (fleet.on_tick)();
        let _ = fleet.notify.send(crate::notify::Input::Tick);
    }
}

fn wait(updates: &Receiver<Update>, notes: &Receiver<Note>) -> Option<Wake> {
    select! {
        recv(updates) -> u => u.ok().map(Wake::Update),
        recv(notes) -> n => n.ok().map(|n| match n { Note::Bump => Wake::Bump, Note::Stop => Wake::Stop }),
    }
}

/// Applies one wake; false when the engine is stopping.
fn handle(fleet: &Fleet, wake: Wake) -> bool {
    match wake {
        Wake::Stop => false,
        Wake::Bump => true,
        Wake::Update(update) => {
            absorb(fleet, &update.machine);
            true
        }
    }
}

/// Brings the state that follows a link up to date after it reported a change.
fn absorb(fleet: &Fleet, machine: &str) {
    let Some(link) = fleet.link(machine) else {
        return;
    };
    let snapshot = link.snapshot();
    // Only a snapshot that arrived counts: before the first one the empty snapshot would make the
    // machine "seen" and date every agent's long-running state as new.
    if link.state() == LinkState::Online {
        fleet
            .first_seen
            .lock()
            .observe(machine, &snapshot, Instant::now());
        let mut reviewed = fleet.reviewed.lock();
        if reviewed.reconcile(machine, &snapshot)
            && let Err(e) = fleet.store.save_reviewed(&reviewed)
        {
            eprintln!("herdr-desktop: cannot save the reviewed marks: {e}");
        }
        drop(reviewed);
        let present: HashSet<&str> = snapshot.panes.iter().map(|p| p.pane_id.as_str()).collect();
        fleet
            .previews
            .retain(machine, |pane| present.contains(pane));
    }
    let _ = fleet.sched.send(Sched::Link(machine.to_owned()));
}
