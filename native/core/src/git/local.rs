//! This computer's git, through `std::process::Command`.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use super::{
    Call, ENV, GitError, GitErrorKind, PRELUDE, Probe, Raw, Runner, check_allowed, validate_dir,
};
use crate::ssh::spawn;

/// How long the output reader gets to finish once the process has exited.
const OUTPUT_GRACE: Duration = Duration::from_secs(5);

/// The bytes of a file looked at to tell text from binary (git's own rule: a NUL byte in the first 8000).
const SNIFF: usize = 8000;

/// The biggest file whose lines are counted.
const COUNT_CAP: u64 = 64 * 1024 * 1024;

/// The git of the computer the app runs on.
#[derive(Debug, Clone, Default)]
pub struct LocalGit {
    home: Option<PathBuf>,
}

impl LocalGit {
    /// Git on this computer; `~` is the current user's home folder.
    pub fn new() -> Self {
        Self {
            home: dirs::home_dir(),
        }
    }

    /// Git with an explicit home folder (tests).
    pub fn with_home(home: impl Into<PathBuf>) -> Self {
        Self {
            home: Some(home.into()),
        }
    }

    fn resolve(&self, dir: &str) -> Result<PathBuf, GitError> {
        validate_dir(dir)?;
        let Some(rest) = dir.strip_prefix('~') else {
            return Ok(PathBuf::from(dir));
        };
        let home = self.home.as_ref().ok_or_else(|| {
            GitError::new(GitErrorKind::Failed, "This computer has no home folder")
        })?;
        Ok(home.join(rest.trim_start_matches('/')))
    }
}

impl Runner for LocalGit {
    fn run(&self, dir: &str, call: &Call<'_>) -> Result<Raw, GitError> {
        check_allowed(call)?;
        let dir = self.resolve(dir)?;
        if !dir.is_dir() {
            return Err(GitError::new(
                GitErrorKind::Invalid,
                format!("{} is not a folder on this computer", dir.display()),
            ));
        }
        let mut command = Command::new("git");
        command.args(PRELUDE).args(call.args).current_dir(&dir);
        // A repository the app was started from must not steer the one asked about.
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_EXTERNAL_DIFF",
        ] {
            command.env_remove(name);
        }
        command.envs(ENV.iter().copied());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let spawned = spawn(&mut command).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GitError::new(GitErrorKind::GitMissing, "git is not installed")
            } else {
                GitError::new(GitErrorKind::Failed, format!("cannot start git: {e}"))
            }
        })?;
        let (proc, mut stdin, stdout) = (spawned.proc, spawned.stdin, spawned.stdout);
        let input = call.stdin.to_vec();
        // On a thread: a command that answers before it has read its input would block a write here.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
        let (tx, rx) = mpsc::channel();
        let (killer, cap) = (proc.clone(), call.cap);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.take(cap as u64 + 1).read_to_end(&mut bytes);
            let over = bytes.len() > cap;
            if over {
                bytes.truncate(cap);
                // It has said enough; this is our own child, killed by its own PID.
                killer.kill();
            }
            let _ = tx.send((bytes, over));
        });
        let Some(exit) = proc.wait_exit(call.timeout) else {
            proc.kill();
            return Err(GitError::new(
                GitErrorKind::Failed,
                format!("git took longer than {} s", call.timeout.as_secs()),
            ));
        };
        let (stdout, truncated) = rx.recv_timeout(OUTPUT_GRACE).unwrap_or_default();
        Ok(Raw {
            code: if truncated {
                0
            } else {
                exit.code.unwrap_or(-1)
            },
            stdout,
            truncated,
            stderr: exit.stderr,
        })
    }

    fn probe(&self, root: &str, paths: &[String]) -> Result<Vec<Option<Probe>>, GitError> {
        let root = self.resolve(root)?;
        paths.iter().map(|p| probe_file(&root, p)).collect()
    }
}

fn probe_file(root: &Path, rel: &str) -> Result<Option<Probe>, GitError> {
    super::validate_rel(rel)?;
    // `validate_rel` already refused `..` and a leading `/`; a path made only of normal parts is inside `root`.
    if !Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(GitError::new(GitErrorKind::Invalid, "Not a file name"));
    }
    let path = root.join(rel);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return Ok(None);
    };
    if meta.file_type().is_symlink() {
        // git diffs a link as one line holding its target.
        let target = fs::read_link(&path).map_err(|_| ()).ok();
        let size = target.map_or(0, |t| t.as_os_str().len() as u64);
        return Ok(Some(Probe {
            lines: Some(1),
            binary: false,
            size,
        }));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    let Ok(file) = fs::File::open(&path) else {
        return Ok(None);
    };
    Ok(Some(count(file, meta.size())))
}

/// Lines and binary-ness of a file read in pieces (`size` is its length). Lines are `None` when the file is bigger
/// than [`COUNT_CAP`]: counting a gigabyte on every poll is not worth a number.
fn count(mut file: fs::File, size: u64) -> Probe {
    let mut buf = vec![0u8; 64 * 1024];
    let (mut newlines, mut last, mut first) = (0u64, b'\n', true);
    loop {
        let Ok(n) = file.read(&mut buf) else {
            return Probe {
                lines: None,
                binary: false,
                size,
            };
        };
        if n == 0 {
            break;
        }
        if first {
            first = false;
            if buf[..n.min(SNIFF)].contains(&0) {
                return Probe {
                    lines: Some(0),
                    binary: true,
                    size,
                };
            }
            if size > COUNT_CAP {
                return Probe {
                    lines: None,
                    binary: false,
                    size,
                };
            }
        }
        newlines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        last = buf[n - 1];
    }
    let lines = newlines + u64::from(last != b'\n');
    Probe {
        lines: u32::try_from(lines).ok(),
        binary: false,
        size,
    }
}
