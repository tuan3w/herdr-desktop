//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.
//!
//! * [`engine`] keeps every machine's link, the persisted state and the pane watches, on its own threads.
//! * [`api`] is the `Herdr` module TSX calls: it pulls state after a tick and acts on it.
//! * [`diagrams`] serves the bundled mermaid script to the web views that draw diagrams.
//! * [`feed`] is the seam between the engine and `PaneScreen`.
//! * [`pane_screen`] draws a pane's rows; [`keys`] maps keystrokes to herdr key names.
//! * [`metrics`] is what the dev panel shows about the live pane path.
//! * [`files`] is the `Files` and `Pages` modules: the file browser, viewers, `Send a file` and tunnels to a machine's pages.
//! * [`notify`] tells the person, while the window is away, that an agent needs them (desktop notifications).
//! * [`fixture`] is the scripted herdr the tests run against.

use nsh_core::prelude::*;

pub mod api;
pub mod diagrams;
pub mod engine;
pub mod feed;
pub mod files;
pub mod fixture;
pub mod keys;
pub mod metrics;
pub mod notify;
pub mod pane_screen;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    registry
        .module::<api::Herdr>()
        .module::<api::Sessions>()
        .module::<diagrams::Diagrams>()
        .module::<files::Files>()
        .module::<files::Pages>()
        .module::<keys::PaneKeys>()
        .register::<pane_screen::PaneScreen>();
}
