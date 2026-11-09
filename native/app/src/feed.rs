//! The seam between the engine (which reads panes from herdr) and `PaneScreen` (which draws them).
//!
//! `PaneScreen` never sees herdr: it asks for a [`PaneFeed`] by machine and pane, draws the rows of the
//! current [`Screen`], and redraws when the feed says it changed. The engine implements [`FeedProvider`]
//! (watching a pane means reading it when herdr says its revision moved, at most 20 times a second) and
//! installs it with [`set_provider`]; tests install a fake one. Rows are shared `Arc`s: a row whose `Arc`
//! did not change since the last draw needs no rebinding.

use std::sync::{Arc, RwLock};

use async_channel::Receiver;
use herdr_core::screen::Screen;

/// Which part of the pane a view shows. `Visible` is the live screen, `Recent` the scrollback (up to 1000
/// rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaneSource {
    Visible,
    Recent,
}

/// How trustworthy what a feed shows is right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedState {
    /// Reads are succeeding.
    Live,
    /// Reads stopped (the machine is offline or a read failed): the text is the last one and is shown dimmed
    /// with a notice, never as if it were current.
    Stale,
    /// The pane no longer exists.
    Gone,
    /// herdr lists the pane but could not bring it back after a restart (`restore_error`): it answers
    /// `pane_not_found` to every read, so nothing is read until herdr runs it again, and the view says why
    /// instead of showing an empty screen (herdr-mobile does the same, `docs/PARITY.md`).
    Unrestored,
}

/// One watched pane. Dropping it stops the watch (the engine stops reading a pane nobody watches).
pub trait PaneFeed: Send + Sync {
    /// The latest screen: empty before the first read. Cheap (an `Arc` clone).
    fn screen(&self) -> Arc<Screen>;

    /// Whether the screen can be trusted.
    fn state(&self) -> FeedState;

    /// The question the agent in this pane is blocked on, `None` when it is not blocked. The mirror shows a
    /// `Needs you` pill with it when the person scrolled away from the end.
    fn attention(&self) -> Option<String>;

    /// Fires (coalesced: at most one pending message) whenever `screen`, `state` or `attention` changed.
    fn changed(&self) -> Receiver<()>;

    /// When herdr first reported the activity that the current screen shows, for the read-to-paint metric
    /// (`crate::metrics`); `None` when the screen came from a read nobody's activity asked for.
    fn activity_at(&self) -> Option<std::time::Instant> {
        None
    }
}

/// Opens feeds. The engine implements it.
pub trait FeedProvider: Send + Sync {
    /// Starts watching `pane` of `machine`; `None` when the machine is unknown.
    fn open(&self, machine: &str, pane: &str, source: PaneSource) -> Option<Box<dyn PaneFeed>>;
}

static PROVIDER: RwLock<Option<Arc<dyn FeedProvider>>> = RwLock::new(None);

/// Installs the provider every `PaneScreen` uses, replacing the previous one.
pub fn set_provider(provider: Arc<dyn FeedProvider>) {
    *PROVIDER.write().unwrap_or_else(|e| e.into_inner()) = Some(provider);
}

/// Opens a feed through the installed provider; `None` without one or for an unknown machine.
pub fn open(machine: &str, pane: &str, source: PaneSource) -> Option<Box<dyn PaneFeed>> {
    let provider = PROVIDER.read().unwrap_or_else(|e| e.into_inner()).clone()?;
    provider.open(machine, pane, source)
}
