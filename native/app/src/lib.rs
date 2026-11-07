//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.
//!
//! * [`engine`] keeps every machine's link, the persisted state and the pane watches, on its own threads.
//! * [`api`] is the `Herdr` module TSX calls: it pulls state after a tick and acts on it.
//! * [`diagrams`] serves the bundled mermaid script to the web views that draw diagrams.
//! * [`feed`] is the seam between the engine and `PaneScreen`.
//! * [`highlight`] reads code into coloured spans (tree-sitter, TextMate) and draws it: `CodeView`, `CodeDiff`, the `Code` module.
//! * [`pane_screen`] draws a pane's rows; [`keys`] maps keystrokes to herdr key names.
//! * [`metrics`] is what the dev panel shows about the live pane path.
//! * [`files`] is the `Files` and `Pages` modules: the file browser, viewers, `Send a file` and tunnels to a machine's pages.
//! * [`notify`] tells the person, while the window is away, that an agent needs them (desktop notifications).
//! * [`fixture`] is the scripted herdr the tests run against.
//! * `preload_guard` (Linux, glibc) starts the process again without an `LD_PRELOAD` allocator that breaks GTK 4.22 (before `main`).

use nsh_core::prelude::*;

pub mod api;
pub mod diagrams;
pub mod engine;
pub mod feed;
pub mod files;
pub mod fixture;
pub mod highlight;
pub mod keys;
pub mod metrics;
pub mod notify;
pub mod pane_screen;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub mod preload_guard;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    // Names the guard's constructor so that the linker keeps its object file.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    std::hint::black_box(&preload_guard::INIT);
    registry
        .module::<api::Herdr>()
        .module::<api::Sessions>()
        .module::<diagrams::Diagrams>()
        .module::<highlight::api::Code>()
        .module::<files::Files>()
        .module::<files::Pages>()
        .module::<keys::PaneKeys>()
        .register::<highlight::view::CodeDiff>()
        .register::<highlight::view::CodeView>()
        .register::<pane_screen::PaneScreen>();
}
