//! Remote machines: validation and quoting, the python relay, and `SshWire` end to end.
//!
//! Everything but the one `#[ignore]`d test runs without a network: the relay is the real `relay.py`
//! on a local python3, and `SshWire` talks through a stand-in `ssh` script that runs the remote
//! command locally with `sh -c` (so the real generated remote command, base64 wrapper and all, is
//! what executes). The stand-in also plays the failures ssh reports.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, unbounded};
use herdr_core::ssh::{
    COMPRESS_MIN, InvalidTarget, READY_LINE, RELAY_SCRIPT, SshClient, SshTarget, SshWire,
    argv_command, classify_ssh, config_hosts, control_dir_for, shq, validate_dest, validate_name,
};
use herdr_core::testing::{FakeHerdr, Script};
use herdr_core::wire::{ErrorKind, Fatal, Wire};
use serde_json::{Value, json};

const T: Duration = Duration::from_secs(20);

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

fn write_executable(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Polls `condition` until it holds; a test never sleeps a fixed time.
fn eventually(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + T;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn process_is_gone(pid: u32) -> bool {
    !Path::new(&format!("/proc/{pid}")).exists()
}

// ---- validation and quoting ------------------------------------------------------------------

#[test]
fn destinations_that_could_be_options_or_shell_syntax_are_rejected() {
    for ok in [
        "host",
        "user@host.example.com",
        "my-alias_2",
        "10.0.0.5",
        "user@[fe80::1]",
        "a:22",
        "x".repeat(255).as_str(),
    ] {
        assert!(validate_dest(ok).is_ok(), "{ok} should be accepted");
    }
    for bad in [
        "",
        "-oProxyCommand=touch pwned",
        "-host",
        "host name",
        "host;reboot",
        "host`id`",
        "$(id)",
        "host\nother",
        "user@host'",
        "ho/st",
        "häst",
        &"x".repeat(256),
    ] {
        assert!(validate_dest(bad).is_err(), "{bad:?} should be rejected");
    }
}

#[test]
fn session_names_are_plain_and_cannot_climb_directories() {
    for ok in ["work", "a.b_c-d", "2"] {
        assert!(validate_name(ok).is_ok());
    }
    for bad in ["", "a b", "a/b", "..", ".", "a;b", "a'b", "$HOME"] {
        assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
    }
}

#[test]
fn a_target_refuses_every_bad_part_before_anything_can_spawn() {
    assert!(SshTarget::new("host", Some(22), Some("work"), Some("/run/herdr.sock")).is_ok());
    let field = |t: Result<SshTarget, InvalidTarget>| t.unwrap_err().field;
    assert_eq!(field(SshTarget::new("-x", None, None, None)), "destination");
    assert_eq!(field(SshTarget::new("host", Some(0), None, None)), "port");
    assert_eq!(
        field(SshTarget::new("host", None, Some("a b"), None)),
        "session"
    );
    assert_eq!(
        field(SshTarget::new(
            "host",
            None,
            None,
            Some("relative/herdr.sock")
        )),
        "socket path"
    );
}

#[test]
fn the_default_session_is_the_same_with_or_without_its_name() {
    let named = SshTarget::new("host", None, Some("default"), None).unwrap();
    let unnamed = SshTarget::new("host", None, None, None).unwrap();
    assert_eq!(named, unnamed);
    assert_eq!(named.session(), "default");
}

fn hostile_strings(marker_dir: &Path) -> Vec<String> {
    let m = marker_dir.display();
    vec![
        format!("; rm -rf ~ ; touch {m}/pwned"),
        format!("`touch {m}/pwned`"),
        format!("$(touch {m}/pwned)"),
        format!("&& touch {m}/pwned"),
        format!("| touch {m}/pwned"),
        "line one\nline two\n".to_owned(),
        "it's a 'quoted' value".to_owned(),
        "'; echo pwned; '".to_owned(),
        "$HOME ${PATH} $((1+1))".to_owned(),
        "back\\slash \"double\" *glob* ~tilde".to_owned(),
        "-n -e \\n".to_owned(),
        "  spaces around  ".to_owned(),
        "ünïcode 日本語".to_owned(),
    ]
}

#[test]
fn a_quoted_string_reaches_the_shell_as_exactly_that_string() {
    let dir = tempfile::tempdir().unwrap();
    for value in hostile_strings(dir.path()) {
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {}", shq(&value)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), value, "{value:?}");
    }
    assert!(
        !dir.path().join("pwned").exists(),
        "a hostile string was executed"
    );
}

#[test]
fn a_command_survives_the_remote_login_shell_whatever_its_words_hold() {
    let dir = tempfile::tempdir().unwrap();
    for value in hostile_strings(dir.path()) {
        let remote = argv_command(&["printf", "%s", &value]);
        let out = Command::new("sh").arg("-c").arg(&remote).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), value, "{value:?}");
        // The remote command is one quote-free-of-script word even for a shell that is not sh.
        assert!(!remote.contains(&value) || value.chars().all(|c| c.is_ascii_alphanumeric()));
    }
    assert!(
        !dir.path().join("pwned").exists(),
        "a hostile string was executed"
    );
}

