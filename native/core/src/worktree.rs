//! Git worktrees through herdr's public API: `worktree.list` (the branch of every checkout of a repository)
//! and `worktree.create` (a new checkout on a new branch, opened as a herdr workspace).
//!
//! Shapes are `WorktreeListParams`, `WorktreeCreateParams` and the `worktree_list` / `worktree_created` results of
//! `docs/herdr-api.schema.json`. Everything goes through the machine's [`Wire`], remote machines included: nothing here
//! starts git or ssh. A branch name travels only as a JSON parameter, never as part of a command line, and is checked
//! against git's ref-name rules first ([`branch_error`]): a bad name is rejected with the reason, never quietly
//! sanitised. `trust_repository` is never sent: a repository herdr has not trusted comes back as
//! [`Problem::Untrusted`] for the person to act on in herdr, because trusting runs the repository's own hooks.

use std::time::Duration;

use serde_json::{Value, json};
use thiserror::Error;

use crate::wire::{ErrorKind, Wire, WireError};

/// Longest branch name accepted, in bytes (git's own limit is the file system's; this keeps a ref name readable).
pub const MAX_BRANCH_BYTES: usize = 200;

/// One checkout of a repository (`WorktreeInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    /// The branch checked out; `None` for a detached or bare checkout.
    pub branch: Option<String>,
    /// herdr's name for it (the folder's name).
    pub label: String,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_prunable: bool,
    /// A linked worktree, not the repository's main checkout.
    pub is_linked: bool,
    /// The herdr workspace that has it open, when one does.
    pub open_workspace_id: Option<String>,
}

/// What `worktree.list` answered: the repository and its checkouts, main first as herdr lists them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeList {
    pub repo_root: String,
    pub worktrees: Vec<Worktree>,
}

/// What `worktree.create` made: the checkout and the herdr workspace, tab and pane opened in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorktree {
    pub worktree: Worktree,
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
}

/// Why a worktree call failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    /// The branch name is not one git takes; nothing was sent.
    Invalid,
    /// This herdr has no `worktree.*` methods: it is older than worktrees.
    Unsupported,
    /// herdr has not trusted the repository. Never overridden by this app.
    Untrusted,
    /// The folder is not inside a git repository.
    NotARepo,
    /// herdr or git refused (the branch exists, the folder is taken, a hook failed); the message says why.
    Refused,
    /// The machine did not answer; trying again may work.
    Retryable,
    /// Retrying cannot help (host key, auth, missing herdr): the link shows `Attention`.
    Fatal,
}

/// A failed worktree call, classified (`AGENTS.md` principle 8).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct WorktreeError {
    pub problem: Problem,
    pub message: String,
}

impl WorktreeError {
    pub fn new(problem: Problem, message: impl Into<String>) -> Self {
        Self {
            problem,
            message: message.into(),
        }
    }

    /// What to show the person: herdr's sentence and what to do next. The words for [`Problem::Untrusted`] say that
    /// this app never trusts a repository for them, because trusting lets herdr run the repository's own hooks.
    pub fn explain(&self) -> String {
        match self.problem {
            Problem::Unsupported => {
                "This herdr can't make worktrees. Update herdr on that machine, or choose This folder.".to_owned()
            }
            Problem::Untrusted => "herdr does not trust this repository yet, so it won't make worktrees in it: that would \
                run the repository's own hooks. Open the repository in herdr on that machine and trust it there, then \
                try again. This app never trusts a repository for you."
                .to_owned(),
            Problem::NotARepo => "That folder is not inside a git repository.".to_owned(),
            Problem::Retryable => format!(
                "{} The worktree may exist anyway: look at Checkout again before you try twice.",
                self.message.trim_end()
            ),
            Problem::Invalid | Problem::Refused | Problem::Fatal => self.message.clone(),
        }
    }

    /// Trying the same call again can succeed.
    pub fn is_retryable(&self) -> bool {
        self.problem == Problem::Retryable
    }
}

