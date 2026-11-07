//! Who is listening for "something changed". One per process; the engine's forwarder calls
//! [`notify`] and every `Herdr.onChange` subscriber's task wakes and posts the revision to TSX.

use std::sync::atomic::{AtomicU64, Ordering};

use async_channel::{Receiver, Sender};
use parking_lot::Mutex;

static SUBSCRIBERS: Mutex<Vec<(u64, Sender<()>)>> = Mutex::new(Vec::new());
static NEXT: AtomicU64 = AtomicU64::new(1);

/// A new subscriber: its id (for [`unsubscribe`]) and the channel that wakes it. The channel holds at
/// most one wake-up, so any number of ticks while the UI is busy cost it one pull.
pub(super) fn subscribe() -> (u64, Receiver<()>) {
    let (tx, rx) = async_channel::bounded(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    SUBSCRIBERS.lock().push((id, tx));
    (id, rx)
}

/// Drops a subscriber; its task ends because its channel closes.
pub(super) fn unsubscribe(id: u64) {
    SUBSCRIBERS.lock().retain(|(i, _)| *i != id);
}

/// Wakes every subscriber. Never blocks: a full channel already has a wake-up waiting.
pub(super) fn notify() {
    SUBSCRIBERS.lock().retain(|(_, tx)| match tx.try_send(()) {
        Ok(()) | Err(async_channel::TrySendError::Full(())) => true,
        Err(async_channel::TrySendError::Closed(())) => false,
    });
}