// ---- classification --------------------------------------------------------------------------

#[test]
fn ssh_failures_are_fatal_only_when_a_retry_cannot_help() {
    let changed = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
                   Offending ED25519 key in /home/u/.ssh/known_hosts:3\nHost key verification failed.";
    let cases: Vec<(Option<i32>, &str, Option<Fatal>)> = vec![
        (
            Some(255),
            "Host key verification failed.",
            Some(Fatal::HostKeyUnknown),
        ),
        (Some(255), changed, Some(Fatal::HostKeyChanged)),
        (
            Some(255),
            "u@h: Permission denied (publickey,password).",
            Some(Fatal::AuthFailed),
        ),
        (
            Some(255),
            "Received disconnect: Too many authentication failures",
            Some(Fatal::AuthFailed),
        ),
        (
            Some(255),
            "ssh: Could not resolve hostname nope: Name or service not known",
            None,
        ),
        (
            Some(255),
            "ssh: connect to host h port 22: Connection refused",
            None,
        ),
        (
            Some(255),
            "ssh: connect to host h port 22: Connection timed out",
            None,
        ),
        (Some(255), "Connection to h closed by remote host.", None),
        (Some(255), "", None),
        // A remote command's own failure is not ssh's: even this text is only retryable.
        (Some(1), "cat: x: Permission denied", None),
        (None, "", None),
    ];
    for (code, stderr, fatal) in cases {
        let error = classify_ssh(code, stderr, "me@box");
        match fatal {
            Some(f) => assert_eq!(error.kind, ErrorKind::Fatal(f), "{stderr:?}"),
            None => assert_eq!(error.kind, ErrorKind::Retryable, "{stderr:?}"),
        }
    }
    let unknown = classify_ssh(Some(255), "Host key verification failed.", "me@box");
    assert!(
        unknown
            .message
            .contains("run `ssh me@box` once in a terminal"),
        "{}",
        unknown.message
    );
    let denied = classify_ssh(Some(255), "Permission denied (publickey)", "me@box");
    assert!(
        denied
            .message
            .contains("run `ssh me@box` once in a terminal"),
        "{}",
        denied.message
    );
}

#[test]
fn a_retryable_message_says_what_ssh_said() {
    let error = classify_ssh(
        Some(255),
        "debug noise\nssh: connect to host h port 22: Connection refused\n",
        "h",
    );
    assert!(error.message.contains("Connection refused"));
    let notices = "Warning: Permanently added 'h' (ED25519) to the list of known hosts.\nShared connection to h closed.";
    let error = classify_ssh(
        Some(255),
        &format!("{notices}\nConnection to h closed by remote host."),
        "h",
    );
    assert!(
        error.message.contains("closed by remote host"),
        "{}",
        error.message
    );
    assert!(
        classify_ssh(Some(255), notices, "h")
            .message
            .contains("status 255")
    );
}

// ---- config ----------------------------------------------------------------------------------

#[test]
fn host_aliases_come_from_the_config_without_patterns_and_with_one_level_of_include() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir(root.join("conf.d")).unwrap();
    std::fs::write(
        root.join("conf.d/work"),
        "Host work-box build\n  HostName 10.0.0.2\nInclude deeper\n",
    )
    .unwrap();
    std::fs::write(root.join("deeper"), "Host too-deep\n").unwrap();
    std::fs::write(
        root.join("config"),
        "# comment\nInclude conf.d/*\n\nHost laptop\n  User me\nhost=\"quoted\" # trailing\nHost *\n  ServerAliveInterval 30\n\
         Host *.internal db? !skip laptop\nMatch host foo\n  User x\nHost -oProxyCommand=x ok.example.com\n",
    )
    .unwrap();
    assert_eq!(
        config_hosts(&root.join("config")),
        ["work-box", "build", "laptop", "quoted", "ok.example.com"]
    );
    assert!(config_hosts(&root.join("missing")).is_empty());
}

// ---- command line ----------------------------------------------------------------------------

#[test]
fn the_destination_always_follows_double_dash_and_the_remote_command_comes_last() {
    let dir = tempfile::tempdir().unwrap();
    let client = SshClient::with_control_dir(dir.path().to_path_buf());
    let t = SshTarget::new("me@box", Some(2222), None, None).unwrap();
    let args: Vec<String> = client
        .args(&t, &[], Some("remote command"))
        .into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let dash = args.iter().position(|a| a == "--").unwrap();
    assert_eq!(args[dash + 1], "me@box");
    assert_eq!(args[dash + 2], "remote command");
    assert_eq!(args.len(), dash + 3);
    let before = &args[..dash];
    for option in [
        "BatchMode=yes",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "ControlMaster=auto",
        "ControlPersist=120",
    ] {
        assert!(before.iter().any(|a| a == option), "missing {option}");
    }
    assert!(before.contains(&format!("ControlPath={}/%C", dir.path().display())));
    let port = before.iter().position(|a| a == "-p").unwrap();
    assert_eq!(before[port + 1], "2222");
}

