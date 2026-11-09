//! The worktree half of the fake herdr: `worktree.list` and `worktree.create` answered from repositories that
//! live only in memory. A created worktree is added to its repository, so the next `list` shows it; nothing touches
//! a disk, git or the owner's herdr. Requests are recorded by [`super::FakeHerdr`] like every other method.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::Script;

/// One checkout of a fake repository.
#[derive(Debug, Clone)]
pub struct FakeCheckout {
    pub path: String,
    pub branch: Option<String>,
    pub linked: bool,
}

/// A repository the fake knows.
#[derive(Debug, Clone)]
pub struct FakeRepo {
    pub root: String,
    pub name: String,
    pub checkouts: Vec<FakeCheckout>,
    /// herdr has not trusted it: every call is refused (the fake never honours `trust_repository`).
    pub untrusted: bool,
}

impl FakeRepo {
    /// A trusted repository whose main checkout is `root` on `main`.
    pub fn new(root: &str) -> Self {
        Self {
            root: root.to_owned(),
            name: folder(root),
            checkouts: vec![FakeCheckout {
                path: root.to_owned(),
                branch: Some("main".to_owned()),
                linked: false,
            }],
            untrusted: false,
        }
    }

    /// Adds a linked worktree.
    pub fn linked(mut self, path: &str, branch: &str) -> Self {
        self.checkouts.push(FakeCheckout {
            path: path.to_owned(),
            branch: Some(branch.to_owned()),
            linked: true,
        });
        self
    }

    pub fn untrusted(mut self) -> Self {
        self.untrusted = true;
        self
    }
}

/// The repositories the fake serves, and how it names what it creates.
#[derive(Default)]
pub struct FakeWorktrees {
    repos: Mutex<Vec<FakeRepo>>,
    /// Where a created worktree is, instead of next to its repository (so a test can name a folder that exists).
    created_at: Mutex<Option<String>>,
    /// The next `worktree.create` fails with this herdr answer `(code, message)`.
    next_failure: Mutex<Option<(String, String)>>,
}

impl FakeWorktrees {
    pub fn new(repos: Vec<FakeRepo>) -> Arc<Self> {
        Arc::new(Self {
            repos: Mutex::new(repos),
            ..Self::default()
        })
    }

    /// Creates the next worktrees at `path`, whatever their branch.
    pub fn create_at(&self, path: &str) {
        *self.created_at.lock().unwrap() = Some(path.to_owned());
    }

    /// Makes the next `worktree.create` answer an error.
    pub fn fail_next_create(&self, code: &str, message: &str) {
        *self.next_failure.lock().unwrap() = Some((code.to_owned(), message.to_owned()));
    }

    /// The checkouts of a repository now, as `(path, branch)`.
    pub fn checkouts(&self, root: &str) -> Vec<(String, Option<String>)> {
        self.repos
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.root == root)
            .map(|r| {
                r.checkouts
                    .iter()
                    .map(|c| (c.path.clone(), c.branch.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn info(c: &FakeCheckout) -> Value {
        json!({"path": c.path, "branch": c.branch, "label": folder(&c.path), "is_bare": false,
               "is_detached": c.branch.is_none(), "is_prunable": false,
               "is_linked_worktree": c.linked, "open_workspace_id": null})
    }

    /// The repository holding `cwd`, or the herdr answer a folder outside any repository gets.
    fn find(repos: &[FakeRepo], params: &Value) -> Result<usize, (String, String)> {
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let at = repos
            .iter()
            .position(|r| within(cwd, &r.root) || r.checkouts.iter().any(|c| within(cwd, &c.path)));
        let Some(at) = at else {
            return Err((
                "not_a_git_repository".to_owned(),
                format!("{cwd} is not inside a git repository"),
            ));
        };
        if repos[at].untrusted {
            return Err((
                "repository_not_trusted".to_owned(),
                format!("{} is not a trusted repository", repos[at].root),
            ));
        }
        Ok(at)
    }

    fn list(&self, params: &Value) -> Result<Value, (String, String)> {
        let repos = self.repos.lock().unwrap();
        let repo = &repos[Self::find(&repos, params)?];
        Ok(json!({
            "type": "worktree_list",
            "source": {"repo_key": format!("repo:{}", repo.root), "repo_name": repo.name,
                       "repo_root": repo.root, "source_checkout_path": repo.root, "source_workspace_id": null},
            "worktrees": repo.checkouts.iter().map(Self::info).collect::<Vec<_>>(),
        }))
    }

    fn create(&self, params: &Value) -> Result<Value, (String, String)> {
        if let Some(failure) = self.next_failure.lock().unwrap().take() {
            return Err(failure);
        }
        let mut repos = self.repos.lock().unwrap();
        let at = Self::find(&repos, params)?;
        let repo = &mut repos[at];
        let branch = match params.get("branch").and_then(Value::as_str) {
            Some(b) if !b.is_empty() => b.to_owned(),
            _ => format!("worktree/fake-{}", repo.checkouts.len()),
        };
        if repo
            .checkouts
            .iter()
            .any(|c| c.branch.as_deref() == Some(branch.as_str()))
        {
            return Err((
                "branch_exists".to_owned(),
                format!("a branch named {branch} already exists"),
            ));
        }
        let tail = branch.rsplit('/').next().unwrap_or(&branch);
        let path = self.created_at.lock().unwrap().clone().unwrap_or_else(|| {
            let parent = Path::new(&repo.root)
                .parent()
                .map_or(String::new(), |p| p.display().to_string());
            format!("{parent}/{}-{tail}", repo.name)
        });
        let made = FakeCheckout {
            path: path.clone(),
            branch: Some(branch),
            linked: true,
        };
        let n = repo.checkouts.len() + 20;
        let worktree = Self::info(&made);
        repo.checkouts.push(made);
        let (workspace, tab) = (format!("w{n}"), format!("w{n}:t1"));
        Ok(json!({
            "type": "worktree_created",
            "worktree": worktree,
            "workspace": {"workspace_id": workspace, "number": n, "label": folder(&path), "focused": false,
                          "pane_count": 1, "tab_count": 1, "active_tab_id": tab, "agent_status": "unknown"},
            "tab": {"tab_id": tab, "workspace_id": workspace, "number": 1, "label": "shell", "focused": false,
                    "pane_count": 1, "agent_status": "unknown"},
            "root_pane": {"pane_id": format!("w{n}:p1"), "workspace_id": workspace, "tab_id": tab,
                          "terminal_id": "t-new", "focused": false, "agent_status": "unknown", "revision": 1},
        }))
    }
}

impl Script {
    /// Answers `worktree.list`, `worktree.create` and `worktree.remove` from `fake` (see [`FakeWorktrees`]). A removal
    /// is acknowledged only: the fake has no workspaces to close, and a test that needs a refusal scripts its own.
    pub fn worktrees(self, fake: Arc<FakeWorktrees>) -> Self {
        let for_list = fake.clone();
        self.on_with("worktree.list", move |p| for_list.list(p))
            .on_with("worktree.create", move |p| fake.create(p))
            .on_with("worktree.remove", |p| {
                Ok(json!({"type": "worktree_removed", "workspace_id": p.get("workspace_id"), "forced": false}))
            })
    }
}

fn folder(path: &str) -> String {
    Path::new(path.trim_end_matches('/'))
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

fn within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}
