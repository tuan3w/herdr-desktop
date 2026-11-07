//! Another machine's files: `fs.py` run through the machine's shared ssh connection.

use std::time::Duration;

use serde::Deserialize;

use super::{
    Chunk, Entry, EntryKind, FileError, FileErrorKind, Files, Listing, READ_MAX, Stat, Tree,
    TreeEntry, TreeLimits, keep_path, validate_path,
};
use crate::ssh::{Output, SshClient, SshTarget};

/// The python helper that runs on the remote machine (see the docstring of `fs.py` for its commands).
pub const FS_SCRIPT: &str = include_str!("fs.py");

/// What a remote command exits with when it printed `{"error": ...}`.
const EXIT_ERROR: i32 = 3;
/// What the shell exits with for a command it cannot find (here: `python3`).
const EXIT_NOT_FOUND: i32 = 127;

const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PUT_TIMEOUT: Duration = Duration::from_secs(120);

/// The files of one remote machine. Cheap to clone; every call shares the machine's ssh connection
/// (`ControlMaster`), so none of them logs in again.
#[derive(Debug, Clone)]
pub struct RemoteFiles {
    client: SshClient,
    target: SshTarget,
}

#[derive(Deserialize)]
struct RawEntry {
    n: String,
    k: String,
    s: u64,
    m: Option<i64>,
    r: bool,
    l: bool,
}

#[derive(Deserialize)]
struct RawListing {
    path: String,
    entries: Vec<RawEntry>,
    skipped: usize,
    truncated: bool,
}

#[derive(Deserialize)]
struct RawStat {
    k: String,
    s: u64,
    m: Option<i64>,
    r: bool,
}

#[derive(Deserialize)]
struct RawHeader {
    size: u64,
    m: Option<i64>,
    len: usize,
}

#[derive(Deserialize)]
struct RawTree {
    n: usize,
    truncated: bool,
}

#[derive(Deserialize)]
struct RawError {
    error: String,
    message: String,
}

fn kind_of(k: &str) -> EntryKind {
    match k {
        "d" => EntryKind::Dir,
        "f" => EntryKind::File,
        _ => EntryKind::Other,
    }
}

fn protocol(what: &str) -> FileError {
    FileError::new(
        FileErrorKind::Other,
        format!("the machine answered {what} in a way this app does not understand"),
    )
}

impl RemoteFiles {
    /// The files of the machine `target` names, reached through `client`.
    pub fn new(client: SshClient, target: SshTarget) -> Self {
        Self { client, target }
    }

    /// Runs one helper command; `Ok` is its stdout on success.
    fn run(&self, args: &[&str], stdin: &[u8], timeout: Duration) -> Result<Vec<u8>, FileError> {
        let mut argv = vec!["python3", "-c", FS_SCRIPT];
        argv.extend_from_slice(args);
        let Output {
            code,
            stdout,
            stderr,
        } = self
            .client
            .run_checked(&self.target, &argv, stdin, timeout)
            .map_err(|e| FileError::new(FileErrorKind::Unreachable, e.message))?;
        match code {
            0 => Ok(stdout),
            EXIT_ERROR => Err(self.error_of(&stdout)),
            EXIT_NOT_FOUND => Err(FileError::new(
                FileErrorKind::Unsupported,
                format!(
                    "{} has no python3, which the file browser needs",
                    self.target.dest()
                ),
            )),
            _ => {
                let last = stderr.lines().last().unwrap_or("").trim();
                Err(FileError::new(
                    FileErrorKind::Other,
                    format!("the file helper on {} failed: {last}", self.target.dest()),
                ))
            }
        }
    }

    fn error_of(&self, stdout: &[u8]) -> FileError {
        let Ok(RawError { error, message }) = serde_json::from_slice::<RawError>(stdout) else {
            return protocol("an error");
        };
        let kind = match error.as_str() {
            "notfound" => FileErrorKind::NotFound,
            "denied" => FileErrorKind::Denied,
            "notdir" => FileErrorKind::NotADirectory,
            "isdir" => FileErrorKind::IsADirectory,
            "exists" => FileErrorKind::Exists,
            "invalid" => FileErrorKind::Invalid,
            _ => FileErrorKind::Other,
        };
        FileError::new(kind, message)
    }

