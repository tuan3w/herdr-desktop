//! Running the keeper on a machine: this computer, or another one over the shared ssh connection.
//!
//! The keeper is one python3 file (herdr-mobile's `keeper_script.dart`, baked into the dependency) that owns
//! an agent process so the agent outlives whoever started it. Locally it is written to
//! `~/.herdr-mobile/desktop/keeper-desktop.py`; on a remote machine to
//! `~/.herdr-mobile/desktop/keeper-<version>.py` over the machine's ControlMaster, with the script on stdin
//! (base64 of zlib data: some sshd refuse a long command line, and a command line is not for payloads).
//! Everything that reaches the remote shell is validated first and single-quoted by [`shq`], and the whole
//! remote script travels base64-wrapped so the login shell (fish, csh) sees one word.
//!
//! A command that ends 65 (the script is not there) installs it and runs once more. The app never starts
//! anything on a machine on its own initiative except what the person asked for: the poller only lists
//! ([`KeeperHost::list_if_installed`]) and never installs.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use serde_json::Value;

use super::adapter;
use super::error::{KeeperError, exit};
use super::records::{KeeperInfo, PastSessions, Route};
use crate::ssh::{Output, Proc, SshClient, SshTarget, argv_command, base64, shq, spawn};
use crate::wire::WireError;

/// Longest folder or file path accepted: far above PATH_MAX, far below the command limit.
const MAX_PATH: usize = 4096;
/// `probe` and `list` print one line at once.
const QUICK: Duration = Duration::from_secs(30);
/// `start` waits for the agent to answer `initialize` (the keeper allows it 120 s) and then some.
const START: Duration = Duration::from_secs(150);
/// `history` asks the agent for up to five pages at 30 s each.
const HISTORY: Duration = Duration::from_secs(180);
/// How long the output readers get once a local command has ended.
const GRACE: Duration = Duration::from_secs(5);

/// The environment a keeper must not inherit: it would report its agent to a herdr pane the app was
/// launched from, or open a second pane for a session the app shows itself.
const HERDR_ENV: [&str; 6] = [
    "HERDR_SOCKET_PATH",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_BIN_PATH",
];

const NEED_PYTHON: &str = "if ! command -v python3 >/dev/null 2>&1; then\n  \
    echo \"herdr-mobile: agent sessions need python3 on this host\" >&2\n  exit 78\nfi\n";

/// Writes the deflated script it reads (base64) from stdin to `~/.herdr-mobile/desktop/keeper-<version>.py`
/// (temp file in the same directory, then rename, 0700), and removes other versions.
const INSTALLER: &str = r#"import base64,os,sys,time,zlib
b=os.path.join(os.path.expanduser("~"),".herdr-mobile")
d=os.path.join(b,"desktop")
os.makedirs(b,0o700,exist_ok=True)
os.makedirs(d,0o700,exist_ok=True)
os.chmod(b,0o700)
os.chmod(d,0o700)
n="keeper-"+sys.argv[1]+".py"
data=zlib.decompress(base64.b64decode(sys.stdin.read()))
t=os.path.join(d,"."+n+".tmp%d"%os.getpid())
f=os.fdopen(os.open(t,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o700),"wb")
f.write(data)
f.close()
os.chmod(t,0o700)
os.replace(t,os.path.join(d,n))
for o in os.listdir(d):
  p=os.path.join(d,o)
  try:
    if o.startswith("keeper-") and o.endswith(".py") and o!=n:
      os.unlink(p)
    elif o.startswith(".keeper-") and ".tmp" in o and time.time()-os.path.getmtime(p)>60:
      os.unlink(p)
  except OSError:
    pass
print('{"ok":true}')
"#;

/// Where a keeper's commands run.
enum Transport {
    /// This computer: `python3 <script> <args>` as a child process.
    Local { env: Vec<(OsString, OsString)> },
    /// Another machine: the same script through the machine's shared ssh connection.
    Remote {
        client: SshClient,
        target: SshTarget,
    },
}

/// A machine's keeper: probes, lists, starts, kills and attaches. Cheap to share behind an `Arc`.
pub struct KeeperHost {
    transport: Transport,
    /// The person's home on this computer: where the local script lives and where a remote install's
    /// source is read from.
    home: PathBuf,
    script: OnceLock<Result<Arc<Script>, String>>,
    /// A command has worked since the script was last found missing.
    installed: AtomicBool,
}