#[test]
fn control_sockets_get_a_private_directory_short_enough_for_a_unix_socket() {
    let base = tempfile::tempdir().unwrap();
    let long = base
        .path()
        .join("a".repeat(60))
        .join("dev.herdrmobile.herdr_desktop");
    for data_dir in [base.path().to_path_buf(), long] {
        let dir = control_dir_for(&data_dir).unwrap();
        // ssh appends a 40 character hash and a 17 character setup suffix to the path.
        assert!(
            dir.as_os_str().len() + 1 + 40 + 17 <= 107,
            "{} is too long",
            dir.display()
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

// ---- the relay, run for real on a local python3 ----------------------------------------------

struct LocalRelay {
    child: Child,
    stdin: ChildStdin,
    frames: Receiver<(Vec<u8>, bool)>,
}

/// One frame of relay output: the line (or the inflated body) and whether it was a `Z<n>` frame.
fn read_frame(reader: &mut impl BufRead) -> Option<(Vec<u8>, bool)> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line).ok()? == 0 {
        return None;
    }
    line.pop();
    if let Some(n) = line
        .strip_prefix(b"Z")
        .and_then(|d| std::str::from_utf8(d).ok()?.parse::<usize>().ok())
    {
        let mut z = vec![0; n];
        reader.read_exact(&mut z).ok()?;
        let mut out = Vec::new();
        flate2::read::ZlibDecoder::new(z.as_slice())
            .read_to_end(&mut out)
            .ok()?;
        return Some((out, true));
    }
    Some((line, false))
}

impl LocalRelay {
    fn start(socket: &Path) -> Self {
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(RELAY_SCRIPT)
            .arg(socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (tx, frames) = unbounded();
        std::thread::spawn(move || {
            while let Some(frame) = read_frame(&mut stdout) {
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            frames,
        }
    }

    fn send(&mut self, request: &Value) {
        writeln!(self.stdin, "{request}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn next(&self) -> (Value, bool) {
        let (bytes, deflated) = self
            .frames
            .recv_timeout(T)
            .expect("the relay stopped answering");
        (serde_json::from_slice(&bytes).unwrap(), deflated)
    }

    fn exit_code(&mut self) -> Option<i32> {
        let deadline = Instant::now() + T;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for LocalRelay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn herdr_with(script: Script) -> (tempfile::TempDir, FakeHerdr) {
    let dir = tempfile::tempdir().unwrap();
    let herdr = FakeHerdr::start(dir.path(), script).unwrap();
    (dir, herdr)
}

#[test]
fn the_relay_says_ready_then_answers_each_request_by_its_id() {
    let (_dir, herdr) =
        herdr_with(Script::new().on("ping", json!({"type": "pong", "protocol": 22})));
    let mut relay = LocalRelay::start(herdr.socket_path());
    assert_eq!(
        relay.frames.recv_timeout(T).unwrap().0,
        READY_LINE.as_bytes()
    );
    relay.send(&json!({"id": "a", "method": "ping", "params": {}}));
    let (answer, deflated) = relay.next();
    assert_eq!(
        answer,
        json!({"id": "a", "result": {"type": "pong", "protocol": 22}})
    );
    assert!(!deflated, "a short answer is a plain line");
    assert_eq!(herdr.requests_of("ping").len(), 1);
}

#[test]
fn a_slow_request_does_not_hold_up_the_ones_after_it() {
    let (release, released) = unbounded::<()>();
    let (_dir, herdr) = herdr_with(
        Script::new()
            .on_with("slow", move |_| {
                let _ = released.recv_timeout(T);
                Ok(json!("slow done"))
            })
            .on("fast", json!("fast done")),
    );
    let mut relay = LocalRelay::start(herdr.socket_path());
    relay.frames.recv_timeout(T).unwrap();
    relay.send(&json!({"id": "slow-1", "method": "slow", "params": {}}));
    relay.send(&json!({"id": "fast-1", "method": "fast", "params": {}}));
    let (first, _) = relay.next();
    assert_eq!(
        first["id"], "fast-1",
        "the fast answer must overtake the slow one"
    );
    release.send(()).unwrap();
    let (second, _) = relay.next();
    assert_eq!(second, json!({"id": "slow-1", "result": "slow done"}));
}

#[test]
fn an_answer_longer_than_the_threshold_arrives_deflated_and_inflates_to_the_same_json() {
    let big = json!({"snapshot": {"text": "row of terminal text ".repeat(100)}});
    assert!(big.to_string().len() > COMPRESS_MIN);
    let (_dir, herdr) = herdr_with(Script::new().on("session.snapshot", big.clone()));
    let mut relay = LocalRelay::start(herdr.socket_path());
    relay.frames.recv_timeout(T).unwrap();
    relay.send(&json!({"id": "s", "method": "session.snapshot", "params": {}}));
    let (answer, deflated) = relay.next();
    assert!(deflated);
    assert_eq!(answer, json!({"id": "s", "result": big}));
}

#[test]
fn a_herdr_error_is_passed_on_and_a_dead_socket_becomes_a_bridge_error() {
    let (_dir, herdr) = herdr_with(Script::new().on_with("pane.read", |_| {
        Err(("pane_not_found".into(), "no such pane".into()))
    }));
    let mut relay = LocalRelay::start(herdr.socket_path());
    relay.frames.recv_timeout(T).unwrap();
    relay.send(&json!({"id": "e", "method": "pane.read", "params": {}}));
    let (answer, _) = relay.next();
    assert_eq!(answer["error"]["code"], "pane_not_found");

    drop(herdr); // the socket goes away while the relay is running
    relay.send(&json!({"id": "gone", "method": "ping", "params": {}}));
    let (answer, _) = relay.next();
    assert_eq!(
        (answer["id"].as_str(), answer["error"]["code"].as_str()),
        (Some("gone"), Some("bridge_error"))
    );
}

#[test]
fn the_relay_gives_an_answer_that_herdr_could_not_correlate_the_id_it_was_sent_with() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("herdr.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = BufReader::new(&stream).read_line(&mut line);
            let _ = (&stream).write_all(b"{\"id\":\"\",\"error\":{\"code\":\"invalid_request\",\"message\":\"unknown method\"}}\n");
        }
    });
    let mut relay = LocalRelay::start(&path);
    relay.frames.recv_timeout(T).unwrap();
    relay.send(&json!({"id": "mine", "method": "no.such", "params": {}}));
    let (answer, _) = relay.next();
    assert_eq!(answer["id"], "mine");
}

#[test]
fn the_relay_exits_78_when_there_is_no_herdr_socket() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = LocalRelay::start(&dir.path().join("nothing.sock"));
    assert_eq!(relay.exit_code(), Some(78));
    let mut stderr = String::new();
    relay
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stderr.contains("no herdr socket"), "{stderr}");
}

#[test]
fn a_subscription_streams_events_until_herdr_hangs_up() {
    let (_dir, herdr) = herdr_with(Script::new());
    let mut relay = LocalRelay::start(herdr.socket_path());
    relay.frames.recv_timeout(T).unwrap();
    relay.send(&json!({"id": "sub", "method": "events.subscribe", "params": {"subscriptions": [{"type": "pane.updated"}]}}));
    let (ack, _) = relay.next();
    assert_eq!(ack["result"]["type"], "subscription_started");
    eventually("the subscriber", || herdr.subscribers() == 1);
    let short = json!({"event": "pane_updated", "data": {"pane": {"pane_id": "p1"}}});
    let long =
        json!({"event": "pane_updated", "data": {"pane": {"title": "t".repeat(2 * COMPRESS_MIN)}}});
    herdr.push_event(short.clone());
    herdr.push_event(long.clone());
    assert_eq!(relay.next(), (short, false));
    assert_eq!(relay.next(), (long, true));
    drop(herdr);
    assert_eq!(
        relay.exit_code(),
        Some(0),
        "the relay must stop so its caller notices the stream ended"
    );
}

// ---- SshWire against a stand-in ssh ----------------------------------------------------------

/// A working directory with a stand-in `ssh`: it ignores ssh's options and runs the remote command
/// word locally (`exec`, so the child keeps the PID the test kills: a real ssh client's death closes
/// the remote side the same way). Some destinations play ssh's failures; `restricted` runs with a PATH that holds only
/// what a test links into `bin/`, and a HOME whose `.local/bin/herdr` is a test's fake.
struct Rig {
    dir: tempfile::TempDir,
    herdr: FakeHerdr,
    _herdr_dir: tempfile::TempDir,
    ssh: PathBuf,
}

impl Rig {
    fn new(script: Script) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (herdr_dir, herdr) = herdr_with(script);
        let ssh = dir.path().join("ssh");
        let bin = dir.path().join("bin");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        for tool in ["base64", "sh"] {
            std::os::unix::fs::symlink(find_in_path(tool).unwrap(), bin.join(tool)).unwrap();
        }
        std::fs::write(
            &ssh,
            format!(
                r#"#!/bin/sh
for a; do
  [ "$a" = "--" ] && break
  [ "$a" = "-O" ] && exit 0
done
while [ "$1" != "--" ]; do shift; done
shift
dest=$1
shift
case "$dest" in
  hostkey-unknown) echo "Host key verification failed." >&2; exit 255;;
  hostkey-changed) echo "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" >&2; echo "Host key verification failed." >&2; exit 255;;
  auth-failed) echo "$dest: Permission denied (publickey)." >&2; exit 255;;
  unreachable) echo "ssh: connect to host unreachable port 22: Connection refused" >&2; exit 255;;
  restricted) exec /usr/bin/env -i PATH="{bin}" HOME="{home}" /bin/sh -c "exec $1";;