    fn json<T: for<'de> Deserialize<'de>>(&self, stdout: &[u8]) -> Result<T, FileError> {
        serde_json::from_slice(stdout).map_err(|_| protocol("a reply"))
    }
}

impl Files for RemoteFiles {
    fn list(&self, dir: &str) -> Result<Listing, FileError> {
        validate_path(dir)?;
        let raw: RawListing = self.json(&self.run(&["ls", dir], &[], LIST_TIMEOUT)?)?;
        let mut listing = Listing {
            path: raw.path,
            entries: raw
                .entries
                .into_iter()
                .map(|e| Entry {
                    name: e.n,
                    kind: kind_of(&e.k),
                    size: e.s,
                    modified: e.m,
                    readable: e.r,
                    link: e.l,
                })
                .collect(),
            truncated: raw.truncated,
            skipped: raw.skipped,
        };
        listing.sort();
        Ok(listing)
    }

    fn stat(&self, path: &str) -> Result<Stat, FileError> {
        validate_path(path)?;
        let raw: RawStat = self.json(&self.run(&["stat", path], &[], LIST_TIMEOUT)?)?;
        Ok(Stat {
            kind: kind_of(&raw.k),
            size: raw.s,
            modified: raw.m,
            readable: raw.r,
        })
    }

    fn read(&self, path: &str, start: u64, len: usize) -> Result<Chunk, FileError> {
        validate_path(path)?;
        let out = self.run(
            &[
                "read",
                path,
                &start.to_string(),
                &len.min(READ_MAX).to_string(),
            ],
            &[],
            READ_TIMEOUT,
        )?;
        let split = out
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| protocol("a read"))?;
        let header: RawHeader = self.json(&out[..split])?;
        let data = out[split + 1..].to_vec();
        if data.len() != header.len {
            return Err(protocol("a read of the wrong length"));
        }
        Ok(Chunk {
            size: header.size,
            modified: header.m,
            data,
        })
    }

    fn put(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        validate_path(path)?;
        self.run(&["put", path, &offset.to_string()], data, PUT_TIMEOUT)
            .map(drop)
    }

    fn commit(&self, path: &str, replace: bool) -> Result<(), FileError> {
        validate_path(path)?;
        self.run(
            &["commit", path, if replace { "1" } else { "0" }],
            &[],
            LIST_TIMEOUT,
        )
        .map(drop)
    }

    fn mkdir(&self, path: &str) -> Result<(), FileError> {
        validate_path(path)?;
        self.run(&["mkdir", path], &[], LIST_TIMEOUT).map(drop)
    }

    fn discard(&self, path: &str) -> Result<(), FileError> {
        validate_path(path)?;
        self.run(&["discard", path], &[], LIST_TIMEOUT).map(drop)
    }

    fn tree(&self, root: &str, limits: &TreeLimits) -> Result<Tree, FileError> {
        validate_path(root)?;
        let out = self.run(
            &["tree", root, &limits.paths.to_string()],
            &[],
            LIST_TIMEOUT,
        )?;
        let split = out
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| protocol("a file list"))?;
        let header: RawTree = self.json(&out[..split])?;
        let mut tree = Tree {
            entries: Vec::with_capacity(header.n.min(limits.paths)),
            truncated: header.truncated,
        };
        let mut bytes = 0;
        for raw in out[split + 1..].split(|&b| b == 0) {
            // The helper lists what git lists: the same files a walk here skips (`.env`, `.cache/`) are dropped as
            // they are on this computer, and a name that is not text cannot be shown.
            let Ok(path) = std::str::from_utf8(raw) else {
                continue;
            };
            if path.is_empty() || path.starts_with('/') || !keep_path(path) {
                continue;
            }
            if !tree.room_for(path.len(), bytes, limits) {
                break;
            }
            bytes += path.len();
            tree.entries.push(TreeEntry {
                path: path.to_owned(),
                modified: 0,
            });
        }
        Ok(tree)
    }
}
