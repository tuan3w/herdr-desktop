//! What a revert removed, kept for ten minutes so `Undo` can bring it back.
//!
//! Before anything is reverted its patch is written here (inside the app's data folder, private to the user). The
//! patch is in the form `git apply` takes going forward: undoing is applying it. A file belongs to one revert, so
//! two reverts never share one, and a file older than [`UNDO_KEEP`] is deleted whenever the store is touched.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use super::{GitError, GitErrorKind};

/// How long a reverted change can be brought back.
pub const UNDO_KEEP: Duration = Duration::from_secs(10 * 60);

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// The folder where reverted changes wait for an undo.
#[derive(Debug, Clone)]
pub struct UndoStore {
    dir: PathBuf,
}

/// A saved revert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Saved {
    /// The repository root the patch applies in.
    pub root: String,
    /// The patch, going forward.
    pub patch: Vec<u8>,
}

impl UndoStore {
    /// A store in `dir` (created on first use, mode 0700).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Where the store lives.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn io(e: io::Error) -> GitError {
        GitError::new(
            GitErrorKind::Failed,
            format!("cannot keep a copy of what would be reverted: {e}"),
        )
    }

    /// Saves `patch` for `root` and returns its id. Old entries go first.
    pub(crate) fn save(&self, root: &str, patch: &[u8]) -> Result<String, GitError> {
        self.sweep(SystemTime::now());
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .map_err(Self::io)?;
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let id = format!(
            "{}-{:08x}",
            nanos / 1_000_000,
            (nanos as u64 ^ (n << 40)) as u32
        );
        for (ext, bytes) in [("root", root.as_bytes()), ("patch", patch)] {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(self.dir.join(format!("{id}.{ext}")))
                .map_err(Self::io)?;
            file.write_all(bytes).map_err(Self::io)?;
        }
        Ok(id)
    }

    fn valid(id: &str) -> bool {
        let Some((ms, rand)) = id.split_once('-') else {
            return false;
        };
        !ms.is_empty()
            && ms.len() <= 20
            && ms.bytes().all(|b| b.is_ascii_digit())
            && rand.len() == 8
            && rand.bytes().all(|b| b.is_ascii_hexdigit())
    }

    /// The saved revert `id`, or why it cannot be undone.
    pub(crate) fn load(&self, id: &str) -> Result<Saved, GitError> {
        let gone = || {
            GitError::new(
                GitErrorKind::Stale,
                "That can no longer be undone: it was reverted more than ten minutes ago",
            )
        };
        if !Self::valid(id) {
            return Err(GitError::new(GitErrorKind::Invalid, "That is not a revert"));
        }
        self.sweep(SystemTime::now());
        let patch = fs::read(self.dir.join(format!("{id}.patch"))).map_err(|_| gone())?;
        let root = fs::read(self.dir.join(format!("{id}.root"))).map_err(|_| gone())?;
        Ok(Saved {
            root: String::from_utf8_lossy(&root).into_owned(),
            patch,
        })
    }

    /// Drops a revert once it was undone.
    pub(crate) fn forget(&self, id: &str) {
        if Self::valid(id) {
            for ext in ["patch", "root"] {
                let _ = fs::remove_file(self.dir.join(format!("{id}.{ext}")));
            }
        }
    }

    /// Deletes every entry older than [`UNDO_KEEP`] at `now`.
    pub fn sweep(&self, now: SystemTime) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > UNDO_KEEP);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}
