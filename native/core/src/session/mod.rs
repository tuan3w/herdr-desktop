//! Agent sessions: chats with an ACP agent (omp, Claude Code, Codex, pi) that a keeper process owns on
//! some machine, so the agent outlives the window and the ssh connection.
//!
//! * [`KeeperHost`] runs the keeper's commands on a machine (this computer, or another over the shared
//!   ssh connection): `probe`, `list`, `start`, `attach`, `kill`, `history`.
//! * [`SessionHandle`] is one attached session: a thread that owns the connection and herdr-mobile's pure
//!   session reducer, and publishes immutable [`SessionSnapshot`]s.
//! * [`SessionHub`] holds the hosts, the listings, the attached sessions and the keepers this app
//!   started, and feeds [`SessionRow`](crate::board::SessionRow)s to the board.
//!
//! `adapter` is the only file that uses herdr-mobile's session code (the `vendored` reducer and `acp`);
//! see `docs/ARCHITECTURE.md`.

pub(crate) mod adapter;
mod error;
mod host;
mod hub;
mod lines;
mod outgoing;
mod records;
mod thread;
mod types;
#[rustfmt::skip]
mod vendored;

pub use error::{KeeperError, Refusal, exit};
pub(crate) use host::Attach;
pub use host::{KeeperHost, local_script_path, valid_id};
pub use hub::{HubConfig, MAX_ATTACHED, MAX_OBSERVED, OwnedSink, SessionHub};
pub(crate) use lines::AttachLines;
pub use outgoing::{Caps, EMBED_MAX, Outgoing, Pasted};
pub use records::{KeeperInfo, KeeperState, PastSession, PastSessions, Route};
pub use thread::{SendOutcome, SessionHandle, Unqueued};
pub use types::*;