/// The keeper script this build carries and the version a remote machine's copy is named by.
struct Script {
    path: PathBuf,
    text: String,
    version: String,
}

impl KeeperHost {
    /// The keeper of this computer, with `home` as the person's home folder.
    pub fn local(home: impl Into<PathBuf>) -> Self {
        Self::new(Transport::Local { env: Vec::new() }, home.into())
    }

    /// The keeper of another machine, reached through `client`'s shared connection. `home` is this
    /// computer's home folder (the install's source script is read from there).
    pub fn remote(client: SshClient, target: SshTarget, home: impl Into<PathBuf>) -> Self {
        Self::new(Transport::Remote { client, target }, home.into())
    }

    fn new(transport: Transport, home: PathBuf) -> Self {
        Self {
            transport,
            home,
            script: OnceLock::new(),
            installed: AtomicBool::new(false),
        }
    }

    /// Runs local commands with this environment variable set (the keeper finds agents through `PATH`
    /// and keeps its files under `HOME`). A no-op for a remote machine.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        if let Transport::Local { env } = &mut self.transport {
            env.push((key.into(), value.into()));
        }
        self
    }

    /// Whether this is the computer the app runs on.
    pub fn is_local(&self) -> bool {
        matches!(self.transport, Transport::Local { .. })
    }

    fn script(&self) -> Result<Arc<Script>, KeeperError> {
        self.script
            .get_or_init(|| {
                let path = adapter::ensure_script(&self.home)
                    .map_err(|e| format!("Could not write the keeper script: {e}"))?;
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| format!("Could not read the keeper script: {e}"))?;
                let version = script_version(&text);
                Ok(Arc::new(Script {
                    path,
                    text,
                    version,
                }))
            })
            .clone()
            .map_err(KeeperError::Other)
    }

    // ---- commands -----------------------------------------------------------------------------

    /// The agents this machine can run, as the start form lists them.
    pub fn probe(&self) -> Result<Vec<Route>, KeeperError> {
        let out = self.run(
            &["probe"],
            QUICK,
            true,
            "ask the machine which agents it has",
        )?;
        let value = first_json(&out.stdout)?;
        let ids: Vec<&str> = value
            .get("routes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        Ok(adapter::routes()
            .into_iter()
            .filter(|r| ids.contains(&r.id.as_str()))
            .collect())
    }

    /// Every keeper on the machine that is running or whose agent exited within a day, newest first.
    pub fn list(&self) -> Result<Vec<KeeperInfo>, KeeperError> {
        self.list_with(true)
    }

    /// [`list`](Self::list) without installing the script when it is missing: a poll never changes a
    /// machine. Fails with [`KeeperError::NotInstalled`] then.
    pub fn list_if_installed(&self) -> Result<Vec<KeeperInfo>, KeeperError> {
        self.list_with(false)
    }

    fn list_with(&self, install: bool) -> Result<Vec<KeeperInfo>, KeeperError> {
        let out = self.run(&["list"], QUICK, install, "list the sessions")?;
        let value = first_json(&out.stdout)?;
        serde_json::from_value(value)
            .map_err(|e| KeeperError::Other(format!("The session list could not be read: {e}")))
    }

    /// Starts a keeper that runs `agent` in `cwd` and returns it once the agent has answered `initialize`.
    /// The keeper outlives this app.
    pub fn start(&self, agent: &str, cwd: &str) -> Result<KeeperInfo, KeeperError> {
        validate_agent(agent)?;
        validate_path("folder", cwd)?;
        let out = self.run(
            &["start", "--agent", agent, "--cwd", cwd],
            START,
            true,
            "start the session",
        )?;
        let info: KeeperInfo = serde_json::from_value(first_json(&out.stdout)?).map_err(|_| {
            KeeperError::Other("The keeper started but its answer could not be read.".into())
        })?;
        if !valid_id(&info.id) {
            return Err(KeeperError::Other("The keeper named no session.".into()));
        }
        Ok(info)
    }

    /// Ends keeper `id` for good: its agent and its record. The caller decides whether this app may
    /// (see `SessionHub::kill`); the command itself ends whatever it is told to.
    pub fn kill(&self, id: &str) -> Result<(), KeeperError> {
        validate_id(id)?;
        self.run(&["kill", id], QUICK, true, "end the session")?;
        Ok(())
    }

    /// What `agent` remembers (its own store of past sessions), in `cwd` or everywhere.
    pub fn history(&self, agent: &str, cwd: Option<&str>) -> Result<PastSessions, KeeperError> {
        validate_agent(agent)?;
        let mut args = vec!["history", agent];
        if let Some(cwd) = cwd {
            validate_path("folder", cwd)?;
            args.push(cwd);
        }
        let out = self.run(&args, HISTORY, true, "read the agent's past sessions")?;
        PastSessions::from_value(&first_json(&out.stdout)?)
            .ok_or_else(|| KeeperError::Other("The past sessions could not be read.".into()))
    }

    /// Opens the connection to keeper `id`: the child process whose stdio carries the JSON-RPC lines.
    /// Closing its stdin detaches (the agent keeps running).
    pub(super) fn attach(&self, id: &str) -> Result<Attach, KeeperError> {
        validate_id(id)?;
        self.channel(&["attach", id])
    }

    /// Follows the agent's session log `path` (absolute, `.jsonl`, under the host user's home: the keeper
    /// refuses anything else with exit 66): first the tail (the last `tail_bytes`, default 192 KB, from a line
    /// start), or with `from` everything after that byte offset; then every complete line that is appended.
    /// The child's stdout is the records `<endOffset>\t<json>`, `S\t<offset>` (where a tail read begins),
    /// `R\t<offset>` (the file shrank or was replaced), `C\t<offset>` (caught up) and `E\t<message>`; remote
    /// output travels deflated (`--z`). Closing stdin ends it.
    pub(crate) fn follow(
        &self,
        path: &str,
        from: Option<u64>,
        tail_bytes: Option<u64>,
    ) -> Result<Attach, KeeperError> {
        validate_path("log path", path)?;
        let (from, tail) = (
            from.map(|n| n.to_string()),
            tail_bytes.map(|n| n.to_string()),
        );
        let mut args = vec!["follow", path];
        if let Some(from) = &from {
            args.extend(["--from", from]);
        }
        if let Some(tail) = &tail {
            args.extend(["--tail-bytes", tail]);
        }
        self.channel(&args)
    }

    /// The bytes of a picture the follower left out of the log line that begins at byte `start` of `path`
    /// (its note said `ref=<start>.<hash>`): the host reads the line again and sends the payload that hashes
    /// to `hash`.
    pub(crate) fn blob(&self, path: &str, start: u64, hash: &str) -> Result<Vec<u8>, KeeperError> {
        validate_path("log path", path)?;
        if hash.len() != 16 || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(KeeperError::Invalid(
                "That is not a picture reference.".into(),
            ));
        }
        let start = start.to_string();
        let out = self.run(
            &["blob", path, &start, hash],
            HISTORY,
            true,
            "read the picture",
        )?;
        let mut data = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(piece) = line.strip_prefix("B\t") {
                let part = super::lines::decode_base64(piece.as_bytes())
                    .ok_or_else(|| KeeperError::Other("The picture is not base64 text.".into()))?;
                data.extend_from_slice(&part);
            }
        }
        Ok(data)
    }

    /// Spawns `python3 keeper <args>` with piped stdio on this machine (a long-lived channel). The script is
    /// checked for first: a channel that exits 65 would only show as a closed connection.
    fn channel(&self, args: &[&str]) -> Result<Attach, KeeperError> {
        if !self.installed.load(Ordering::Relaxed) {
            self.run(&["probe"], QUICK, true, "reach the machine")?;
        }
        let zipped = !self.is_local();
        let mut args = args.to_vec();
        if zipped {
            args.push("--z");
        }
        let mut command = match &self.transport {
            Transport::Local { .. } => self.local_command(&args)?,
            Transport::Remote { client, target } => client.command(
                target,
                &argv_command(&["sh", "-c", &self.remote_script(&args)?]),
            ),
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let spawned =
            spawn(&mut command).map_err(|e| KeeperError::Wire(crate::ssh::spawn_error(e)))?;
        Ok(Attach {
            proc: spawned.proc,
            stdin: Some(spawned.stdin),
            stdout: Some(spawned.stdout),
            zipped,
        })
    }

    // ---- plumbing -----------------------------------------------------------------------------

    /// Runs one keeper command; on exit 65 (and when `install`) installs the script and runs it again.
    fn run(
        &self,
        args: &[&str],
        timeout: Duration,
        install: bool,
        what: &str,
    ) -> Result<Output, KeeperError> {
        let mut out = self.exec(args, timeout)?;
        if out.code == exit::NOT_INSTALLED {
            self.installed.store(false, Ordering::Relaxed);
            if install {
                self.install()?;
                out = self.exec(args, timeout)?;
            }
        }
        if out.code != 0 {
            return Err(KeeperError::from_exit(out.code, &out.stderr, what));
        }
        self.installed.store(true, Ordering::Relaxed);
        Ok(out)
    }

    fn exec(&self, args: &[&str], timeout: Duration) -> Result<Output, KeeperError> {
        match &self.transport {
            Transport::Local { .. } => {
                let mut command = self.local_command(args)?;
                run_local(&mut command, timeout)
            }
            Transport::Remote { client, target } => {
                let script = self.remote_script(args)?;
                Ok(client.run_checked(target, &["sh", "-c", &script], &[], timeout)?)
            }
        }
    }

    /// `python3 <script> <args>` with the keeper's environment.
    fn local_command(&self, args: &[&str]) -> Result<Command, KeeperError> {
        let Transport::Local { env } = &self.transport else {
            return Err(KeeperError::Other("not a local machine".into()));
        };
        let script = self.script()?;
        let mut command = Command::new("python3");
        command.arg(&script.path).args(args);
        for key in HERDR_ENV {
            command.env_remove(key);
        }
        // The session is shown here: the keeper must not open a second herdr pane running its own viewer.
        command
            .env("HERDR_MOBILE_NO_PANE", "1")
            .env("HOME", &self.home);
        for (key, value) in env {
            command.env(key, value);
        }
        command.stdin(Stdio::null());
        Ok(command)
    }

    /// The remote shell script that runs the installed keeper with `args`. Every argument is quoted by
    /// [`shq`]; the script itself travels base64-wrapped (see [`argv_command`]).
    fn remote_script(&self, args: &[&str]) -> Result<String, KeeperError> {
        let script = self.script()?;
        let words: Vec<String> = args.iter().map(|a| shq(a)).collect();
        Ok(format!(
            "{NEED_PYTHON}f=\"$HOME/.herdr-mobile/desktop/keeper-{version}.py\"\n\
             if [ ! -f \"$f\" ]; then\n  \
             echo \"herdr-mobile: the keeper is not installed on this host\" >&2\n  exit 65\nfi\n\
             unset {unset}\n\
             HERDR_MOBILE_NO_PANE=1 exec python3 \"$f\" {words}\n",
            version = script.version,
            unset = HERDR_ENV.join(" "),
            words = words.join(" "),
        ))
    }

    /// Puts the script on a remote machine. Idempotent.
    fn install(&self) -> Result<(), KeeperError> {
        let Transport::Remote { client, target } = &self.transport else {
            // The local script is written by `ensure_script` on first use.
            self.script()?;
            return Ok(());
        };
        let script = self.script()?;
        let payload = install_payload(&script.text)?;
        let run = format!(
            "{NEED_PYTHON}exec python3 -c {} {}\n",
            shq(INSTALLER),
            shq(&script.version)
        );
        let out = client.run_checked(target, &["sh", "-c", &run], payload.as_bytes(), QUICK)?;
        if out.code != 0 {
            return Err(KeeperError::from_exit(
                out.code,
                &out.stderr,
                "install the agent helper",
            ));
        }
        Ok(())
    }
}