esac
exec sh -c "exec $1"
"#,
                bin = bin.display(),
                home = home.display()
            ),
        )
        .unwrap();
        Self {
            dir,
            herdr,
            _herdr_dir: herdr_dir,
            ssh,
        }
    }

    fn bin(&self) -> PathBuf {
        self.dir.path().join("bin")
    }

    /// Installs a fake `herdr` that answers `remote-api-bridge --check` and bridges to the fake socket with the python bridge.
    fn install_fake_herdr_bridge(&self) {
        let bridge = self.dir.path().join("bridge.py");
        std::fs::write(&bridge, herdr_core::ssh::BRIDGE_SCRIPT).unwrap();
        write_executable(
            &self.dir.path().join("home/.local/bin/herdr"),
            &format!(
                "#!/bin/sh\n[ \"$4\" = \"--check\" ] && {{ echo herdr-api-bridge-v1; exit 0; }}\nexec {} {} {}\n",
                find_in_path("python3").unwrap().display(),
                bridge.display(),
                self.herdr.socket_path().display()
            ),
        );
    }

    fn client(&self) -> SshClient {
        SshClient::with_control_dir(self.dir.path().join("control"))
            .program("/bin/sh")
            .program_arg(&self.ssh)
    }

    fn target(&self, dest: &str) -> SshTarget {
        SshTarget::new(
            dest,
            None,
            None,
            Some(&self.herdr.socket_path().display().to_string()),
        )
        .unwrap()
    }

    fn wire(&self, dest: &str) -> SshWire {
        SshWire::new(self.client(), self.target(dest))
    }
}

