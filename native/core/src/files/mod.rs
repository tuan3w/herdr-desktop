//! `files`: reading and writing a machine's files for the file browser, the viewers and `Send a file`.
//!
//! One trait, [`Files`], with two implementations: [`LocalFiles`] (this computer, `std::fs`) and
//! [`RemoteFiles`] (another machine: a small python helper, `fs.py`, run through the machine's shared
//! ssh connection, so no new login and no SFTP stack). Everything above the trait (the folder listing, the
//! viewer's classification and byte caps, the chunked upload) is written once and tested against both.
//!
//! Paths are validated before anything runs ([`validate_path`]): absolute (or `~/`), no NUL byte, bounded.
//! A path reaches the remote machine as one argument of one `ssh` command, quoted by [`crate::ssh::shq`]
//! inside the generated command, so a crafted name is only ever a name.

mod archive;
mod cache;
mod json;
mod lines;
mod local;
mod media;
mod peek;
mod quick;
mod remote;
mod resolve;
mod tunnel;
mod upload;
mod view;
mod walk;

#[cfg(test)]
mod testmem;

use std::path::PathBuf;

use thiserror::Error;

pub use archive::{
    ArchiveEntry, LIST_LIMIT as ARCHIVE_LIMIT, Listing as ArchiveListing, is_archive_name,
    list as list_archive,
};
pub use cache::{CHUNK as MEDIA_CHUNK, DEFAULT_CAP as MEDIA_CAP, FetchError, MediaCache, fetch};
pub use json::{is_minified as json_minified, pretty as pretty_json};
pub use lines::{
    Index as LineIndex, LINE_MAX, STRIDE as LINE_STRIDE, find as find_line, read_lines,
    scan as scan_lines, size_of as lines_size,
};
pub use local::LocalFiles;
pub use media::{Codecs, MediaKind, media_kind, probe_codecs};
pub use peek::{PEEK_BYTES, Peek, detect as detect_type, peek};
pub use quick::{
    Hot, HotPaths, IGNORED_FROM, MentionHit, Mentions, Quick, QuickHit, QuickSearch, REFRESH_AFTER,
};
pub use remote::{FS_SCRIPT, RemoteFiles};
pub use resolve::{candidates, parent, path_from_uri, uri_from_path};
pub use tunnel::{Tunnel, TunnelError, free_port, localhost_port};
pub use upload::{UploadError, upload};
pub use view::{
    CLIPBOARD_IMAGE_CAP, FileView, IMAGE_CAP, TEXT_CAP, ViewKind, image_data_url, open, size_text,
    view_kind,
};
pub use walk::{
    IGNORED_PATHS, IGNORED_SKIP, TREE_BYTES, TREE_PATHS, TREE_TIME, Tree, TreeEntry, TreeLimits,
    keep_name, keep_path,
};

/// The longest path accepted (Linux's `PATH_MAX`).
pub const PATH_MAX: usize = 4096;

/// The most entries one folder listing returns; a bigger folder says so (`Listing::truncated`).
pub const LIST_MAX: usize = 5000;

/// The most bytes one `read` returns.
pub const READ_MAX: usize = 8 * 1024 * 1024;

/// Why a file operation failed, in the kinds the screens give their own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileErrorKind {
    /// There is nothing at the path.
    NotFound,
    /// The machine refused: no permission.
    Denied,
    /// A folder was expected and the path is a file.
    NotADirectory,
    /// A file was expected and the path is a folder.
    IsADirectory,
    /// A file with that name is already there.
    Exists,
    /// The machine cannot be reached (ssh failed, or the command timed out).
    Unreachable,
    /// The machine cannot do it: no `python3`.
    Unsupported,
    /// The path is not one the app will pass on.
    Invalid,
    /// Anything else; the message says what.
    Other,
}

/// A failed file operation: a kind and the sentence to show.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct FileError {
    /// What kind of failure.
    pub kind: FileErrorKind,
    /// What to show: what happened, and where.
    pub message: String,
}

impl FileError {
    /// An error of `kind` with `message`.
    pub fn new(kind: FileErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn from_io(e: &std::io::Error, path: &str) -> Self {
        use std::io::ErrorKind as K;
        let kind = match e.kind() {
            K::NotFound => FileErrorKind::NotFound,
            K::PermissionDenied => FileErrorKind::Denied,
            K::AlreadyExists => FileErrorKind::Exists,
            K::NotADirectory => FileErrorKind::NotADirectory,
            K::IsADirectory => FileErrorKind::IsADirectory,
            _ => FileErrorKind::Other,
        };
        let message = match kind {
            FileErrorKind::NotFound => format!("{path} does not exist"),
            FileErrorKind::Denied => format!("no permission for {path}"),
            FileErrorKind::Exists => format!("{path} already exists"),
            FileErrorKind::NotADirectory => format!("{path} is not a folder"),
            FileErrorKind::IsADirectory => format!("{path} is a folder"),
            _ => format!("{path}: {e}"),
        };
        Self::new(kind, message)
    }
}

/// What an entry is, after following a symbolic link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// A folder.
    Dir,
    /// A regular file.
    File,
    /// A socket, a device, a broken link: nothing the viewer opens.
    Other,
}

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The file name, without its folder.
    pub name: String,
    /// What it is (a link counts as what it points to).
    pub kind: EntryKind,
    /// Bytes, for a file; 0 otherwise.
    pub size: u64,
    /// Seconds since the Unix epoch it was last changed, when known.
    pub modified: Option<i64>,
    /// Whether this user may read it (a folder: enter it). An entry that is not readable is still listed.
    pub readable: bool,
    /// Whether the name is a symbolic link.
    pub link: bool,
}