/// The deflated script as base64 in lines of 76 characters.
fn install_payload(script: &str) -> Result<String, KeeperError> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::best());
    z.write_all(script.as_bytes())
        .and_then(|()| z.finish())
        .map(|packed| {
            let b64 = base64(&packed);
            let mut out = String::with_capacity(b64.len() + b64.len() / 76 + 1);
            for chunk in b64.as_bytes().chunks(76) {
                out.push_str(&String::from_utf8_lossy(chunk));
                out.push('\n');
            }
            out
        })
        .map_err(|e| KeeperError::Other(format!("Could not pack the keeper script: {e}")))
}

/// FNV-1a 64 over the text, the first 12 hex digits: a changed script is a new file name on the machine.
fn script_version(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")[..12].to_owned()
}

/// A keeper's id: lower case letters and digits, 3 to 32.
pub fn valid_id(id: &str) -> bool {
    (3..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn validate_id(id: &str) -> Result<(), KeeperError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(KeeperError::Invalid("That is not a session id.".into()))
    }
}

fn validate_agent(agent: &str) -> Result<(), KeeperError> {
    if adapter::routes().iter().any(|r| r.id == agent) {
        Ok(())
    } else {
        Err(KeeperError::Invalid(format!("Unknown agent `{agent}`.")))
    }
}

