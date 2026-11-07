//! Listing every file under a folder for quick open: what is worth opening, and the walks that find it.
//!
//! [`keep_name`] is the one rule for what a person wants in a file picker, used by the walk on this computer and by
//! the remote answer (`fs.py` `tree`), so both machines list the same files. The walk is the `ignore` crate: it reads
//! `.gitignore`, `.git/info/exclude` and the user's global ignore file, as git does.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, Instant};

use ignore::{DirEntry, WalkBuilder};

use super::FileError;

/// The most paths one root's index holds.
pub const TREE_PATHS: usize = 100_000;

/// The most bytes of path text one root's index holds.
pub const TREE_BYTES: usize = 8 * 1024 * 1024;

/// The longest a walk runs before it hands over what it has.
pub const TREE_TIME: Duration = Duration::from_secs(5);

/// The most paths the second, ignored-files walk collects.
pub const IGNORED_PATHS: usize = 20_000;

/// Folders the ignored-files walk never enters: they are huge, and nobody opens their files by name.
pub const IGNORED_SKIP: [&str; 7] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".venv",
    "__pycache__",
    "build",
];

/// Hidden folders that hold files worth opening (CI, editor and tool settings). Every other folder whose name
/// starts with a dot is skipped. `fs.py` keeps the same list for its walk of a folder that is not a git checkout.
const HIDDEN_DIRS: [&str; 7] = [
    ".github",
    ".gitlab",
    ".vscode",
    ".cargo",
    ".husky",
    ".devcontainer",
    ".circleci",
];

/// Hidden files that are project files, besides those named `.<tool>rc` (`.oxlintrc.json`, `.prettierrc`, `.npmrc`).
const HIDDEN_FILES: [&str; 14] = [
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".dockerignore",
    ".editorconfig",
    ".env.example",
    ".env.sample",
    ".env.template",
    ".node-version",
    ".python-version",
    ".tool-versions",
    ".ignore",
    ".mailmap",
    ".nvmrc",
];

/// Limits of one walk. A walk that stops at one reports [`Tree::truncated`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeLimits {
    /// The most paths.
    pub paths: usize,
    /// The most bytes of path text.
    pub bytes: usize,
    /// The longest the walk runs.
    pub time: Duration,
}

impl TreeLimits {
    /// The limits of a root's index: 100,000 paths, 8 MB of path text, 5 seconds.
    pub const INDEX: Self = Self {
        paths: TREE_PATHS,
        bytes: TREE_BYTES,
        time: TREE_TIME,
    };

    /// The limits of the ignored-files walk: 20,000 paths, otherwise as [`TreeLimits::INDEX`].
    pub const IGNORED: Self = Self {
        paths: IGNORED_PATHS,
        bytes: TREE_BYTES,
        time: TREE_TIME,
    };
}

/// One file of a tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    /// Relative to the root, `/` separated, never starting with one.
    pub path: String,
    /// Seconds since the Unix epoch it was last changed; 0 when not known (another machine's files).
    pub modified: i64,
}

/// The files under a root.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tree {
    /// The files, in the order the walk found them.
    pub entries: Vec<TreeEntry>,
    /// The walk stopped at a limit: there are more files than listed.
    pub truncated: bool,
}

impl Tree {
    /// Whether another path of `len` bytes still fits; when it does not, records that the walk was cut.
    pub(crate) fn room_for(&mut self, len: usize, bytes: usize, limits: &TreeLimits) -> bool {
        if self.entries.len() >= limits.paths || bytes + len > limits.bytes {
            self.truncated = true;
            return false;
        }
        true
    }
}

/// Whether a hidden file is a project file: on the short list, or named like a tool's settings (`.eslintrc.cjs`).
fn hidden_file_ok(name: &str) -> bool {
    if HIDDEN_FILES.contains(&name) {
        return true;
    }
    let stem = name.trim_start_matches('.');
    stem.split('.').next().is_some_and(|s| s.ends_with("rc"))
}

/// Whether a file or folder called `name` belongs in a file picker: nothing hidden except the short lists above,
/// and never `node_modules` or `__pycache__`, whatever the ignore files say.
pub fn keep_name(name: &str, dir: bool) -> bool {
    if dir {
        !matches!(name, "node_modules" | "__pycache__")
            && (!name.starts_with('.') || HIDDEN_DIRS.contains(&name))
    } else {
        !name.starts_with('.') || hidden_file_ok(name)
    }
}

/// [`keep_name`] for a relative path: every folder on it and the file itself.
pub fn keep_path(path: &str) -> bool {
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if !keep_name(part, parts.peek().is_some()) {
            return false;
        }
    }
    true
}

/// Everything the ignore rules do not exclude under `root` (an existing folder on this computer).
pub(crate) fn walk_index(root: &Path, limits: &TreeLimits) -> Result<Tree, FileError> {
    walk(root, limits, false)
}

/// What the ignore rules exclude: every file under `root` the first walk skipped for being ignored, except inside
/// [`IGNORED_SKIP`]. May also repeat files of the first walk: the caller removes those.
pub(crate) fn walk_ignored(root: &Path, limits: &TreeLimits) -> Result<Tree, FileError> {
    walk(root, limits, true)
}

fn walk(root: &Path, limits: &TreeLimits, ignored: bool) -> Result<Tree, FileError> {
    let shown = root.to_string_lossy();
    let meta = fs::metadata(root).map_err(|e| FileError::from_io(&e, &shown))?;
    if !meta.is_dir() {
        return Err(FileError::from_io(
            &std::io::Error::from(std::io::ErrorKind::NotADirectory),
            &shown,
        ));
    }
    let canonical = fs::canonicalize(root).map_err(|e| FileError::from_io(&e, &shown))?;
    let started = Instant::now();
    let mut builder = WalkBuilder::new(root);
    // Parents are not read: a project nested in an ignored folder of an outer checkout (a worktree under the outer
    // checkout's `.claude/`) would list nothing at all. Hidden files are the `keep_name` rule's job, not the walker's.
    builder
        .follow_links(false)
        .require_git(false)
        .parents(false)
        .hidden(false);
    if ignored {
        builder.standard_filters(false);
    }
    builder.filter_entry(move |e: &DirEntry| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        let dir = e.file_type().is_some_and(|t| t.is_dir());
        if ignored {
            !(dir && IGNORED_SKIP.contains(&name.as_ref()))
        } else {
            keep_name(&name, dir)
        }
    });
    let mut tree = Tree::default();
    let mut bytes = 0;
    for entry in builder.build() {
        if started.elapsed() > limits.time {
            tree.truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        let modified = if file_type.is_file() {
            entry.metadata().ok().map(|m| m.mtime())
        } else if file_type.is_symlink() {
            // A link counts when it leads to a file inside the root: one that leaves it is not this project's.
            let Ok(target) = fs::canonicalize(entry.path()) else {
                continue;
            };
            if !target.starts_with(&canonical) {
                continue;
            }
            match fs::metadata(&target) {
                Ok(meta) if meta.is_file() => Some(meta.mtime()),
                _ => continue,
            }
        } else {
            continue;
        };
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Some(path) = relative.to_str() else {
            continue;
        };
        if !tree.room_for(path.len(), bytes, limits) {
            break;
        }
        bytes += path.len();
        tree.entries.push(TreeEntry {
            path: path.to_owned(),
            modified: modified.unwrap_or(0),
        });
    }
    Ok(tree)
}
