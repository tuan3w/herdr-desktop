//! `git`: what the agents changed in a checkout, for the Changes tab.
//!
//! One type, [`Git`], over a [`Runner`] that runs the `git` command line: [`LocalGit`] (this computer, through
//! `std::process::Command`, arguments as a list, never a shell) or [`RemoteGit`] (another machine: a small python
//! helper, `git.py`, run through the machine's shared ssh connection, so the output is capped *there* and a 20 MB
//! diff never crosses the wire). Everything above the runner (the status, the numbers, the diff and its groups of
//! changes, revert and undo) is written once and tested against real repositories in a temporary folder.
//!
//! Rules this module keeps, each with a test:
//!
//! * **Read-only unless asked.** `status` and `diff` take no lock (`GIT_OPTIONAL_LOCKS=0`: an agent that is running
//!   `git commit` is never made to fail by our poll), run no external diff, textconv or fsmonitor program a
//!   repository's own config names, and treat every path literally (`GIT_LITERAL_PATHSPECS`: a file called `*` is a
//!   file, not a pattern). The only commands that change anything are the ones behind [`Git::revert_file`],
//!   [`Git::revert_group`] and [`Git::undo`].
//! * **Paths are validated before anything runs** ([`validate_dir`], [`validate_rel`]) and always follow `--`; the
//!   remote helper receives each as its own argument of one `ssh` command, quoted by [`crate::ssh::shq`].
//! * **Output is bounded** (`STATUS_CAP`, `DIFF_CAP`, `DIFF_CAP_ALL`, `FILES_MAX`): the command is killed by PID once
//!   it has said enough, and the result says it was cut.
//! * **Nothing is lost silently.** A revert first saves what it removes as a patch ([`UndoStore`], kept ten minutes);
//!   a hunk is reverted only if `git apply -R --check` accepts it and the diff is still the one the person saw.

mod diff;
mod local;
mod parse;
mod remote;
mod repo;
mod undo;
mod validate;

use std::time::Duration;

use thiserror::Error;

pub use diff::{FileDiff, Group};
pub use local::LocalGit;
pub use parse::{Change, ChangeKind, Status};
pub use remote::{GIT_SCRIPT, RemoteGit};
pub use repo::{DiffOptions, Git, Undone};
pub use undo::{UNDO_KEEP, UndoStore};
pub use validate::{validate_dir, validate_rel};

/// The most bytes of `git status` read; a bigger answer is cut and the list says so.
pub const STATUS_CAP: usize = 16 * 1024 * 1024;

/// The most changed files one status lists.
pub const FILES_MAX: usize = 5000;

/// The most bytes of one file's patch read by default.
pub const DIFF_CAP: usize = 2 * 1024 * 1024;

/// The most bytes of one file's patch read for `Show all`.
pub const DIFF_CAP_ALL: usize = 32 * 1024 * 1024;

/// The most lines of one file's patch handed to the view by default (a bigger one is cut and says so).
pub const DIFF_LINES: usize = 6000;

/// The most lines handed to the view for `Show all`.
pub const DIFF_LINES_ALL: usize = 200_000;

/// The largest patch a revert saves for undo: a revert that cannot be undone because the change is bigger than this
/// is refused, with the words to say so.
pub const BACKUP_CAP: usize = 8 * 1024 * 1024;

/// The most untracked or binary files whose size and line count one status looks at.
pub const PROBE_MAX: usize = 400;

/// A file larger than this is not read to fingerprint it (`reviewed` marks fall back to its line counts).
pub const HASH_MAX: u64 = 4 * 1024 * 1024;

/// How long one git command may run before it is killed. A repository that takes longer is not one to poll.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a git operation failed, in the kinds the screen gives its own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
    /// The folder is not in a git repository (or is a bare one, which has nothing to review).
    NotARepo,
    /// `git` is not installed where it was needed.
    GitMissing,
    /// The machine could not be reached or did not answer in time.
    Unreachable,
    /// The request itself was refused before anything ran: a bad path, nothing to revert, a kind of file this does
    /// not apply to.
    Invalid,
    /// The file has merge conflicts: nothing here resolves them.
    Conflicted,
    /// The file changed since the person looked: nothing was done.
    Stale,
    /// Too big to do safely (a revert whose backup would exceed `BACKUP_CAP`).
    TooBig,
    /// git ran and said no (or something else went wrong); the message is git's own words.
    Failed,
}

