//! What `Herdr.worktrees` and `Herdr.createWorktree` hand to TSX: plain values, no herdr JSON.

use herdr_core::worktree::{Problem, Worktree, WorktreeError, WorktreeList};
use nsh_core::prelude::*;

/// One checkout of a repository, as `worktree.list` reports it.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CheckoutView {
    /// Its folder.
    pub path: String,
    /// What a person calls it: the folder's name.
    pub name: String,
    /// The branch checked out; absent when detached.
    #[prop(skip_none)]
    pub branch: Option<String>,
    /// A linked worktree, not the repository's main checkout.
    pub linked: bool,
    /// herdr has it open as a workspace.
    pub open: bool,
}

impl From<&Worktree> for CheckoutView {
    fn from(w: &Worktree) -> Self {
        Self {
            path: w.path.clone(),
            name: w
                .path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&w.label)
                .to_owned(),
            branch: w.branch.clone(),
            linked: w.is_linked,
            open: w.open_workspace_id.is_some(),
        }
    }
}

/// What a lookup found. It never throws: a folder that has no checkouts to offer is an answer (`state`), and the form
/// leaves the Checkout row out for every state but `found`.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct WorktreeLookup {
    /// `found`, `unsupported` (herdr without worktrees), `untrusted` (herdr does not trust the repository),
    /// `notRepo` (not a git folder) or `failed` (the machine did not answer; see `message`).
    pub state: String,
    /// Why, for any state but `found`.
    pub message: String,
    /// The repository's main folder.
    pub repo_root: String,
    /// Every checkout, main first.
    pub checkouts: Vec<CheckoutView>,
}

impl WorktreeLookup {
    pub(super) fn of(result: Result<WorktreeList, WorktreeError>) -> Self {
        match result {
            Ok(list) => Self {
                state: "found".to_owned(),
                message: String::new(),
                repo_root: list.repo_root,
                checkouts: list.worktrees.iter().map(Into::into).collect(),
            },
            Err(e) => Self {
                state: match e.problem {
                    Problem::Unsupported => "unsupported",
                    Problem::Untrusted => "untrusted",
                    Problem::NotARepo => "notRepo",
                    _ => "failed",
                }
                .to_owned(),
                message: e.explain(),
                repo_root: String::new(),
                checkouts: Vec::new(),
            },
        }
    }
}

/// The worktree `createWorktree` made.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct MadeWorktree {
    /// Its folder: where the agent starts.
    pub path: String,
    /// Its branch.
    #[prop(skip_none)]
    pub branch: Option<String>,
    /// The herdr workspace opened in it.
    pub workspace_id: String,
}
