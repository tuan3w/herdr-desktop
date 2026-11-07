//! How `ssh` is started: the argument list, the shared connection directory and one-shot remote commands.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use super::classify::{SSH_FAILED, classify_ssh};
use super::proc::{Proc, spawn};
use super::relay::argv_command;
use super::validate::SshTarget;
use crate::wire::{Fatal, WireError};

mod forward;

/// ssh appends `.` and 16 random characters to the control socket path while it sets the master up.
const CONTROL_SUFFIX: usize = 17;
/// `%C` expands to a 40 character hash.
const CONTROL_HASH: usize = 40;
/// `sun_path` holds 108 bytes on Linux and 104 on macOS, each with the terminating NUL.
const SUN_PATH_MAX: usize = if cfg!(target_os = "macos") { 103 } else { 107 };
/// The longest control directory that still fits `<dir>/<hash>` plus ssh's setup suffix.
const CONTROL_DIR_MAX: usize = SUN_PATH_MAX - CONTROL_SUFFIX - 1 - CONTROL_HASH;

/// How long a one-shot remote command may take to start answering is the caller's `timeout`; this is
/// how long its output readers get to finish after the process has exited.
const OUTPUT_GRACE: Duration = Duration::from_secs(5);

/// What a remote command printed and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// The remote command's exit status.
    pub code: i32,
    /// Everything it wrote to stdout.
    pub stdout: Vec<u8>,
    /// Everything it wrote to stderr, lossily decoded.
    pub stderr: String,
}

/// The local `ssh` and where its shared connections live. Cheap to clone.
#[derive(Debug, Clone)]
pub struct SshClient {
    program: OsString,
    program_args: Vec<OsString>,
    control_dir: PathBuf,
    config_file: Option<PathBuf>,
    options: Vec<String>,
}

impl SshClient {
    /// An ssh client whose control sockets live in a private directory chosen for `data_dir`
    /// (see [`control_dir_for`]).
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        Ok(Self::with_control_dir(control_dir_for(data_dir)?))
    }

    /// An ssh client with an explicit, already created control directory.
    pub fn with_control_dir(control_dir: PathBuf) -> Self {
        Self {
            program: "ssh".into(),
            program_args: Vec::new(),
            control_dir,
            config_file: None,
            options: Vec::new(),
        }
    }

    /// Uses another ssh executable (tests substitute a stand-in).
    pub fn program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    /// Adds an argument that goes before ssh's own, for a launcher such as `sh stand-in-script`
    /// (running a script through its interpreter avoids executing a file another test thread may
    /// still hold open for writing).
    pub fn program_arg(mut self, arg: impl Into<OsString>) -> Self {
        self.program_args.push(arg.into());
        self
    }

    /// Reads this config file (`ssh -F`) instead of the user's.
    pub fn config_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_file = Some(path.into());
        self
    }

    /// Adds an `-o key=value` option after the standard ones.
    pub fn option(mut self, option: impl Into<String>) -> Self {
        self.options.push(option.into());
        self
    }

    /// The directory holding the shared connection sockets.
    pub fn control_dir(&self) -> &Path {
        &self.control_dir
    }

    /// The full ssh argument list for `target`. `remote` is the single remote command word, or
    /// `None` for a control request such as `-O exit` (passed in `extra`).
    ///
    /// The destination always follows `--`, so a destination can never be read as an option, and
    /// nothing here goes through a local shell: the result is passed to `Command::args`.
    pub fn args(&self, target: &SshTarget, extra: &[&str], remote: Option<&str>) -> Vec<OsString> {
        let mut args: Vec<OsString> = self.program_args.clone();
        if let Some(config) = &self.config_file {
            args.extend(["-F".into(), config.clone().into_os_string()]);
        }
        for option in [
            "BatchMode=yes",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ControlMaster=auto",
            "ControlPersist=120",
        ] {
            args.extend(["-o".into(), option.into()]);
        }
        let mut control_path = self.control_dir.clone().into_os_string();
        control_path.push("/%C");
        let mut option = OsString::from("ControlPath=");
        option.push(control_path);
        args.extend(["-o".into(), option]);
        for option in &self.options {
            args.extend(["-o".into(), option.into()]);
        }
        if let Some(port) = target.port() {
            args.extend(["-p".into(), port.to_string().into()]);
        }
        args.extend(extra.iter().map(OsString::from));
        args.push("--".into());
        args.push(target.dest().into());
        args.extend(remote.map(OsString::from));
        args
    }

    /// A `Command` that runs `remote` on `target`, stdio piped.
    pub(crate) fn command(&self, target: &SshTarget, remote: &str) -> Command {
        let mut command = Command::new(&self.program);
        command.args(self.args(target, &[], Some(remote)));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// Tells the shared connection to `target`'s ssh master to exit (`ssh -O exit`), so the
    /// connection this app opened does not linger for `ControlPersist` seconds after the app quit.
    pub fn close_master(&self, target: &SshTarget) {
        let mut command = Command::new(&self.program);
        command.args(self.args(target, &["-O", "exit"], None));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Nothing to do on failure: no master means nothing was lingering.
        let _ = command.status();
    }

    /// Runs `argv` on `target` (each word quoted, never joined into shell syntax), feeds it `stdin`
    /// and collects its output, over the same shared connection as the relay.
    ///
    /// A remote command that ends with any status is an `Ok` with that status; an `Err` means ssh
    /// itself failed (classified like [`classify_ssh`]), the command could not be started, or it
    /// did not finish within `timeout` (its ssh process is then killed by PID).
    pub fn run_checked(
        &self,
        target: &SshTarget,
        argv: &[&str],
        stdin: &[u8],
        timeout: Duration,
    ) -> Result<Output, WireError> {
        if argv.first().is_none_or(|program| program.is_empty()) {
            return Err(WireError::fatal(
                Fatal::Protocol,
                "no remote command to run",
            ));
        }
        let mut command = self.command(target, &argv_command(argv));
        let spawned = spawn(&mut command).map_err(spawn_error)?;
        let (proc, mut stdin_pipe, mut stdout_pipe) = (spawned.proc, spawned.stdin, spawned.stdout);
        let input = stdin.to_vec();
        // Writing and reading on separate threads: a command that answers before it has read all of
        // its input (or fills the pipe) would otherwise deadlock against us.
        std::thread::spawn(move || {
            let _ = stdin_pipe.write_all(&input);
        });
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
        let Some(exit) = proc.wait_exit(timeout) else {
            proc.kill();
            return Err(WireError::retryable(format!(
                "{} did not answer in time",
                target.dest()
            )));
        };
        match exit.code {
            Some(code) if code != SSH_FAILED => {
                let stdout = rx.recv_timeout(OUTPUT_GRACE).unwrap_or_default();
                Ok(Output {
                    code,
                    stdout,
                    stderr: exit.stderr,
                })
            }
            code => Err(classify_ssh(code, &exit.stderr, target.dest())),
        }
    }
}

