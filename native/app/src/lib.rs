//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.
//!
//! * [`engine`] keeps every machine's link, the persisted state and the pane watches, on its own threads.
//! * [`api`] is the `Herdr` module TSX calls: it pulls state after a tick and acts on it.
//! * [`compose`] is the `Compose` module: what a chat's message box needs (pictures, the file dialog, `@`).
//! * [`diagrams`] serves the bundled mermaid script to the web views that draw diagrams.
//! * [`feed`] is the seam between the engine and `PaneScreen`.
//! * [`highlight`] reads code into coloured spans (tree-sitter, TextMate) and draws it: `CodeView`, `CodeDiff`, the `Code` module.
//! * [`pane_screen`] draws a pane's rows; [`keys`] maps keystrokes to herdr key names.
//! * [`metrics`] is what the dev panel shows about the live pane path.
//! * [`files`] is the `Files` and `Pages` modules: the file browser, viewers, `Send a file` and tunnels to a machine's pages.
//! * [`media`] is the `Media` and `Lines` modules: the player's copies of other machines' files, codecs, hex peeks, archive lists and big text read by lines.
//! * [`notify`] tells the person, while the window is away, that an agent needs them (desktop notifications).
//! * [`search`] is the `Search` module: the command palette's ranking over a catalog frozen when it opens.
//! * [`git`] is the `Git` module: the files an agent changed in a checkout, their patches, revert and undo.
//! * [`fixture`] is the scripted herdr the tests run against.
//! * `preload_guard` (Linux, glibc) starts the process again without an `LD_PRELOAD` allocator that breaks GTK 4.22 (before `main`).

use nsh_core::prelude::*;

pub mod api;
pub mod compose;
pub mod diagrams;
pub mod engine;
pub mod feed;
pub mod files;
pub mod fixture;
pub mod git;
pub mod highlight;
pub mod media;
pub mod metrics;
pub mod notify;
pub mod pane_screen;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub mod preload_guard;
pub mod search;
pub mod terminal;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    // Names the guard's constructor so that the linker keeps its object file.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    std::hint::black_box(&preload_guard::INIT);
    registry
        .module::<api::Herdr>()
        .module::<api::Sessions>()
        .module::<compose::Compose>()
        .module::<diagrams::Diagrams>()
        .module::<highlight::api::Code>()
        .module::<files::Files>()
        .module::<files::Pages>()
        .module::<git::Git>()
        .module::<media::Lines>()
        .module::<media::Media>()
        .module::<search::Search>()
        .register::<highlight::view::CodeDiff>()
        .register::<highlight::view::CodeView>()
        .register::<pane_screen::PaneScreen>()
        .register::<terminal::Terminal>();
}
