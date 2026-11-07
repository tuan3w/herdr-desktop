//! Observed sessions: an agent that runs in a herdr pane (omp, Claude Code, Codex) shown as the same
//! chat an agent session is, without any setup.
//!
//! The transcript comes from the agent's own session log (herdr's snapshot names the file in
//! `agent_session`, or the agent's folder layout does), read through the keeper's `follow` and `blob`
//! commands over the machine's channel. The person's hand is the pane (`pane.send_input`, `pane.send_keys`),
//! checked against the log afterwards. The terminal stays one tap away. See [`model`] for what a mapper
//! produces and `docs/ARCHITECTURE.md` for the whole.

pub mod ask;
pub mod claude;
pub mod codex;
pub mod kinds;
pub mod locate;
pub mod model;
pub mod names;
pub mod omp;
pub mod session;
