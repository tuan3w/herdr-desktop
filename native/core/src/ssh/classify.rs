//! Turns what `ssh` printed when it failed into a [`WireError`]: stop retrying, or try again.

use crate::wire::{Fatal, WireError};

/// ssh's own exit status for "the connection or authentication failed" (a remote command's status
/// is passed through instead, so only this value says the failure was ssh's).
pub const SSH_FAILED: i32 = 255;

/// The longest stderr excerpt put in an error message.
const EXCERPT_MAX: usize = 300;

/// Classifies a failed ssh run.
///
/// Only exit status 255 is read as ssh's own failure; any other status is the remote command's and
/// is retryable here (the caller that knows the command, such as the relay start-up, interprets it
/// first). Fatal kinds are the ones a retry cannot fix: an untrusted or changed host key and refused
/// authentication, each with the one thing the person should do. Everything else, including an
/// unresolvable name, a refused connection and a timeout, is retryable because the network, the
/// machine or its sshd may come back.
pub fn classify_ssh(code: Option<i32>, stderr: &str, dest: &str) -> WireError {
    if code == Some(SSH_FAILED) {
        let text = stderr.to_ascii_lowercase();
        // "REMOTE HOST IDENTIFICATION HAS CHANGED" also ends with "Host key verification failed", so
        // the changed key is checked first.
        if text.contains("remote host identification has changed")
            || text.contains("host key for") && text.contains("has changed")
            || text.contains("offending") && text.contains("key in")
        {
            return WireError::fatal(
                Fatal::HostKeyChanged,
                format!(
                    "The host key of {dest} has changed: it may be a different machine or someone in between. \
                     If you expected this, remove the old key with `ssh-keygen -R {dest}`, then run `ssh {dest}` once in a terminal."
                ),
            );
        }
        if text.contains("host key verification failed")
            || text.contains("no matching host key type")
        {
            return WireError::fatal(
                Fatal::HostKeyUnknown,
                format!(
                    "{dest} is not trusted yet: run `ssh {dest}` once in a terminal to trust the host."
                ),
            );
        }
        if text.contains("permission denied") || text.contains("too many authentication failures") {
            return WireError::fatal(
                Fatal::AuthFailed,
                format!(
                    "{dest} did not accept any key: run `ssh {dest}` once in a terminal to log in. \
                     Password login is not supported; add your key to the machine."
                ),
            );
        }
    }
    WireError::retryable(describe(code, stderr))
}

/// ssh lines that are not complaints: first-contact notices and the mux client's goodbye.
fn is_noise(line: &str) -> bool {
    line.is_empty()
        || line.starts_with("Warning: Permanently added")
        || line.starts_with("Shared connection to ")
}

/// Whether ssh said anything about a failure (as opposed to nothing, or only notices).
pub(crate) fn has_complaint(stderr: &str) -> bool {
    stderr.lines().map(str::trim).any(|l| !is_noise(l))
}

/// The last complaint on stderr, or the exit status when there is none.
fn describe(code: Option<i32>, stderr: &str) -> String {
    let last = stderr.lines().map(str::trim).rfind(|l| !is_noise(l));
    match (last, code) {
        (Some(line), _) => excerpt(line),
        (None, Some(code)) => format!("ssh exited with status {code}"),
        (None, None) => "ssh was stopped".to_owned(),
    }
}

fn excerpt(line: &str) -> String {
    match line.char_indices().nth(EXCERPT_MAX) {
        Some((end, _)) => format!("{}…", &line[..end]),
        None => line.to_owned(),
    }
}