fn ping(wire: &impl Wire) -> Result<Value, herdr_core::wire::WireError> {
    wire.request("ping", json!({}), T)
}

#[test]
fn requests_go_through_one_relay_and_come_back_as_results() {
    let rig = Rig::new(
        Script::new()
            .on("ping", json!({"type": "pong", "protocol": 22}))
            .on_with("pane.read", |params| Ok(json!({"echo": params["pane_id"]}))),
    );
    let wire = rig.wire("box");
    assert_eq!(
        ping(&wire).unwrap(),
        json!({"type": "pong", "protocol": 22})
    );
    let read = wire
        .request("pane.read", json!({"pane_id": "p9"}), T)
        .unwrap();
    assert_eq!(read, json!({"echo": "p9"}));
    assert_eq!(
        rig.herdr.requests_of("pane.read")[0].params,
        json!({"pane_id": "p9"})
    );
}

#[test]
fn a_herdr_error_is_an_api_error_and_leaves_the_link_usable() {
    let rig = Rig::new(
        Script::new()
            .on("ping", json!({}))
            .on_with("tab.close", |_| {
                Err(("tab_not_found".into(), "gone".into()))
            }),
    );
    let wire = rig.wire("box");
    let error = wire
        .request("tab.close", json!({"tab_id": "t"}), T)
        .unwrap_err();
    assert_eq!(
        error.kind,
        ErrorKind::Api {
            code: "tab_not_found".into()
        }
    );
    assert!(ping(&wire).is_ok());
}

