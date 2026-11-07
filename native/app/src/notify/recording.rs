//! The sink of the test seam: what a scripted herdr's notifications do instead of reaching the
//! owner's desktop. An engine started with a fixture uses it, so no test ever posts a real notification.

use crossbeam_channel::Sender;
use parking_lot::Mutex;

use super::policy::{Notification, Target};
use super::{Input, Sink};

/// One notification as the recording sink saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedNotification {
    /// Our id of the notification.
    pub id: u64,
    /// The headline.
    pub title: String,
    /// The question, the command and where the agent runs.
    pub body: String,
    /// The words of the answer buttons.
    pub buttons: Vec<String>,
    /// Where a click goes.
    pub target: Target,
    /// Still on the desktop (not withdrawn).
    pub open: bool,
}

/// Remembers every notification shown and lets a test press them.
pub struct RecordingSink {
    log: Mutex<Vec<RecordedNotification>>,
    tx: Sender<Input>,
}

impl RecordingSink {
    /// A sink whose presses go to the notifier thread through `tx`.
    pub fn new(tx: Sender<Input>) -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            tx,
        }
    }

    /// Every notification shown so far, oldest first; one that was replaced shows its latest content.
    pub fn shown(&self) -> Vec<RecordedNotification> {
        self.log.lock().clone()
    }

    /// Presses notification `id`: its body (`default`) or its button `n` (`answer:n`).
    pub fn press(&self, id: u64, action: &str) {
        let _ = self.tx.send(Input::Pressed {
            id,
            action: action.to_owned(),
        });
    }
}

impl Sink for RecordingSink {
    fn show(&self, n: &Notification) -> Result<(), String> {
        let recorded = RecordedNotification {
            id: n.id,
            title: n.title.clone(),
            body: n.body.clone(),
            buttons: n.buttons.iter().map(|b| b.label.clone()).collect(),
            target: n.target.clone(),
            open: true,
        };
        let mut log = self.log.lock();
        match log.iter_mut().find(|r| r.id == n.id) {
            Some(slot) => *slot = recorded,
            None => log.push(recorded),
        }
        Ok(())
    }

    fn close(&self, id: u64) {
        if let Some(r) = self.log.lock().iter_mut().find(|r| r.id == id) {
            r.open = false;
        }
    }
}