/// `ssh` could not be started at all.
pub(crate) fn spawn_error(e: std::io::Error) -> WireError {
    if e.kind() == std::io::ErrorKind::NotFound {
        WireError::fatal(
            Fatal::SshMissing,
            "ssh is not installed: install an OpenSSH client",
        )
    } else {
        WireError::retryable(format!("could not start ssh: {e}"))
    }
}

/// Where to keep control sockets for an app whose data lives in `data_dir`: a private (0700)
/// directory short enough for a unix socket path.
///
/// Preference: `<data_dir>/ssh`, then `$XDG_RUNTIME_DIR/herdr-desktop`, then `<temp>/herdr-desktop-<uid>`,
/// then `/tmp/herdr-desktop-<uid>`. A typical data directory is too long (a socket path may be about 100
/// bytes, ssh adds a 40 character hash and a 17 character suffix), which is why this is not always the
/// first. On a Mac the data directory is `~/Library/Application Support/...` and `temp_dir()` is
/// `/var/folders/xx/<28 characters>/T`: both too long for its 104 byte limit, and there is no
/// `XDG_RUNTIME_DIR`, so the short `/tmp` one is what is used there.
pub fn control_dir_for(data_dir: &Path) -> std::io::Result<PathBuf> {
    let uid = rustix::process::getuid().as_raw();
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty());
    let candidates = control_candidates(
        data_dir,
        runtime.map(PathBuf::from),
        &std::env::temp_dir(),
        uid,
    );
    let mut last_error = None;
    for dir in candidates {
        if dir.as_os_str().len() > CONTROL_DIR_MAX {
            continue;
        }
        match private_dir(&dir, uid) {
            Ok(()) => return Ok(dir),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::other("no short enough directory for ssh control sockets")
    }))
}

/// The directories [`control_dir_for`] tries, in order.
fn control_candidates(
    data_dir: &Path,
    runtime_dir: Option<PathBuf>,
    temp_dir: &Path,
    uid: u32,
) -> Vec<PathBuf> {
    let mut candidates = vec![data_dir.join("ssh")];
    if let Some(runtime) = runtime_dir {
        candidates.push(runtime.join("herdr-desktop"));
    }
    candidates.push(temp_dir.join(format!("herdr-desktop-{uid}")));
    candidates.push(PathBuf::from(format!("/tmp/herdr-desktop-{uid}")));
    candidates
}

/// Creates `dir` with mode 0700, or checks an existing one is ours and tightens it.
fn private_dir(dir: &Path, uid: u32) -> std::io::Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != uid {
        return Err(std::io::Error::other(format!(
            "{} is not a directory owned by you",
            dir.display()
        )));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Kills `proc` when dropped, so a one-shot helper never outlives its call.
pub(crate) struct KillOnDrop(pub std::sync::Arc<Proc>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.0.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mac_with_long_directories_everywhere_still_gets_a_control_directory_that_fits() {
        // macOS: `~/Library/Application Support/<id>` and `/var/folders/xx/<28>/T`, no XDG_RUNTIME_DIR.
        let data =
            Path::new("/Users/someone/Library/Application Support/dev.herdrmobile.herdr_desktop");
        let temp = Path::new("/var/folders/zz/abcdefghijklmnopqrstuvwxyz01/T");
        let candidates = control_candidates(data, None, temp, 501);
        // Its socket paths may be 103 bytes (104 with the NUL): 45 for the directory.
        let limit = 103 - CONTROL_SUFFIX - 1 - CONTROL_HASH;
        let fitting: Vec<_> = candidates
            .iter()
            .filter(|d| d.as_os_str().len() <= limit)
            .collect();
        assert_eq!(fitting, [&PathBuf::from("/tmp/herdr-desktop-501")]);
    }
}