/// Not empty, not absurdly long, no control character (a newline would end the word in a remote
/// shell's eyes): what every path that reaches a command must be before it is quoted.
fn validate_path(what: &str, path: &str) -> Result<(), KeeperError> {
    if path.is_empty() {
        return Err(KeeperError::Invalid(format!("The {what} is empty.")));
    }
    if path.len() > MAX_PATH {
        return Err(KeeperError::Invalid(format!("The {what} is too long.")));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(KeeperError::Invalid(format!(
            "The {what} holds a control character."
        )));
    }
    Ok(())
}

/// The first JSON line of a command's output.
fn first_json(stdout: &[u8]) -> Result<Value, KeeperError> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    serde_json::from_str(line)
        .map_err(|_| KeeperError::Other("The machine's answer could not be read.".into()))
}

/// Runs a local command to the end with its output collected; kills it by PID when it takes longer than
/// `timeout`.
fn run_local(command: &mut Command, timeout: Duration) -> Result<Output, KeeperError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let spawned = spawn(command).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            KeeperError::NoPython("Agent sessions need python3 on this machine.".into())
        } else {
            KeeperError::Other(format!("Could not start python3: {e}"))
        }
    })?;
    drop(spawned.stdin);
    let mut stdout = spawned.stdout;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let Some(exit) = spawned.proc.wait_exit(timeout) else {
        spawned.proc.kill();
        return Err(KeeperError::Wire(WireError::retryable(
            "The command did not answer in time.",
        )));
    };
    Ok(Output {
        code: exit.code.unwrap_or(-1),
        stdout: rx.recv_timeout(GRACE).unwrap_or_default(),
        stderr: exit.stderr,
    })
}

