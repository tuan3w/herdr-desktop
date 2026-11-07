//! Another machine's git: `git.py` run through the machine's shared ssh connection.

use std::time::Duration;

use serde::Deserialize;

use super::{
    Call, ENV, GitError, GitErrorKind, PRELUDE, Probe, Raw, Runner, check_allowed, validate_dir,
};
use crate::ssh::{Output, SshClient, SshTarget};

/// The python helper that runs on the remote machine (see the docstring of `git.py` for its commands).
pub const GIT_SCRIPT: &str = include_str!("git.py");

/// What the helper exits with when it printed `{"error": ...}`.
const EXIT_ERROR: i32 = 3;
/// What the shell exits with for a command it cannot find (here: `python3`).
const EXIT_NOT_FOUND: i32 = 127;
/// Time for ssh itself to start and the helper to answer, on top of the command's own.
const SSH_SLACK: Duration = Duration::from_secs(15);

/// The git of one remote machine. Cheap to clone; every call shares the machine's ssh connection (`ControlMaster`),
/// so none of them logs in again.
#[derive(Debug, Clone)]
pub struct RemoteGit {
    client: SshClient,
    target: SshTarget,
}

#[derive(Deserialize)]
struct Header {
    code: i32,
    len: usize,
    truncated: bool,
    stderr: String,
}

#[derive(Deserialize)]
struct RawError {
    error: String,
    message: String,
}

fn protocol(what: &str) -> GitError {
    GitError::new(
        GitErrorKind::Failed,
        format!("the git helper answered {what} that was not understood"),
    )
}

impl RemoteGit {
    /// The git of the machine `target` names, reached through `client`.
    pub fn new(client: SshClient, target: SshTarget) -> Self {
        Self { client, target }
    }

    fn helper(&self, args: &[&str], stdin: &[u8], timeout: Duration) -> Result<Vec<u8>, GitError> {
        let mut argv = vec!["python3", "-c", GIT_SCRIPT];
        argv.extend_from_slice(args);
        let Output {
            code,
            stdout,
            stderr,
        } = self
            .client
            .run_checked(&self.target, &argv, stdin, timeout + SSH_SLACK)
            .map_err(|e| GitError::new(GitErrorKind::Unreachable, e.message))?;
        match code {
            0 => Ok(stdout),
            EXIT_ERROR => Err(match serde_json::from_slice::<RawError>(&stdout) {
                Ok(RawError { error, message }) => GitError::new(
                    match error.as_str() {
                        "nogit" => GitErrorKind::GitMissing,
                        "invalid" => GitErrorKind::Invalid,
                        _ => GitErrorKind::Failed,
                    },
                    format!("{message} (on {})", self.target.dest()),
                ),
                Err(_) => protocol("an error"),
            }),
            EXIT_NOT_FOUND => Err(GitError::new(
                GitErrorKind::GitMissing,
                format!(
                    "{} has no python3, which reading its changes needs",
                    self.target.dest()
                ),
            )),
            _ => {
                let last = stderr.lines().last().unwrap_or("").trim();
                Err(GitError::new(
                    GitErrorKind::Failed,
                    format!("the git helper on {} failed: {last}", self.target.dest()),
                ))
            }
        }
    }
}

impl Runner for RemoteGit {
    fn run(&self, dir: &str, call: &Call<'_>) -> Result<Raw, GitError> {
        check_allowed(call)?;
        validate_dir(dir)?;
        let cap = call.cap.to_string();
        let timeout = call.timeout.as_secs().max(1).to_string();
        let env: Vec<String> = ENV.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let mut args: Vec<&str> = vec!["run", dir, &cap, &timeout];
        args.extend(env.iter().map(String::as_str));
        args.push("--");
        args.extend_from_slice(PRELUDE);
        args.extend_from_slice(call.args);
        let out = self.helper(&args, call.stdin, call.timeout)?;
        let split = out
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| protocol("a reply"))?;
        let header: Header =
            serde_json::from_slice(&out[..split]).map_err(|_| protocol("a reply"))?;
        let stdout = out[split + 1..].to_vec();
        if stdout.len() != header.len {
            return Err(protocol("a reply of the wrong length"));
        }
        Ok(Raw {
            code: header.code,
            stdout,
            truncated: header.truncated,
            stderr: header.stderr,
        })
    }

    fn probe(&self, root: &str, paths: &[String]) -> Result<Vec<Option<Probe>>, GitError> {
        validate_dir(root)?;
        for path in paths {
            super::validate_rel(path)?;
        }
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut stdin = Vec::new();
        for path in paths {
            stdin.extend_from_slice(path.as_bytes());
            stdin.push(0);
        }
        let out = self.helper(&["probe", root], &stdin, Duration::from_secs(60))?;
        let answers: Vec<Option<(Option<u32>, bool, u64)>> =
            serde_json::from_slice(&out).map_err(|_| protocol("a list"))?;
        if answers.len() != paths.len() {
            return Err(protocol("a list of the wrong length"));
        }
        Ok(answers
            .into_iter()
            .map(|a| {
                a.map(|(lines, binary, size)| Probe {
                    lines,
                    binary,
                    size,
                })
            })
            .collect())
    }
}
