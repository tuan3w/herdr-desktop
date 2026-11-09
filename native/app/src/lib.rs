//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.
//!
//! * [`engine`] keeps every machine's link, the persisted state and the pane watches, on its own threads.
//! * [`api`] is the `Herdr` module TSX calls: it pulls state after a tick and acts on it.
//! * [`compose`] is the `Compose` module: what a chat's message box needs (pictures, the file dialog, `@`).
//! * [`diagrams`] serves the bundled mermaid script to the web views that draw diagrams.
//! * [`feed`] is the seam between the engine and the pane screens it reads (the board's previews, the prompts).
//! * [`highlight`] reads code into coloured spans (tree-sitter, TextMate) and draws it: `CodeView`, `CodeDiff`, the `Code` module.
//! * [`pane_screen`] no longer draws anything in the app (the `PaneScreen` component is not registered: the terminal tab replaced it); its colour, segment and layout helpers are the `Terminal`'s. [`keys`] maps keystrokes to herdr key names.
//! * [`metrics`] is what the dev panel shows about the live pane path.
//! * [`files`] is the `Files` and `Pages` modules: the file browser, viewers, `Send a file` and tunnels to a machine's pages.
//! * [`media`] is the `Media` and `Lines` modules: the player's copies of other machines' files, codecs, hex peeks, archive lists and big text read by lines.
//! * [`notify`] tells the person, while the window is away, that an agent needs them (desktop notifications).
//! * [`search`] is the `Search` module: the command palette's ranking over a catalog frozen when it opens.
//! * [`git`] is the `Git` module: the files an agent changed in a checkout, their patches, revert and undo.
//! * [`fixture`] is the scripted herdr the tests run against.
//! * `preload_guard` (Linux, glibc) starts the process again without an `LD_PRELOAD` allocator that breaks GTK 4.22 (before `main`).
//! * `webkit_env` (Linux) turns off WebKitGTK's DMA-BUF renderer, which aborts the app on a GPU without GBM (before `main`).
//! * `gtk_theme` (Linux) names the current GTK theme in `GTK_THEME` when it is a resource that GTK 4.22 empties at start, which left the title bar bare (before `main`).

use nsh_core::prelude::*;

pub mod api;
pub mod compose;
pub mod diagrams;
pub mod engine;
pub mod feed;
pub mod files;
pub mod fixture;
pub mod git;
#[cfg(target_os = "linux")]
pub mod gtk_theme;
pub mod highlight;
pub mod media;
pub mod metrics;
pub mod notify;
pub mod pane_screen;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub mod preload_guard;
pub mod search;
pub mod terminal;
#[cfg(target_os = "linux")]
pub mod webkit_env;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    // Names the guards' constructors so that the linker keeps their object files.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    std::hint::black_box(&preload_guard::INIT);
    #[cfg(target_os = "linux")]
    std::hint::black_box(&gtk_theme::INIT);
    #[cfg(target_os = "linux")]
    std::hint::black_box(&webkit_env::INIT);
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
        .register::<terminal::Terminal>();
}
