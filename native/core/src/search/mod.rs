//! Search for the command palette: what the person typed, ranked against what exists (agents, projects, commands, machines,
//! settings, themes, messages), the same way every time.
//!
//! The index is built once when the palette opens ([`Index::new`]) from a frozen copy of the board, the recents' frecency
//! and the commands, so what a query returns never reorders while the palette is open. Files have their own walker and
//! reuse [`Scorer`]. Nothing here knows about nsh or about herdr's wire; `native/app/src/search` builds the items.

mod catalog;
mod fold;
mod frecency;
mod index;
mod matcher;
mod query;
mod typo;

pub use catalog::{
    AgentSrc, Answer, Catalog, CommandKind, CommandSrc, Entry, MachineSrc, ProjectSrc, Query, Row,
    Scope, Sources, Status, Suggest, View, utf16_pairs,
};
pub use fold::{Folded, fold, fold_char, fold_text};
pub use frecency::{boost, frecency, half_life_days};
pub use index::{Field, Hit, Index, Item, Mode, Page, Request, TYPO_BELOW};
pub use matcher::{Haystack, Needle, Scorer, runs};
pub use query::{Filter, IS_VALUES, Parsed, parse};
pub use typo::within_one;

/// What a result is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Agent = 0,
    Project,
    Command,
    Machine,
    Setting,
    Theme,
    File,
    Message,
}

impl Kind {
    pub const COUNT: usize = 8;
}

/// A set of kinds: what a scope searches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSet(u8);

impl KindSet {
    pub fn of(kinds: &[Kind]) -> Self {
        Self(kinds.iter().fold(0, |m, k| m | 1 << *k as u8))
    }

    pub fn has(self, kind: Kind) -> bool {
        self.0 & (1 << kind as u8) != 0
    }
}

/// Where the person is: items of the focused project and machine rank a little higher.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Focus {
    pub project: Option<String>,
    pub machine: Option<String>,
}