#[test]
fn many_threads_share_one_relay_and_each_gets_its_own_answer() {
    let rig = Rig::new(Script::new().on_with("echo", |params| Ok(params.clone())));
    let wire = Arc::new(rig.wire("box"));
    let handles: Vec<_> = (0..12)
        .map(|n| {
            let wire = wire.clone();
            std::thread::spawn(move || {
                for k in 0..5 {
                    let params = json!({"n": n, "k": k});
                    assert_eq!(wire.request("echo", params.clone(), T).unwrap(), params);
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
}

#[test]
fn a_request_that_waits_on_herdr_does_not_block_the_others() {
    let (release, released) = unbounded::<()>();
    let rig = Rig::new(
        Script::new()
            .on_with("slow", move |_| {
                let _ = released.recv_timeout(T);
                Ok(json!("slow done"))
            })
            .on("ping", json!("pong")),
    );
    let wire = Arc::new(rig.wire("box"));
    let slow = {
        let wire = wire.clone();
        std::thread::spawn(move || wire.request("slow", json!({}), T))
    };
    eventually("the slow request to reach herdr", || {
        !rig.herdr.requests_of("slow").is_empty()
    });
    assert_eq!(ping(&*wire).unwrap(), json!("pong"));
    release.send(()).unwrap();
    assert_eq!(slow.join().unwrap().unwrap(), json!("slow done"));
}

#[test]
fn a_request_herdr_never_answers_times_out_as_retryable() {
    let (release, released) = unbounded::<()>();
    let rig = Rig::new(Script::new().on_with("hang", move |_| {
        let _ = released.recv_timeout(T);
        Ok(json!(null))
    }));
    let wire = rig.wire("box");
    let error = wire
        .request("hang", json!({}), Duration::from_millis(300))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Retryable);
    release.send(()).unwrap();
}

#[test]
fn after_the_relay_is_killed_one_request_fails_retryably_and_the_next_reconnects() {
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    let wire = rig.wire("box");
    assert!(ping(&wire).is_ok());
    let pid = wire.relay_pid().expect("a relay is running");
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(pid as i32).unwrap(),
        rustix::process::Signal::KILL,
    )
    .unwrap();
    eventually("the relay to be gone", || process_is_gone(pid));

    let error = ping(&wire).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Retryable, "{error}");
    assert_eq!(ping(&wire).unwrap(), json!("pong"));
    assert_ne!(wire.relay_pid(), Some(pid));
}

#[test]
fn shutdown_kills_the_relay_and_the_event_streams_by_pid() {
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    let wire = rig.wire("box");
    ping(&wire).unwrap();
    let pid = wire.relay_pid().unwrap();
    let mut events = wire.events(&[json!({"type": "pane.updated"})]).unwrap();
    wire.shutdown();
    eventually("the relay to be gone", || process_is_gone(pid));
    assert!(wire.relay_pid().is_none());
    // The stream ends with an error once its process is gone.
    let deadline = Instant::now() + T;
    loop {
        match events.next(Duration::from_millis(100)) {
            Err(e) => {
                assert_eq!(e.kind, ErrorKind::Retryable);
                break;
            }
            Ok(_) => assert!(Instant::now() < deadline, "the stream never ended"),
        }
    }
}

#[test]
fn an_event_stream_delivers_events_after_the_subscription_is_acknowledged() {
    let rig = Rig::new(Script::new());
    let wire = rig.wire("box");
    let subscriptions = [
        json!({"type": "pane.updated"}),
        json!({"type": "workspace.created"}),
    ];
    let mut events = wire.events(&subscriptions).unwrap();
    assert_eq!(
        rig.herdr.requests_of("events.subscribe")[0].params,
        json!({"subscriptions": subscriptions})
    );
    assert_eq!(
        events.next(Duration::from_millis(50)).unwrap(),
        None,
        "a quiet stream is not an error"
    );

    let long =
        json!({"event": "pane_updated", "data": {"pane": {"title": "t".repeat(3 * COMPRESS_MIN)}}});
    let short =
        json!({"event": "workspace_created", "data": {"workspace": {"workspace_id": "w1"}}});
    eventually("the subscriber", || rig.herdr.subscribers() == 1);
    rig.herdr.push_event(short.clone());
    rig.herdr.push_event(long.clone());
    let mut got = Vec::new();
    while got.len() < 2 {
        got.extend(events.next(T).unwrap());
    }
    assert_eq!(got, [short, long]);
}

#[test]
fn requests_still_work_while_an_event_stream_is_open() {
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    let wire = rig.wire("box");
    let _events = wire.events(&[json!({"type": "pane.updated"})]).unwrap();
    assert_eq!(ping(&wire).unwrap(), json!("pong"));
}

#[test]
fn ssh_failures_reach_the_caller_classified() {
    let rig = Rig::new(Script::new());
    let kind = |dest: &str| ping(&rig.wire(dest)).unwrap_err().kind;
    assert_eq!(
        kind("hostkey-unknown"),
        ErrorKind::Fatal(Fatal::HostKeyUnknown)
    );
    assert_eq!(
        kind("hostkey-changed"),
        ErrorKind::Fatal(Fatal::HostKeyChanged)
    );
    assert_eq!(kind("auth-failed"), ErrorKind::Fatal(Fatal::AuthFailed));
    assert_eq!(kind("unreachable"), ErrorKind::Retryable);
    let events = rig.wire("hostkey-changed").events(&[]).err().unwrap();
    assert_eq!(events.kind, ErrorKind::Fatal(Fatal::HostKeyChanged));
}

#[test]
fn a_missing_ssh_binary_is_fatal() {
    let rig = Rig::new(Script::new());
    let client =
        SshClient::with_control_dir(rig.dir.path().join("control")).program("/nonexistent/ssh");
    let wire = SshWire::new(client, rig.target("box"));
    assert_eq!(
        ping(&wire).unwrap_err().kind,
        ErrorKind::Fatal(Fatal::SshMissing)
    );
}

#[test]
fn without_python_the_wire_falls_back_to_herdrs_own_bridge() {
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    rig.install_fake_herdr_bridge();
    let wire = rig.wire("restricted");
    assert_eq!(ping(&wire).unwrap(), json!("pong"));
    assert_eq!(ping(&wire).unwrap(), json!("pong"));
    assert_eq!(wire.relay_pid(), None, "no relay runs in bridge mode");
    let herdr_error = wire.request("nope", json!({}), T).unwrap_err();
    assert!(matches!(herdr_error.kind, ErrorKind::Api { .. }));

    let mut events = wire.events(&[json!({"type": "pane.updated"})]).unwrap();
    eventually("the subscriber", || rig.herdr.subscribers() == 1);
    let event = json!({"event": "pane_updated", "data": {}});
    rig.herdr.push_event(event.clone());
    assert_eq!(events.next(T).unwrap(), Some(event));
}

#[test]
fn without_python_the_wire_can_fall_back_to_socat() {
    let Some(socat) = find_in_path("socat") else {
        eprintln!("socat is not installed: the socat fallback is not exercised here");
        return;
    };
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    std::os::unix::fs::symlink(socat, rig.bin().join("socat")).unwrap();
    assert_eq!(ping(&rig.wire("restricted")).unwrap(), json!("pong"));
}

#[test]
fn a_machine_with_no_way_to_reach_herdr_is_a_fatal_bridge_missing() {
    let rig = Rig::new(Script::new().on("ping", json!("pong")));
    let error = ping(&rig.wire("restricted")).unwrap_err();
    assert_eq!(
        error.kind,
        ErrorKind::Fatal(Fatal::BridgeMissing),
        "{error}"
    );
}

// ---- one-shot commands -----------------------------------------------------------------------

#[test]
fn a_one_shot_command_gets_its_arguments_verbatim_and_returns_its_output_and_status() {
    let rig = Rig::new(Script::new());
    let client = rig.client();
    let target = rig.target("box");
    for value in hostile_strings(rig.dir.path()) {
        let out = client
            .run_checked(&target, &["printf", "%s", &value], b"", T)
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), value);
        assert_eq!(out.code, 0);
    }
    assert!(
        !rig.dir.path().join("pwned").exists(),
        "a hostile argument was executed"
    );
    let failed = client
        .run_checked(&target, &["sh", "-c", "echo oops >&2; exit 3"], b"", T)
        .unwrap();
    assert_eq!((failed.code, failed.stderr.trim()), (3, "oops"));
}

