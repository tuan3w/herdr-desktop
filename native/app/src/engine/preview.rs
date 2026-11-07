//! What a board card shows of a pane: its last rows and, while its agent is blocked, the question.
//!
//! A pane is read for this only when its agent's state changes (a new episode), never on every output
//! burst: a card is a glance, and 26 busy agents would otherwise cost 26 reads per tick. The answer is
//! cached per episode. A question is only ever shown for the exact episode it was read in, so a card
//! never offers answers to a question that has since been answered.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use herdr_core::prompt::{PromptInfo, detect, is_dashed_rule, preview_rows};
use herdr_core::schema::AgentStatus;
use herdr_core::wire::{Wire, WireError};
use parking_lot::Mutex;
use serde_json::json;

/// Rows requested from a pane to find its question: what herdr-mobile reads.
pub(super) const READ_LINES: u32 = 24;

/// Rows a card shows.
const SHOWN_ROWS: usize = 8;

/// The longest row kept; longer ones are cut.
const MAX_ROW: usize = 160;

/// Reads in flight at once; the rest wait for the next pull, which the finished reads cause.
const MAX_PENDING: usize = 32;

/// How long a failed read waits before the next pull may ask again.
const RETRY_AFTER: Duration = Duration::from_secs(5);

/// One episode of one agent: what a preview was read for.
pub(super) type Stamp = (AgentStatus, u64);

/// What a card shows of a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    /// The last rows, oldest first, without rules.
    pub rows: Vec<String>,
    /// The question, only when the preview was read in the episode that is current now and its agent is
    /// blocked.
    pub prompt: Option<PromptInfo>,
}

struct Slot {
    rows: Vec<String>,
    prompt: Option<PromptInfo>,
    /// The episode `rows` and `prompt` belong to.
    read_for: Option<Stamp>,
    requested: Option<Stamp>,
    failed_at: Option<Instant>,
}

/// The cache, keyed by machine and pane.
#[derive(Default)]
pub(super) struct Previews {
    slots: Mutex<HashMap<(String, String), Slot>>,
}

impl Previews {
    /// The preview of the episode `stamp`: its rows with the question when it was read for exactly this
    /// episode, or the rows of an earlier episode alone while the new read is on its way. `None` before
    /// the first read.
    pub(super) fn view(&self, machine: &str, pane: &str, stamp: Stamp) -> Option<Preview> {
        let slots = self.slots.lock();
        let slot = slots.get(&(machine.to_owned(), pane.to_owned()))?;
        slot.read_for?;
        Some(Preview {
            rows: slot.rows.clone(),
            prompt: if slot.read_for == Some(stamp) {
                slot.prompt.clone()
            } else {
                None
            },
        })
    }

    /// The question of the episode `stamp` if one was read for it.
    pub(super) fn prompt(&self, machine: &str, pane: &str, stamp: Stamp) -> Option<PromptInfo> {
        let slots = self.slots.lock();
        let slot = slots.get(&(machine.to_owned(), pane.to_owned()))?;
        (slot.read_for == Some(stamp))
            .then(|| slot.prompt.clone())
            .flatten()
    }

    /// Whether the caller should start a read for `stamp` now; when true the read counts as requested.
    pub(super) fn claim(&self, machine: &str, pane: &str, stamp: Stamp, now: Instant) -> bool {
        let mut slots = self.slots.lock();
        let pending = slots.values().filter(|s| s.requested.is_some()).count();
        let slot = slots
            .entry((machine.to_owned(), pane.to_owned()))
            .or_insert_with(|| Slot {
                rows: Vec::new(),
                prompt: None,
                read_for: None,
                requested: None,
                failed_at: None,
            });
        if slot.read_for == Some(stamp)
            || slot.requested.is_some()
            || pending >= MAX_PENDING
            || slot
                .failed_at
                .is_some_and(|t| now.saturating_duration_since(t) < RETRY_AFTER)
        {
            return false;
        }
        slot.requested = Some(stamp);
        true
    }

    /// Stores what a read found for `stamp`. True when what a card shows changed.
    pub(super) fn store(&self, machine: &str, pane: &str, stamp: Stamp, read: Read) -> bool {
        let mut slots = self.slots.lock();
        let Some(slot) = slots.get_mut(&(machine.to_owned(), pane.to_owned())) else {
            return false;
        };
        slot.requested = None;
        slot.failed_at = None;
        let changed =
            slot.read_for != Some(stamp) || slot.rows != read.rows || slot.prompt != read.prompt;
        slot.rows = read.rows;
        slot.prompt = read.prompt;
        slot.read_for = Some(stamp);
        changed
    }

