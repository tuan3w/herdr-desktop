//! Projects: the repositories and folders the person's agents work in.
//!
//! A person thinks "the payments API", not "workspace 3 on the build box", so the board groups every
//! agent, terminal or chat, by the project it belongs to. [`Directory`] works that out for one machine
//! from what herdr reports; [`Project`] is the result the board lists.
//!
//! A project is named by, in order: the repository herdr knows the workspace is in (`repo_key`,
//! shared by the main checkout and every linked worktree), else the workspace's label, else the
//! folder the agent runs in. A chat session has no workspace: its folder is matched against the
//! checkouts and repository roots of the same machine, and a folder that matches none is a project
//! of its own. The same repository on two machines is two projects: a checkout is a place on one
//! machine.

use std::collections::HashMap;

use crate::board::{AgentRow, folder_name, real_path};
use crate::schema::Snapshot;
use crate::store::{LOCAL_ID, MachineId};

/// One checkout of a repository that has agents in it: the main one or a linked worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    /// The checkout's folder; what [`AgentRow::checkout`] names.
    pub path: String,
    /// The folder's own name (`checkout-flow-v2`), which is what a person calls a worktree.
    pub name: String,
    /// A linked worktree, not the repository's main checkout.
    pub linked: bool,
}

/// What the board shows for one project on one machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// Stable across refreshes and unique per machine: it is what a pin and a fold are saved under.
    pub key: String,
    /// What the person calls it: the repository's name, the workspace's label or the folder's name.
    pub name: String,
    /// The machine its checkouts are on.
    pub machine: MachineId,
    /// The person pinned it: pinned projects come first.
    pub pinned: bool,
    /// The checkouts that have agents, the main one first, then linked worktrees by name. Empty for
    /// a project that is only a label or a folder.
    pub checkouts: Vec<Checkout>,
    /// Its agents: the ones that need the person first, the rest newest first (see [`order_rows`]).
    pub rows: Vec<AgentRow>,
    /// Its machine is not connected: everything here is last known and dimmed.
    pub offline: bool,
    /// Agents blocked on the person (0 while offline).
    pub needs_you: usize,
    /// Finished and not reviewed (0 while offline).
    pub to_review: usize,
    /// Working (0 while offline).
    pub working: usize,
}

/// Where an agent belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Place {
    pub key: String,
    pub name: String,
    pub checkout: Option<Checkout>,
}

/// How one machine's folders and workspaces map to projects, built from its snapshot.
#[derive(Debug, Default)]
pub(crate) struct Directory {
    by_workspace: HashMap<String, Place>,
    /// Every checkout and repository root, longest path first so the deepest match wins.
    folders: Vec<(String, Place)>,
    machine: MachineId,
}

/// A folder as the machine's file system names it, for this computer; any other machine's come back as given, since
/// only that machine could resolve them. herdr reports a checkout by one path and a session log's cwd may use a link
/// to it (`/var` is `/private/var` on macOS): both go through this before they are compared.
fn named(machine: &MachineId, path: &str) -> String {
    if machine == LOCAL_ID {
        real_path(path)
    } else {
        path.to_owned()
    }
}

impl Directory {
    pub(crate) fn of(machine: &MachineId, snapshot: &Snapshot) -> Self {
        let mut dir = Directory {
            machine: machine.clone(),
            ..Directory::default()
        };
        for ws in &snapshot.workspaces {
            let place = match &ws.worktree {
                Some(wt) if !wt.repo_key.is_empty() => {
                    let checkout = (!wt.checkout_path.is_empty()).then(|| Checkout {
                        path: wt.checkout_path.clone(),
                        name: folder_name(Some(&wt.checkout_path)),
                        linked: wt.is_linked_worktree,
                    });
                    let name = [
                        wt.repo_name.as_str(),
                        folder_name(Some(&wt.repo_root)).as_str(),
                    ]
                    .into_iter()
                    .find(|n| !n.is_empty())
                    .unwrap_or("Repository")
                    .to_owned();
                    let place = Place {
                        key: format!("{machine}/repo:{}", wt.repo_key),
                        name,
                        checkout,
                    };
                    // The main checkout is matched by the repository root too: a chat started in a
                    // subfolder of it belongs to it.
                    if !wt.repo_root.is_empty() && !wt.is_linked_worktree {
                        dir.folders
                            .push((named(machine, &wt.repo_root), place.clone()));
                    }
                    if let Some(c) = &place.checkout {
                        dir.folders.push((named(machine, &c.path), place.clone()));
                    }
                    place
                }
                _ if !ws.label.trim().is_empty() => Place {
                    key: format!("{machine}/workspace:{}", ws.label.trim()),
                    name: ws.label.trim().to_owned(),
                    checkout: None,
                },
                _ => continue,
            };
            dir.by_workspace.insert(ws.workspace_id.clone(), place);
        }
        dir.folders
            .sort_by_key(|(root, _)| std::cmp::Reverse(root.len()));
        dir
    }

    /// The place of a terminal agent: its workspace's, else where its folder is, else its folder.
    pub(crate) fn place_of_agent(&self, workspace_id: &str, cwd: Option<&str>) -> Place {
        self.by_workspace
            .get(workspace_id)
            .cloned()
            .unwrap_or_else(|| self.place_of_folder(cwd))
    }

    /// The place of a folder: the deepest checkout or repository root that holds it, else a project
    /// named after the folder.
    pub(crate) fn place_of_folder(&self, cwd: Option<&str>) -> Place {
        if let Some(cwd) = cwd.filter(|c| !c.is_empty())
            && let cwd = named(&self.machine, cwd)
            && let Some((_, place)) = self.folders.iter().find(|(root, _)| within(&cwd, root))
        {
            // The deepest root wins, so a folder inside a linked worktree belongs to that worktree and
            // not to the main checkout whose root contains it.
            return place.clone();
        }
        let folder = folder_name(cwd);
        Place {
            key: format!("{}/folder:{}", self.machine, cwd.unwrap_or_default()),
            name: if folder.is_empty() {
                "No project".to_owned()
            } else {
                folder
            },
            checkout: None,
        }
    }
}

/// `path` is `root` or inside it (`/src/api/x` is inside `/src/api`, `/src/api-2` is not).
fn within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Orders one project's rows: agents that need the person first (longest waiting first), then the rest
/// newest state first. Attention leads because it is the one reason to look; recency follows because
/// what just changed is what a returning person wants next. A state change does move a row, but only
/// when the agent really did something, and never because a refresh arrived.
pub(crate) fn order_rows(rows: &mut [AgentRow], now: std::time::Instant) {
    use crate::board::{longest_waiting, newest_first};
    use crate::schema::AgentStatus;
    rows.sort_by(|a, b| {
        let waits = |r: &AgentRow| r.status == AgentStatus::Blocked && !r.offline;
        waits(b)
            .cmp(&waits(a))
            .then_with(|| a.offline.cmp(&b.offline))
            .then_with(|| {
                if waits(a) {
                    longest_waiting(a, b)
                } else {
                    newest_first(a, b, now)
                }
            })
    });
}

/// The checkouts of a project's rows: the main one first, then linked worktrees by name.
pub(crate) fn checkouts_of(found: Vec<Checkout>) -> Vec<Checkout> {
    let mut out: Vec<Checkout> = Vec::new();
    for c in found {
        if !out.iter().any(|o| o.path == c.path) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| {
        a.linked
            .cmp(&b.linked)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}