#[test]
fn a_one_shot_command_streams_a_large_input_through_without_deadlock() {
    let rig = Rig::new(Script::new());
    let input: Vec<u8> = (0..2_000_000u32).map(|n| (n % 251) as u8).collect();
    let out = rig
        .client()
        .run_checked(&rig.target("box"), &["cat"], &input, T)
        .unwrap();
    assert_eq!(out.stdout, input);
}

#[test]
fn a_one_shot_command_that_runs_too_long_is_killed_and_reported_retryable() {
    let rig = Rig::new(Script::new());
    let error = rig
        .client()
        .run_checked(
            &rig.target("box"),
            &["sleep", "30"],
            b"",
            Duration::from_millis(300),
        )
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Retryable);
}

#[test]
fn a_one_shot_command_reports_ssh_level_failures_classified() {
    let rig = Rig::new(Script::new());
    let error = rig
        .client()
        .run_checked(&rig.target("hostkey-unknown"), &["true"], b"", T)
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Fatal(Fatal::HostKeyUnknown));
}

// ---- the real thing: sshd on this machine ----------------------------------------------------

/// Needs `HERDR_DESKTOP_SSH_TEST=<destination>` (for example `localhost`) and key login to it:
/// `cargo test -- --ignored`. Trust is recorded in a temporary known_hosts file, never the user's.
#[test]
#[ignore = "needs sshd and key login: set HERDR_DESKTOP_SSH_TEST=localhost"]
fn through_a_real_sshd_requests_events_one_shots_and_reconnects_work() {
    let Ok(dest) = std::env::var("HERDR_DESKTOP_SSH_TEST") else {
        panic!("set HERDR_DESKTOP_SSH_TEST to the destination, for example localhost");
    };
    let dir = tempfile::tempdir().unwrap();
    let (_herdr_dir, herdr) =
        herdr_with(Script::new().on("ping", json!({"type": "pong", "protocol": 22})));
    let known_hosts = dir.path().join("known_hosts");
    let client = SshClient::new(dir.path())
        .unwrap()
        .option(format!("UserKnownHostsFile={}", known_hosts.display()))
        .option("StrictHostKeyChecking=accept-new");
    let target = SshTarget::new(
        &dest,
        None,
        None,
        Some(&herdr.socket_path().display().to_string()),
    )
    .unwrap();
    let wire = SshWire::new(client.clone(), target.clone());

    assert_eq!(
        ping(&wire).unwrap(),
        json!({"type": "pong", "protocol": 22})
    );

    let mut events = wire.events(&[json!({"type": "pane.updated"})]).unwrap();
    eventually("the subscriber", || herdr.subscribers() == 1);
    let event = json!({"event": "pane_updated", "data": {"pane": {"pane_id": "p1"}}});
    herdr.push_event(event.clone());
    assert_eq!(events.next(T).unwrap(), Some(event));

    let echoed = client
        .run_checked(&target, &["printf", "%s", "a b; c"], b"", T)
        .unwrap();
    assert_eq!(echoed.stdout, b"a b; c");

    let pid = wire.relay_pid().unwrap();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(pid as i32).unwrap(),
        rustix::process::Signal::KILL,
    )
    .unwrap();
    eventually("the relay to be gone", || process_is_gone(pid));
    assert_eq!(ping(&wire).unwrap_err().kind, ErrorKind::Retryable);
    assert!(ping(&wire).is_ok(), "the next request must reconnect");

    // An empty known_hosts file with strict checking: the host is not trusted yet.
    // A control directory of its own: the trusted connection's master would otherwise be reused.
    let strict = SshClient::new(&dir.path().join("strict"))
        .unwrap()
        .config_file("/dev/null")
        .option(format!(
            "UserKnownHostsFile={}",
            dir.path().join("empty").display()
        ))
        .option("StrictHostKeyChecking=yes");
    let untrusted = SshWire::new(strict, target.clone());
    assert_eq!(
        ping(&untrusted).unwrap_err().kind,
        ErrorKind::Fatal(Fatal::HostKeyUnknown)
    );

    wire.shutdown();
}