/// Why `branch` cannot name a new branch, or `None` when it can. Git's `check-ref-format` rules for a branch: no
/// control characters or spaces, none of `~ ^ : ? * [ \`, no `..` or `@{`, no leading `-`, no leading or trailing `/` or
/// `.`, no `//`, no component starting with `.` or ending in `.lock`, not `@`. The answer is a sentence for the form.
pub fn branch_error(branch: &str) -> Option<&'static str> {
    if branch.is_empty() {
        return Some("Enter a branch name, or clear the field to let herdr name it.");
    }
    if branch.len() > MAX_BRANCH_BYTES {
        return Some("A branch name is at most 200 bytes.");
    }
    if branch.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Some("No spaces or control characters in a branch name.");
    }
    if branch.starts_with('-') {
        return Some("A branch name can't start with -.");
    }
    if branch.chars().any(|c| "~^:?*[\\".contains(c)) {
        return Some("A branch name can't contain ~ ^ : ? * [ or \\.");
    }
    if branch.contains("..") || branch.contains("@{") || branch == "@" {
        return Some("A branch name can't contain .. or @{.");
    }
    if branch.starts_with('/') || branch.ends_with('/') || branch.contains("//") {
        return Some("A branch name can't start or end with / or hold an empty part.");
    }
    if branch.ends_with('.') {
        return Some("A branch name can't end with a dot.");
    }
    if branch
        .split('/')
        .any(|part| part.starts_with('.') || part.ends_with(".lock"))
    {
        return Some("No part of a branch name may start with a dot or end in .lock.");
    }
    if !branch
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./+".contains(c))
    {
        return Some("Use letters, digits and - _ . / + in a branch name.");
    }
    None
}

/// The checkouts of the repository `cwd` is in, with the branch of each.
pub fn list(wire: &dyn Wire, cwd: &str, timeout: Duration) -> Result<WorktreeList, WorktreeError> {
    let result = wire
        .request("worktree.list", json!({"cwd": cwd}), timeout)
        .map_err(classify)?;
    let items = result
        .get("worktrees")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            WorktreeError::new(Problem::Refused, "herdr's answer listed no worktrees")
        })?;
    Ok(WorktreeList {
        repo_root: result
            .pointer("/source/repo_root")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        worktrees: items.iter().filter_map(parse_worktree).collect(),
    })
}

/// Makes a worktree for the repository `cwd` is in, on `branch` (herdr names the branch and the folder when `None`),
/// and has herdr open it as a workspace. Never focused, so the person's herdr screen does not move. An invalid
/// branch is refused here, before anything is sent.
pub fn create(
    wire: &dyn Wire,
    cwd: &str,
    branch: Option<&str>,
    timeout: Duration,
) -> Result<NewWorktree, WorktreeError> {
    let mut params = json!({"cwd": cwd, "focus": false});
    if let Some(branch) = branch {
        if let Some(why) = branch_error(branch) {
            return Err(WorktreeError::new(Problem::Invalid, why));
        }
        params["branch"] = json!(branch);
    }
    let result = wire
        .request("worktree.create", params, timeout)
        .map_err(classify)?;
    let made = |what: &str| {
        WorktreeError::new(
            Problem::Refused,
            format!("herdr made the worktree but did not name its {what}"),
        )
    };
    let worktree = result
        .get("worktree")
        .and_then(parse_worktree)
        .ok_or_else(|| made("folder"))?;
    let id = |pointer: &str, what: &str| {
        result
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| made(what))
    };
    Ok(NewWorktree {
        worktree,
        workspace_id: id("/workspace/workspace_id", "workspace")?,
        tab_id: id("/tab/tab_id", "tab")?,
        pane_id: id("/root_pane/pane_id", "pane")?,
    })
}

fn parse_worktree(value: &Value) -> Option<Worktree> {
    let path = value.get("path")?.as_str()?.to_owned();
    let flag = |name: &str| value.get(name).and_then(Value::as_bool).unwrap_or(false);
    let text = |name: &str| value.get(name).and_then(Value::as_str);
    Some(Worktree {
        label: text("label").unwrap_or_default().to_owned(),
        branch: text("branch").filter(|b| !b.is_empty()).map(str::to_owned),
        is_bare: flag("is_bare"),
        is_detached: flag("is_detached"),
        is_prunable: flag("is_prunable"),
        is_linked: flag("is_linked_worktree"),
        open_workspace_id: text("open_workspace_id").map(str::to_owned),
        path,
    })
}

/// herdr names no error codes for these cases in its schema, so the answer's code and words are read for them. An
/// answer that matches nothing is `Refused` with herdr's own sentence.
fn classify(error: WireError) -> WorktreeError {
    let WireError { kind, message } = error;
    match kind {
        ErrorKind::Retryable => WorktreeError::new(Problem::Retryable, message),
        ErrorKind::Fatal(_) => WorktreeError::new(Problem::Fatal, message),
        ErrorKind::Api { code } => {
            let said = format!("{code} {message}").to_lowercase();
            let problem = if code == "unknown_method" {
                Problem::Unsupported
            } else if said.contains("trust") {
                Problem::Untrusted
            } else if said.contains("not a git")
                || said.contains("git repo")
                || said.contains("not_a_repo")
            {
                Problem::NotARepo
            } else {
                Problem::Refused
            };
            WorktreeError::new(problem, message)
        }
    }
}
