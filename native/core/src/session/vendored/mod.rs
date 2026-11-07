//! herdr-mobile's pure session reducer, copied (see `UPSTREAM` and `scripts/sync-vendored.sh`).
//!
//! `session` (events and the time in, effects out), `transcript` (the conversation, bounded),
//! `queue`, `risk` (how risky a session mode is), `attach` (files and pictures in a prompt),
//! `question` (an agent's form and the walk through it), `diff`, `elapsed` and `width` are
//! `herdr-tui`'s own files with `crate::` rewritten and a small patch. `text` and `mod.rs` are ours.
//! Only `adapter.rs` uses this module; nothing here is edited by hand.
//!
//! It is copied, not depended on, because the `herdr-tui` crate drags in ratatui and syntect with
//! `regex-onig`, which breaks nsh-base's own syntect (`docs/ARCHITECTURE.md`).

// Upstream's lints and layout are its own; its API is wider than the adapter uses.
#![allow(dead_code, unused_imports, clippy::all)]

pub mod acp;
pub mod attach;
pub mod diff;
pub mod elapsed;
pub mod question;
pub mod queue;
pub mod risk;
pub mod session;
pub mod text;
pub mod transcript;
pub mod width;

/// What this client calls itself in `initialize` (`clientInfo.name`).
pub const CLIENT_NAME: &str = "herdr-desktop";

/// This client's version in `initialize`.
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// What the person's other clients see this one called (`Desktop on dev-box`): the computer's name up to
/// the first dot.
pub fn client_title() -> String {
    let raw = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    let short = text::one_line(raw.trim().split('.').next().unwrap_or(""), 64);
    if short.is_empty() {
        "Desktop".to_owned()
    } else {
        format!("Desktop on {short}")
    }
}

/// The keeper (python3, one file shared with the phone app) with its agent table filled in.
pub const KEEPER_SCRIPT: &str = include_str!("keeper.py");

/// The agents the keeper can start (`routes.json`).
pub const ROUTES: &str = include_str!("routes.json");