/// Counts the connection attempts a link makes, to tell a stopped retry loop from a quiet one.
struct Counting {
    inner: SshWire,
    attempts: std::sync::atomic::AtomicUsize,
}

impl Wire for Counting {
    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, herdr_core::wire::WireError> {
        self.attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.request(method, params, timeout)
    }

    fn events(
        &self,
        subscriptions: &[Value],
    ) -> Result<Box<dyn herdr_core::wire::EventStream>, herdr_core::wire::WireError> {
        self.inner.events(subscriptions)
    }
}

/// A link on a real ssh whose host key cannot be trusted: it must show `Attention` with the one thing
/// to do, make no further attempt however long it waits, and try again only when told.
fn assert_link_stops_in_attention(
    client: SshClient,
    target: &SshTarget,
    expected: Fatal,
    text: &str,
) {
    use herdr_core::link::{LinkConfig, LinkState, MachineLink, ManualClock, Timing};
    use std::sync::atomic::Ordering;

    let clock = Arc::new(ManualClock::new());
    let wire = Arc::new(Counting {
        inner: SshWire::new(client, target.clone()),
        attempts: std::sync::atomic::AtomicUsize::new(0),
    });
    let (updates, _rx) = unbounded();
    let link = MachineLink::start(
        LinkConfig {
            machine: "remote".into(),
            wire: wire.clone(),
            clock: clock.clone(),
            timing: Timing::default(),
            enabled: true,
        },
        updates,
    );
    eventually("the link to need attention", || {
        matches!(link.state(), LinkState::Attention(_))
    });
    let status = link.status();
    assert_eq!(status.fatal, Some(expected), "{status:?}");
    let LinkState::Attention(reason) = &status.state else {
        unreachable!()
    };
    assert!(reason.contains(text), "{reason}");
    assert!(
        status.retry_at.is_none(),
        "there is nothing to count down to"
    );

    let attempts = wire.attempts.load(Ordering::SeqCst);
    clock.advance(Duration::from_secs(600));
    clock.advance(Duration::from_secs(600));
    // Let a retry that should not happen show itself.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(wire.attempts.load(Ordering::SeqCst), attempts, "no retry");
    assert!(matches!(link.state(), LinkState::Attention(_)));

    link.reconnect_now();
    eventually("the retry the person asked for", || {
        wire.attempts.load(Ordering::SeqCst) > attempts
    });
    eventually("attention again", || {
        matches!(link.state(), LinkState::Attention(_))
    });
    link.shutdown();
}

/// Real ssh to a destination whose host key is not in `known_hosts`, and to one whose key differs from
/// what `known_hosts` holds: both are fatal with the right words, and the link stops retrying.
#[test]
#[ignore = "needs sshd and key login: set HERDR_DESKTOP_SSH_TEST=localhost"]
fn through_a_real_sshd_an_untrusted_or_changed_host_key_stops_the_link_until_told() {
    let Ok(dest) = std::env::var("HERDR_DESKTOP_SSH_TEST") else {
        panic!("set HERDR_DESKTOP_SSH_TEST to the destination, for example localhost");
    };
    let dir = tempfile::tempdir().unwrap();
    let target = SshTarget::new(&dest, None, None, None).unwrap();
    let strict = |name: &str, known_hosts: &Path| {
        SshClient::new(&dir.path().join(name))
            .unwrap()
            .config_file("/dev/null")
            .option(format!("UserKnownHostsFile={}", known_hosts.display()))
            .option("StrictHostKeyChecking=yes")
            // The key type of the throwaway entry below, so ssh compares like with like.
            .option("HostKeyAlgorithms=ssh-ed25519")
    };

    // Not trusted yet: an empty known_hosts.
    let empty = dir.path().join("empty");
    std::fs::write(&empty, "").unwrap();
    assert_link_stops_in_attention(
        strict("unknown", &empty),
        &target,
        Fatal::HostKeyUnknown,
        &format!("run `ssh {dest}` once"),
    );

    // Changed: known_hosts names this host with another key (a throwaway one, never the real one).
    let key = dir.path().join("throwaway");
    let made = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "throwaway", "-f"])
        .arg(&key)
        .status()
        .unwrap();
    assert!(made.success());
    let public = std::fs::read_to_string(dir.path().join("throwaway.pub")).unwrap();
    let known = dir.path().join("changed");
    std::fs::write(&known, format!("{dest} {public}")).unwrap();
    assert_link_stops_in_attention(
        strict("changed", &known),
        &target,
        Fatal::HostKeyChanged,
        "has changed",
    );
}