/// A folder's entries, folders first and then by name without regard to case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    /// The folder, as the machine knows it (`~` expanded).
    pub path: String,
    /// What it holds.
    pub entries: Vec<Entry>,
    /// The folder holds more than [`LIST_MAX`] entries: only that many are here.
    pub truncated: bool,
    /// Entries whose names are not text and so cannot be shown.
    pub skipped: usize,
}

impl Listing {
    /// Folders first, then names ordered without regard to case (the name itself breaks a tie).
    pub fn sort(&mut self) {
        self.entries.sort_by(|a, b| {
            let rank = |e: &Entry| u8::from(e.kind != EntryKind::Dir);
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });
    }
}

/// What a `stat` of one path says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    /// What it is.
    pub kind: EntryKind,
    /// Bytes, for a file.
    pub size: u64,
    /// Seconds since the Unix epoch it was last changed, when known.
    pub modified: Option<i64>,
    /// Whether this user may read it.
    pub readable: bool,
}

/// A range of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// The file's whole size when it was read.
    pub size: u64,
    /// Seconds since the Unix epoch it was last changed, when known.
    pub modified: Option<i64>,
    /// The bytes read: fewer than asked at the end of the file.
    pub data: Vec<u8>,
}

/// Checks a path before any process or file operation sees it: absolute (or `~` / `~/...`, which each
/// side expands to the home folder), not empty, no NUL byte, at most [`PATH_MAX`] bytes.
pub fn validate_path(path: &str) -> Result<(), FileError> {
    let invalid = |why: &str| Err(FileError::new(FileErrorKind::Invalid, why));
    if path.is_empty() {
        return invalid("There is no path");
    }
    if path.len() > PATH_MAX {
        return invalid("That path is too long");
    }
    if path.contains('\0') {
        return invalid("That path has a NUL byte in it");
    }
    if path == "~" || path.starts_with("~/") || path.starts_with('/') {
        Ok(())
    } else {
        invalid("A path must start with / or ~/")
    }
}

/// `dir` and `name` as one path: no doubled slash, and a `name` that is itself a path (it holds `/`)
/// is refused, so a listing's name can never climb out of its folder.
pub fn join(dir: &str, name: &str) -> Result<String, FileError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(FileError::new(
            FileErrorKind::Invalid,
            format!("{name:?} is not a file name"),
        ));
    }
    let base = dir.trim_end_matches('/');
    Ok(format!("{base}/{name}"))
}

/// A machine's files. Every method blocks: call them off the UI thread.
pub trait Files: Send + Sync {
    /// The entries of `dir`, sorted (see [`Listing::sort`]).
    fn list(&self, dir: &str) -> Result<Listing, FileError>;
    /// What is at `path`, following links.
    fn stat(&self, path: &str) -> Result<Stat, FileError>;
    /// Up to `len` bytes of `path` from `start`.
    fn read(&self, path: &str, start: u64, len: usize) -> Result<Chunk, FileError>;
    /// Appends `data` to the upload part file of `path` (`offset` 0 starts it over). The part file lives
    /// next to `path` under a hidden name until [`Files::commit`]; a chunk that does not continue where
    /// the last ended is refused, so a lost chunk never becomes a corrupt file.
    fn put(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError>;
    /// Moves the finished part file to `path`. Without `replace` a name that exists is
    /// [`FileErrorKind::Exists`] and nothing is overwritten, atomically.
    fn commit(&self, path: &str, replace: bool) -> Result<(), FileError>;
    /// Removes the part file of `path` (after a failed or cancelled upload). A missing one is fine.
    fn discard(&self, path: &str) -> Result<(), FileError>;
    /// Makes the folder `path` and the folders above it that are missing; one that exists is fine. Only a
    /// machine that can say so answers: the default is [`FileErrorKind::Unsupported`].
    fn mkdir(&self, _path: &str) -> Result<(), FileError> {
        Err(FileError::new(
            FileErrorKind::Unsupported,
            "This machine cannot make a folder",
        ))
    }
    /// Every file under `root` that is worth opening by name (see [`keep_name`]), relative to it, within `limits`:
    /// what a git checkout does not ignore. A machine that cannot say answers [`FileErrorKind::Unsupported`].
    fn tree(&self, _root: &str, _limits: &TreeLimits) -> Result<Tree, FileError> {
        Err(FileError::new(
            FileErrorKind::Unsupported,
            "This machine cannot list a folder's files",
        ))
    }
    /// The files under `root` that [`Files::tree`] leaves out because git ignores them (or they are hidden), found
    /// by a second walk that does not enter [`IGNORED_SKIP`]. Only this computer answers: the default, and
    /// another machine's answer, is nothing, because its file list is `git ls-files` and has no ignored files.
    fn tree_ignored(&self, _root: &str, _limits: &TreeLimits) -> Result<Tree, FileError> {
        Ok(Tree::default())
    }
    /// The path on THIS computer when the files are on it, for what only a local path can do: the
    /// image viewer and `Reveal`/`Open`. `None` for another machine.
    fn local_path(&self, _path: &str) -> Option<PathBuf> {
        None
    }
}

/// The hidden file an upload to `path` is assembled in.
pub(crate) fn part_name(name: &str) -> String {
    format!(".{name}.herdr-part")
}
