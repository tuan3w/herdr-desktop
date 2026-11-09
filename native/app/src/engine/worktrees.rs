//! Worktrees: the branch of every checkout of a project, and a new worktree on a new branch. Both go through the
//! machine's herdr (`herdr_core::worktree`), remote machines included; nothing here starts git or ssh.
//!
//! The branches of the checkouts are kept per machine and folder so the board can name a checkout by its branch: the
//! snapshot has none. They are only what `worktree.list` last answered; a branch switched by hand in a checkout shows
//! after the next lookup.

use herdr_core::worktree::{self, NewWorktree, Problem, WorktreeError, WorktreeList};

use super::{Fleet, Note, REQUEST_TIMEOUT, unknown};

impl Fleet {
    /// The checkouts of the repository `cwd` is in, with their branches (remembered for the board).
    pub fn worktrees(&self, machine: &str, cwd: &str) -> Result<WorktreeList, WorktreeError> {
        let link = self
            .link(machine)
            .ok_or_else(|| WorktreeError::new(Problem::Refused, unknown(machine)))?;
        let list = worktree::list(link.wire().as_ref(), cwd, REQUEST_TIMEOUT)?;
        self.remember_branches(machine, &list);
        Ok(list)
    }

    /// Makes a worktree on `branch` (herdr names it when `None`) and opens it in herdr as a workspace. The branch is
    /// checked here first and travels only as a parameter; `trust_repository` is never sent.
    pub fn create_worktree(
        &self,
        machine: &str,
        cwd: &str,
        branch: Option<&str>,
    ) -> Result<NewWorktree, WorktreeError> {
        let link = self
            .link(machine)
            .ok_or_else(|| WorktreeError::new(Problem::Refused, unknown(machine)))?;
        let made = worktree::create(link.wire().as_ref(), cwd, branch, REQUEST_TIMEOUT);
        // A new workspace appeared: read the snapshot soon, as every mutating call does.
        link.refresh();
        let made = made?;
        if let Some(name) = &made.worktree.branch {
            self.branches.lock().insert(
                (machine.to_owned(), made.worktree.path.clone()),
                name.clone(),
            );
            let _ = self.notes.send(Note::Bump);
        }
        Ok(made)
    }

    /// Has herdr remove the worktree that is open as workspace `workspace_id`, and close that workspace. herdr is
    /// never told to force it: a worktree with changes is refused, and herdr says why.
    pub fn remove_worktree(&self, machine: &str, workspace_id: &str) -> Result<(), String> {
        let link = self.link(machine).ok_or_else(|| unknown(machine))?;
        let removed = worktree::remove(link.wire().as_ref(), workspace_id, REQUEST_TIMEOUT);
        // The workspace may be gone, or still there: read the snapshot soon either way.
        link.refresh();
        removed.map_err(|err| match err.problem {
            Problem::Unsupported => {
                "This herdr can't remove worktrees. Update herdr on that machine.".to_owned()
            }
            Problem::Retryable => format!(
                "{} The worktree may be gone anyway: look again before you try twice.",
                err.message.trim_end()
            ),
            _ => err.explain(),
        })
    }

    /// The branch `worktree.list` last gave the checkout at `path` on `machine`.
    pub(super) fn branch_of(&self, machine: &str, path: &str) -> Option<String> {
        self.branches
            .lock()
            .get(&(machine.to_owned(), path.to_owned()))
            .cloned()
    }

    fn remember_branches(&self, machine: &str, list: &WorktreeList) {
        let changed = {
            let mut known = self.branches.lock();
            let mut changed = false;
            for w in &list.worktrees {
                let key = (machine.to_owned(), w.path.clone());
                changed |= match &w.branch {
                    Some(b) => known.insert(key, b.clone()).as_ref() != Some(b),
                    None => known.remove(&key).is_some(),
                };
            }
            changed
        };
        if changed {
            let _ = self.notes.send(Note::Bump);
        }
    }
}
