//! What the notifier asks of the engine: which switches are on, which agents are worth telling about,
//! and the one way an answer reaches a pane.
//!
//! The settings are two keys of the settings file, written by the Notifications section of Settings:
//! [`NEEDS_YOU_KEY`] (`Notify me when an agent needs me`) and [`ALSO_DONE_KEY`] (`Also when an agent
//! finishes`). Both default to off.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Instant;

use herdr_core::board::Board;
use herdr_core::link::LinkState;
use herdr_core::schema::Snapshot;
use herdr_core::store::MachineId;

use super::{AnswerOutcome, Fleet, Job, stamp_of};
use crate::notify::{Item, Kind, Question, Sent, Settings, Source};

/// The setting that switches notifications on: `true` or `false`; off when never set.
pub const NEEDS_YOU_KEY: &str = "notify.needsYou";
/// The setting that adds finished agents to the notifications; only read while [`NEEDS_YOU_KEY`] is on.
pub const ALSO_DONE_KEY: &str = "notify.alsoDone";

/// The notifier's view of the engine. Holds the fleet weakly: the notifier thread must not keep a
/// stopped engine alive.
pub(super) struct FleetSource(pub Weak<Fleet>);

impl Source for FleetSource {
    fn settings(&self) -> Settings {
        self.0
            .upgrade()
            .map(|f| f.notify_settings())
            .unwrap_or_default()
    }

    fn items(&self) -> Vec<Item> {
        self.0
            .upgrade()
            .map(|f| f.alert_items())
            .unwrap_or_default()
    }

    fn answer(&self, machine: &str, pane: &str, digest: &str, index: usize) -> Sent {
        let Some(fleet) = self.0.upgrade() else {
            return Sent::No("The app is closing, so nothing was sent.".to_owned());
        };
        match fleet.answer(machine, pane, digest, index) {
            AnswerOutcome::Sent => Sent::Yes,
            AnswerOutcome::Changed => Sent::No(
                "The question changed, so nothing was sent. Open the agent to see it.".to_owned(),
            ),
            AnswerOutcome::NotBlocked => Sent::No(
                "The agent is not waiting for an answer any more, so nothing was sent.".to_owned(),
            ),
            AnswerOutcome::Failed(message) => {
                Sent::No(format!("Could not send the answer: {message}"))
            }
        }
    }
}

impl Fleet {
    /// The two notification switches.
    pub fn notify_settings(&self) -> Settings {
        let on = |key: &str| self.setting(key).and_then(|v| v.as_bool()).unwrap_or(false);
        Settings {
            needs_you: on(NEEDS_YOU_KEY),
            also_done: on(ALSO_DONE_KEY),
        }
    }

    /// The agents that are blocked, or finished and not looked at, in board order, with their questions.
    /// A blocked agent whose pane has not been read for this episode yet starts that read; when it lands
    /// the UI and the notifier are ticked and ask again.
    fn alert_items(&self) -> Vec<Item> {
        let now = Instant::now();
        let entries = self.entries();
        let inputs: Vec<(MachineId, Arc<Snapshot>, LinkState)> = entries
            .iter()
            .map(|(m, link)| (m.id.clone(), link.snapshot(), link.state()))
            .collect();
        let names: HashMap<&str, &str> = entries
            .iter()
            .map(|(m, _)| (m.id.as_str(), m.name.as_str()))
            .collect();
        let board = {
            let reviewed = self.reviewed.lock();
            let first_seen = self.first_seen.lock();
            // Sessions are answered in their own tab: a notification here would read a pane that is not there.
            Board::from(
                &inputs,
                herdr_core::board::BoardExtras::NONE,
                &reviewed,
                &first_seen,
                now,
            )
        };
        let mut items = Vec::new();
        for (kind, rows) in [
            (Kind::NeedsYou, &board.needs_you),
            (Kind::Finished, &board.to_review),
        ] {
            for row in rows {
                let machine_name = names.get(row.machine.as_str()).copied().unwrap_or("");
                let place = if row.agent.is_empty() {
                    machine_name.to_owned()
                } else {
                    format!("{} on {machine_name}", row.agent)
                };
                let question = match kind {
                    Kind::Finished => Question::Read(None),
                    Kind::NeedsYou if row.offline => Question::Unread,
                    Kind::NeedsYou => {
                        let stamp = stamp_of(row);
                        match self.previews.episode(&row.machine, &row.pane_id, stamp) {
                            Some(prompt) => Question::Read(prompt),
                            None => {
                                if self.previews.claim(&row.machine, &row.pane_id, stamp, now) {
                                    let _ = self.jobs.send(Job::Preview {
                                        machine: row.machine.clone(),
                                        pane: row.pane_id.clone(),
                                        stamp,
                                    });
                                }
                                Question::Unread
                            }
                        }
                    }
                };
                items.push(Item {
                    machine: row.machine.clone(),
                    pane: row.pane_id.clone(),
                    seq: row.state_change_seq,
                    kind,
                    reachable: !row.offline,
                    name: row.name.clone(),
                    place,
                    question,
                });
            }
        }
        items
    }
}