    /// A read failed: keep what there is and try again after a pause.
    pub(super) fn fail(&self, machine: &str, pane: &str, now: Instant) {
        if let Some(slot) = self
            .slots
            .lock()
            .get_mut(&(machine.to_owned(), pane.to_owned()))
        {
            slot.requested = None;
            slot.failed_at = Some(now);
        }
    }

    /// Forgets the panes of `machine` that `keep` does not name.
    pub(super) fn retain(&self, machine: &str, keep: impl Fn(&str) -> bool) {
        self.slots
            .lock()
            .retain(|(m, pane), _| m != machine || keep(pane));
    }

    /// Forgets everything of a machine that was removed.
    pub(super) fn forget_machine(&self, machine: &str) {
        self.slots.lock().retain(|(m, _), _| m != machine);
    }
}

/// What one read of a pane found.
pub(super) struct Read {
    rows: Vec<String>,
    prompt: Option<PromptInfo>,
}

/// The rows of a pane as [`detect`] reads them: the last [`READ_LINES`], cleaned.
///
/// This one read serves the cards and the answer path alike, so the question a person saw and the one an
/// answer is checked against are always found the same way.
pub(super) fn read_rows(
    wire: &dyn Wire,
    pane: &str,
    timeout: Duration,
) -> Result<Vec<String>, WireError> {
    let result = wire.request(
        "pane.read",
        json!({"pane_id": pane, "source": "recent", "format": "text", "lines": READ_LINES, "strip_ansi": true}),
        timeout,
    )?;
    let text = result
        .pointer("/read/text")
        .and_then(|t| t.as_str())
        .ok_or_else(|| WireError::retryable("herdr's pane.read answer has no text"))?;
    Ok(preview_rows(text, MAX_ROW, READ_LINES as usize))
}

/// What a card keeps of `rows`: the last few without rules, and the question when `blocked`.
pub(super) fn read_of(rows: Vec<String>, blocked: bool) -> Read {
    let prompt = if blocked { detect(&rows) } else { None };
    let content: Vec<String> = rows.into_iter().filter(|r| !is_dashed_rule(r)).collect();
    let skip = content.len().saturating_sub(SHOWN_ROWS);
    Read {
        rows: content[skip..].to_vec(),
        prompt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(status: AgentStatus, seq: u64) -> Stamp {
        (status, seq)
    }

    fn read(rows: &[&str]) -> Read {
        read_of(rows.iter().map(|r| (*r).to_owned()).collect(), false)
    }

    #[test]
    fn a_question_is_never_shown_for_another_episode() {
        let previews = Previews::default();
        let now = Instant::now();
        let blocked = stamp(AgentStatus::Blocked, 4);
        assert!(previews.claim("m", "p", blocked, now));
        let rows: Vec<String> = ["Run it?", "❯ 1. Yes", "  2. No"]
            .map(String::from)
            .to_vec();
        previews.store("m", "p", blocked, read_of(rows, true));
        assert!(previews.view("m", "p", blocked).unwrap().prompt.is_some());
        // The agent was answered: same pane, new episode. The old rows may stay for a moment, the
        // question must not.
        let working = stamp(AgentStatus::Working, 5);
        let view = previews.view("m", "p", working).unwrap();
        assert!(view.prompt.is_none());
        assert!(!view.rows.is_empty());
    }

    #[test]
    fn a_read_is_asked_for_once_per_episode_and_a_failure_waits() {
        let previews = Previews::default();
        let now = Instant::now();
        let s = stamp(AgentStatus::Working, 1);
        assert!(previews.claim("m", "p", s, now));
        assert!(!previews.claim("m", "p", s, now), "already on its way");
        previews.fail("m", "p", now);
        assert!(
            !previews.claim("m", "p", s, now + Duration::from_secs(1)),
            "too soon after a failure"
        );
        assert!(previews.claim("m", "p", s, now + RETRY_AFTER));
        previews.store("m", "p", s, read(&["a"]));
        assert!(
            !previews.claim("m", "p", s, now + RETRY_AFTER),
            "the episode is cached"
        );
        assert!(previews.claim("m", "p", stamp(AgentStatus::Done, 2), now + RETRY_AFTER));
    }

    #[test]
    fn a_card_keeps_the_last_rows_without_rules() {
        let rows: Vec<&str> = vec![
            "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        ];
        let kept = read(&rows).rows;
        assert_eq!(
            kept,
            [
                "three", "four", "five", "six", "seven", "eight", "nine", "ten"
            ]
        );
    }

    #[test]
    fn at_most_so_many_reads_are_in_flight() {
        let previews = Previews::default();
        let now = Instant::now();
        let s = stamp(AgentStatus::Working, 1);
        let started = (0..100)
            .filter(|i| previews.claim("m", &format!("p{i}"), s, now))
            .count();
        assert_eq!(started, MAX_PENDING);
    }
}
