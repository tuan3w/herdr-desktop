//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.
//!
//! * [`engine`] keeps every machine's link, the persisted state and the pane watches, on its own threads.
//! * [`api`] is the `Herdr` module TSX calls: it pulls state after a tick and acts on it.
//! * [`feed`] is the seam between the engine and `PaneScreen`.
//! * [`pane_screen`] draws a pane's rows; [`keys`] maps keystrokes to herdr key names.
//! * [`fixture`] is the scripted herdr the tests run against.

use nsh_core::prelude::*;

pub mod api;
pub mod engine;
pub mod feed;
pub mod fixture;
pub mod keys;
pub mod pane_screen;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    registry
        .module::<api::Herdr>()
        .module::<keys::PaneKeys>()
        .register::<pane_screen::PaneScreen>();
}
