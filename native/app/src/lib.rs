//! The app's Rust code: what `App.tsx` imports from `herdr-desktop/native`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/herdr-desktop/native.d.ts`.

use nsh_core::prelude::*;

pub mod feed;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("herdr-desktop/native")]
fn native(registry: &mut Registry) {
    registry.module::<Herdr>();
}

/// Everything the app knows about herdr: machines, agents, panes.
#[module]
pub struct Herdr;

#[module]
impl Herdr {
    /// The version of the Rust core.
    pub fn core_version() -> String {
        herdr_core::version().to_owned()
    }
}
