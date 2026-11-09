//! The forwarder: link updates in, at most one tick per [`TICK_GAP`] out.
//!
//! Besides ticking it keeps the state that depends on what a link reports in step with it: an agent's
//! state episode is dated the moment it is first seen, a reviewed mark is dropped once its agent left the
//! finished state (herdr's sequence numbers start over when its server restarts, and a stale mark must
//! never match a later episode), and previews of panes that are gone are forgotten.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::{Receiver, RecvTimeoutError, select};
use herdr_core::cache::{Cache, Key, Kind};
use herdr_core::link::{LinkState, Update};
use herdr_core::schema::Snapshot;

use super::panes::Sched;
use super::{Fleet, Note, TICK_GAP, now_ms};

/// What a machine's saved snapshot says it is: the file format, bumped when it stops reading as before.
const COPY_VERSION: u64 = 1;
/// A saved snapshot older than this shows agents that are long gone, so it is not shown.
const COPY_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// A snapshot larger than this is not worth the disk; the board then starts empty as before.
const COPY_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Where the board keeps the last snapshot of `machine`.
pub(super) fn board_key(cache: &Cache, machine: &str) -> Key {
    cache.key(Kind::Board, machine, "snapshot")
}

/// The bytes that keep `snapshot` (as of `saved_ms`) for the next run, or `None` when it is too large to keep.
fn encode_board(snapshot: &Snapshot, saved_ms: u64) -> Option<Vec<u8>> {
    let body = serde_json::to_vec(snapshot).ok()?;
    if body.len() > COPY_MAX_BYTES {
        return None;
    }
    let mut out =
        format!("{{\"v\":{COPY_VERSION},\"savedMs\":{saved_ms},\"snapshot\":").into_bytes();
    out.extend_from_slice(&body);
    out.push(b'}');
    Some(out)
}

/// The snapshot a copy made by [`encode_board`] holds, when it is of this format and no more than a day
/// old at `now_ms`.
pub(super) fn decode_board(bytes: &[u8], now_ms: u64) -> Option<Snapshot> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("v")?.as_u64()? != COPY_VERSION {
        return None;
    }
    let saved_ms = value.get("savedMs")?.as_u64()?;
    if now_ms.saturating_sub(saved_ms) > COPY_MAX_AGE_MS {
        return None;
    }
    // `from_result` also reads a bare snapshot, which would turn a copy without one into an empty board.
    value.get("snapshot")?;
    Snapshot::from_result(&value).ok()
}

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
        // The next run paints this before its link connects. The job reads the link when it runs, so a
        // burst of changes writes once, and a machine that went offline or was removed since writes nothing
        // (a stale snapshot must not replace the last good one).
        let weak = Arc::downgrade(&link);
        fleet
            .cache
            .save_soon(&board_key(&fleet.cache, machine), move || {
                Box::new(move || {
                    let link = weak.upgrade()?;
                    if link.state() != LinkState::Online {
                        return None;
                    }
                    encode_board(&link.snapshot(), now_ms())
                })
            });
    }
    let _ = fleet.sched.send(Sched::Link(machine.to_owned()));
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn snapshot() -> Snapshot {
        Snapshot {
            version: "9.9.9".to_owned(),
            focused_pane_id: Some("w1:p1".to_owned()),
            ..Snapshot::default()
        }
    }

    #[test]
    fn a_fresh_copy_gives_back_the_snapshot_it_kept() {
        let bytes = encode_board(&snapshot(), 1_000).expect("small enough");
        let back = decode_board(&bytes, 1_000 + 60_000).expect("fresh");
        assert_eq!(back.version, "9.9.9");
        assert_eq!(back.focused_pane_id.as_deref(), Some("w1:p1"));
    }

    #[test]
    fn a_copy_is_shown_for_a_day_and_not_longer() {
        let bytes = encode_board(&snapshot(), 1_000).expect("small enough");
        assert!(decode_board(&bytes, 1_000 + DAY_MS).is_some());
        assert!(decode_board(&bytes, 1_000 + DAY_MS + 1).is_none());
    }

    #[test]
    fn a_copy_of_another_format_or_that_does_not_read_is_not_shown() {
        let other = br#"{"v":2,"savedMs":1,"snapshot":{"version":"x"}}"#;
        assert!(decode_board(other, 2).is_none(), "another version");
        let bare = br#"{"v":1,"savedMs":1}"#;
        assert!(
            decode_board(bare, 2).is_none(),
            "no snapshot is not an empty one"
        );
        assert!(decode_board(b"not json", 2).is_none());
        assert!(decode_board(b"", 2).is_none());
    }

    #[test]
    fn a_snapshot_too_large_to_keep_is_not_kept() {
        let big = Snapshot {
            version: "x".repeat(COPY_MAX_BYTES + 1),
            ..Snapshot::default()
        };
        assert!(encode_board(&big, 1).is_none());
    }
}
