//! `herdr-core`: everything the desktop app knows about herdr that does not need a window.
//!
//! Pure Rust, no nsh dependency, tested with `cargo test` alone. See `docs/ARCHITECTURE.md`.

pub mod board;
pub mod files;
pub mod link;
pub mod observed;
pub mod project;
pub mod prompt;
pub mod schema;
pub mod screen;
pub mod session;
pub mod ssh;
pub mod store;
pub mod testing;
pub mod wire;

/// The version of this crate.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