/// The connection of one attached session: a child process whose stdin and stdout carry JSON-RPC lines.
pub(crate) struct Attach {
    pub proc: Arc<Proc>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    /// The keeper was asked to deflate what it writes (`attach --z`).
    pub zipped: bool,
}

impl Attach {
    /// Closes the connection politely (the keeper sees stdin end and detaches), then makes sure the
    /// child is gone by its PID.
    pub(crate) fn close(&mut self) {
        self.stdin = None;
        if self.proc.wait_exit(Duration::from_secs(3)).is_none() {
            self.proc.kill();
        }
    }

    /// Writes one line.
    pub(crate) fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::other("the connection is closed"))?;
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        stdin.write_all(&bytes)?;
        stdin.flush()
    }
}

/// The path of the keeper script on this computer (for tests and diagnostics).
pub fn local_script_path(home: &Path) -> std::io::Result<PathBuf> {
    adapter::ensure_script(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_that_could_end_a_shell_word_is_refused_before_anything_runs() {
        for bad in ["", "a\nb", "a\u{7f}b", "x\0y", &"x".repeat(MAX_PATH + 1)] {
            assert!(validate_path("folder", bad).is_err(), "{bad:?}");
        }
        for fine in [
            "/tmp/a b",
            "~/x",
            "/tmp/'; rm -rf ~ #",
            "/tmp/$(id)",
            "/tmp/`id`",
        ] {
            assert!(validate_path("folder", fine).is_ok(), "{fine:?}");
        }
    }

    #[test]
    fn only_known_agents_and_well_formed_ids_pass() {
        assert!(validate_agent("omp").is_ok());
        assert!(validate_agent("omp; id").is_err());
        assert!(validate_id("abc234").is_ok());
        for bad in ["ab", "A1b2c3", "abc 234", "abc;id", &"a".repeat(33)] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_install_payload_inflates_back_to_the_script() {
        let packed = install_payload("print('hi')\n").expect("payload");
        assert!(packed.lines().all(|l| l.len() <= 76));
        let bytes = super::super::lines::decode_base64(packed.as_bytes()).expect("base64");
        let mut out = String::new();
        flate2::read::ZlibDecoder::new(bytes.as_slice())
            .read_to_string(&mut out)
            .expect("zlib");
        assert_eq!(out, "print('hi')\n");
    }
}