/// A failed git operation: a kind and the sentence to show.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct GitError {
    /// What went wrong, for the screen to treat differently (an explanation instead of an error toast).
    pub kind: GitErrorKind,
    /// The sentence: what happened and where.
    pub message: String,
}

impl GitError {
    /// An error of `kind` with `message`.
    pub fn new(kind: GitErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// One git command to run: its arguments (after the fixed prelude), what to feed it, how much of its output to read
/// and how long it may take.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    /// The arguments after `git`; the first is the subcommand and must be one of [`ALLOWED`].
    pub args: &'a [&'a str],
    /// Written to its standard input, which is then closed.
    pub stdin: &'a [u8],
    /// Output bytes kept; reading stops there and the command is killed.
    pub cap: usize,
    /// When the command is killed for taking too long.
    pub timeout: Duration,
}

/// What a command printed and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raw {
    /// Its exit status; `0` when we stopped it ourselves because it had said enough (`truncated`).
    pub code: i32,
    /// Up to `Call::cap` bytes of its standard output.
    pub stdout: Vec<u8>,
    /// There was more output than `cap`.
    pub truncated: bool,
    /// The tail of its standard error.
    pub stderr: String,
}

/// What [`Runner::probe`] says about one file in the checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    /// Lines (a last line without a newline counts); `Some(0)` for a binary file, `None` when it is too big to count.
    pub lines: Option<u32>,
    /// The file holds a NUL byte in its first 8 KB, the way git decides.
    pub binary: bool,
    /// Its size in bytes (a link's is its target's length).
    pub size: u64,
}

/// The only subcommands any runner will start. `apply`, `checkout`, `rm` and `clean` are the mutating ones, reached
/// only through the revert and undo functions of [`Git`]. Tracked files are compared with `diff-index`, not `diff`:
/// the porcelain `diff` refreshes the index and rewrites it when a file's timestamp moved, taking `index.lock` for a
/// moment, which `GIT_OPTIONAL_LOCKS=0` does not stop; an agent running `git add` at that moment would fail. `diff`
/// stays for `--no-index` (an untracked file against nothing), which never reads the index.
pub const ALLOWED: &[&str] = &[
    "rev-parse",
    "status",
    "diff",
    "diff-index",
    "hash-object",
    "apply",
    "checkout",
    "rm",
    "clean",
];

/// The words every git command starts with: no pager, no program a repository's config can name, plain output with
/// the standard `a/` and `b/` prefixes whatever the person's own config says.
pub(crate) const PRELUDE: &[&str] = &[
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=off",
    "-c",
    "color.ui=never",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.external=",
];

/// Environment for every git command.
pub(crate) const ENV: &[(&str, &str)] = &[
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_LITERAL_PATHSPECS", "1"),
    ("GIT_PAGER", "cat"),
    ("LC_ALL", "C"),
];

/// Runs git commands in a checkout. Every method blocks: call them off the UI thread.
pub trait Runner: Send + Sync {
    /// Runs `git <call.args>` in the folder `dir`.
    fn run(&self, dir: &str, call: &Call<'_>) -> Result<Raw, GitError>;

    /// Size and line count of `paths` (relative to `root`), `None` for one that cannot be read or is not a plain
    /// file. A path that is absolute or climbs out of `root` is refused with an error.
    fn probe(&self, root: &str, paths: &[String]) -> Result<Vec<Option<Probe>>, GitError>;
}

/// Refuses a call whose subcommand is not in [`ALLOWED`].
pub(crate) fn check_allowed(call: &Call<'_>) -> Result<(), GitError> {
    match call.args.first() {
        Some(sub) if ALLOWED.contains(sub) => Ok(()),
        other => Err(GitError::new(
            GitErrorKind::Invalid,
            format!(
                "git {} is not something this app runs",
                other.unwrap_or(&"")
            ),
        )),
    }
}

/// A 64-bit FNV-1a hash as 16 hex digits: stable across versions and platforms, so a saved `reviewed` mark means the
/// same thing after an update.
pub(crate) fn fingerprint(parts: &[&[u8]]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &byte in *part {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        // A separator no part can contain keeps ("ab", "c") and ("a", "bc") apart.
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}
