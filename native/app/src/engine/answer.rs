//! Answering a blocked agent. The one place an answer reaches a pane.
//!
//! Nothing is approved on trust: the pane is read again, the question found in it must be the one the
//! person saw (same digest), the agent must still be blocked, and the option must still exist. Any doubt
//! sends nothing. A send is never retried: a second `1` + `enter` could answer the next question.

use herdr_core::link::LinkState;
use herdr_core::prompt::detect;
use herdr_core::schema::AgentStatus;
use herdr_core::wire::ErrorKind;
use serde_json::json;

use super::preview::read_rows;
use super::{Fleet, REQUEST_TIMEOUT, unknown};

/// How an answer ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerOutcome {
    /// The option's keys went to the pane.
    Sent,
    /// The pane no longer asks this question (or asks it differently, or has no such option): nothing
    /// was sent.
    Changed,
    /// The agent is not blocked any more (the question was answered elsewhere): nothing was sent.
    NotBlocked,
    /// The machine could not be reached or herdr refused: nothing was sent, or the send failed; the
    /// message says what happened.
    Failed(String),
}

impl Fleet {
    /// Sends option `index` of the question whose fingerprint is `digest` to `pane`, if that question is
    /// still what the pane shows.
    pub fn answer(&self, machine: &str, pane: &str, digest: &str, index: usize) -> AnswerOutcome {
        if self.link(machine).is_none() {
            return AnswerOutcome::Failed(unknown(machine));
        }
        let key = (machine.to_owned(), pane.to_owned());
        // Pressed twice, or two views answering one agent: the second does nothing.
        if !self.answering.lock().insert(key.clone()) {
            return AnswerOutcome::Failed(
                "An answer for this agent is already being sent".to_owned(),
            );
        }
        let outcome = self.answer_checked(machine, pane, digest, index);
        self.answering.lock().remove(&key);
        outcome
    }

    fn answer_checked(
        &self,
        machine: &str,
        pane: &str,
        digest: &str,
        index: usize,
    ) -> AnswerOutcome {
        let Some(link) = self.link(machine) else {
            return AnswerOutcome::Failed(unknown(machine));
        };
        if link.state() != LinkState::Online {
            return AnswerOutcome::Failed(
                "This machine is not connected, so nothing was sent".to_owned(),
            );
        }
        let wire = link.wire();
        let failed = |e: herdr_core::wire::WireError| match &e.kind {
            // The pane was closed in the meantime: the question is gone.
            ErrorKind::Api { code } if code.ends_with("_not_found") => AnswerOutcome::Changed,
            _ => AnswerOutcome::Failed(e.message),
        };

        let rows = match read_rows(&*wire, pane, REQUEST_TIMEOUT) {
            Ok(rows) => rows,
            Err(e) => return failed(e),
        };
        // The agent's state as herdr has it right now, not as the last snapshot had it.
        let status = match wire.request("pane.get", json!({"pane_id": pane}), REQUEST_TIMEOUT) {
            Ok(result) => result
                .pointer("/pane/agent_status")
                .and_then(|s| serde_json::from_value::<AgentStatus>(s.clone()).ok())
                .unwrap_or_default(),
            Err(e) => return failed(e),
        };
        if status != AgentStatus::Blocked {
            return AnswerOutcome::NotBlocked;
        }
        let Some(prompt) = detect(&rows) else {
            return AnswerOutcome::Changed;
        };
        if prompt.digest != digest {
            return AnswerOutcome::Changed;
        }
        let Some(option) = prompt.options.get(index) else {
            return AnswerOutcome::Changed;
        };
        if option.keys.is_empty() {
            return AnswerOutcome::Failed("This option has no keys to send".to_owned());
        }
        match wire.request(
            "pane.send_keys",
            json!({"pane_id": pane, "keys": option.keys}),
            REQUEST_TIMEOUT,
        ) {
            Ok(_) => {
                // The agent will say it is working now; do not wait for the poll to show it.
                link.refresh();
                AnswerOutcome::Sent
            }
            Err(e) => failed(e),
        }
    }
}
