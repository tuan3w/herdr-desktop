//! `SshWire`: herdr's API on a remote machine, over the system `ssh`.
//!
//! One long-lived relay process per wire carries every request (pipelined, matched by `id`), and each
//! event stream gets a process of its own, so a slow request never delays an event and a dropped
//! stream never disturbs requests. When the machine cannot run the relay (no python3, or no socket
//! where it was looked for) the wire falls back to a bridge that serves one request per process:
//! `herdr remote-api-bridge`, then `socat`, then a python bridge.
//!
//! The wire never restarts anything by itself: when the relay dies, the first request after that
//! fails with a retryable error and the next one starts a new relay. Reconnect timing is the link's job.

use std::collections::HashMap;
use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, bounded};
use serde_json::{Value, json};

use super::classify::{classify_ssh, has_complaint};
use super::command::{KillOnDrop, SshClient, spawn_error};
use super::proc::{Exit, Proc, frames, lock, spawn};
use super::relay::{EXIT_UNAVAILABLE, READY_LINE, bridge_command, relay_command};
use super::validate::SshTarget;
use crate::wire::{EventStream, Fatal, Wire, WireError};

/// How long ssh gets to connect, authenticate and start the relay.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long herdr gets to acknowledge a subscription once the relay runs.
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a dead process gets to be reaped so its exit status can be read.
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// Lines a login script may print before the relay's ready line.
const BANNER_LINES: usize = 8;

type Answer = Result<Value, WireError>;

/// A herdr on a remote machine, reached with the system `ssh`.
pub struct SshWire {
    inner: Arc<Inner>,
}

struct Inner {
    client: SshClient,
    target: SshTarget,
    /// Set once the relay proved unavailable on this machine.
    bridge_mode: AtomicBool,
    channel: Mutex<Option<Arc<Channel>>>,
    next_id: AtomicU64,
    streams: Mutex<Vec<Weak<Proc>>>,
}

/// The request relay process and the requests waiting on it.
struct Channel {
    proc: Arc<Proc>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    waiting: HashMap<String, Sender<Answer>>,
    /// Why the relay is gone, once it is.
    dead: Option<WireError>,
    /// Whether a caller has been told (so the next request reconnects instead of failing again).
    reported: bool,
}

/// A started remote process: ready to be written to, its framed output arriving on `lines`.
struct Started {
    proc: Arc<Proc>,
    stdin: ChildStdin,
    lines: Receiver<Vec<u8>>,
}

enum Setup {
    /// The relay cannot run on that machine (exit 78): try the bridges.
    Unavailable,
    Failed(WireError),
}

impl SshWire {
    /// A wire to `target`. Nothing is spawned until the first call.
    pub fn new(client: SshClient, target: SshTarget) -> Self {
        Self {
            inner: Arc::new(Inner {
                client,
                target,
                bridge_mode: AtomicBool::new(false),
                channel: Mutex::new(None),
                next_id: AtomicU64::new(1),
                streams: Mutex::new(Vec::new()),
            }),
        }
    }

    /// The machine this wire talks to.
    pub fn target(&self) -> &SshTarget {
        &self.inner.target
    }

    /// The PID of the live request relay's ssh process, if there is one.
    pub fn relay_pid(&self) -> Option<u32> {
        let slot = lock(&self.inner.channel);
        slot.as_ref()
            .filter(|c| lock(&c.pending).dead.is_none())
            .map(|c| c.proc.pid())
    }

    /// Kills every ssh process this wire started (by PID) and asks the shared master connection to
    /// exit. The wire starts a fresh relay on the next request.
    pub fn shutdown(&self) {
        self.inner.kill_children();
        self.inner.client.close_master(&self.inner.target);
    }
}

impl Drop for SshWire {
    fn drop(&mut self) {
        // The shared master is left to expire by itself (ControlPersist): `shutdown` closes it at once.
        self.inner.kill_children();
    }
}

impl Inner {
    fn kill_children(&self) {
        if let Some(channel) = lock(&self.channel).take() {
            channel.proc.kill();
        }
        for stream in lock(&self.streams).drain(..) {
            if let Some(proc) = stream.upgrade() {
                proc.kill();
            }
        }
    }

    fn dest(&self) -> &str {
        self.target.dest()
    }

    fn spawn_remote(&self, remote: &str) -> Result<Started, WireError> {
        let mut command = self.client.command(&self.target, remote);
        let spawned = spawn(&mut command).map_err(spawn_error)?;
        let lines = frames(spawned.stdout, spawned.proc.clone());
        Ok(Started {
            proc: spawned.proc,
            stdin: spawned.stdin,
            lines,
        })
    }

    /// Starts the relay and waits for its ready line.
    fn start_relay(&self) -> Result<Started, Setup> {
        let started = self
            .spawn_remote(&relay_command(&self.target))
            .map_err(Setup::Failed)?;
        let deadline = Instant::now() + START_TIMEOUT;
        let mut banner = 0;
        loop {
            match started.lines.recv_deadline(deadline) {
                Ok(line) if line == READY_LINE.as_bytes() => return Ok(started),
                Ok(_) if banner < BANNER_LINES => banner += 1,
                Ok(_) => {
                    started.proc.kill();
                    return Err(Setup::Failed(WireError::fatal(
                        Fatal::Protocol,
                        format!(
                            "{} printed something other than the relay's ready line",
                            self.dest()
                        ),
                    )));
                }
                Err(RecvTimeoutError::Timeout) => {
                    started.proc.kill();
                    let seconds = START_TIMEOUT.as_secs();
                    return Err(Setup::Failed(WireError::retryable(format!(
                        "{} did not answer within {seconds} s",
                        self.dest()
                    ))));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let exit = started.proc.wait_exit(EXIT_WAIT);
                    return Err(match exit {
                        Some(e) if e.code == Some(EXIT_UNAVAILABLE) => Setup::Unavailable,
                        other => Setup::Failed(end_error(other, self.dest())),
                    });
                }
            }
        }
    }

    /// Starts the one-connection bridge (no ready line).
    fn start_bridge(&self) -> Result<Started, WireError> {
        self.spawn_remote(&bridge_command(&self.target))
    }

    /// The error for a bridge that ended without answering: exit 78 means no bridge exists there.
    fn bridge_end_error(&self, proc: &Proc) -> WireError {
        match proc.wait_exit(EXIT_WAIT) {
            Some(e) if e.code == Some(EXIT_UNAVAILABLE) => WireError::fatal(
                Fatal::BridgeMissing,
                format!(
                    "{} has no way to reach herdr from outside: install herdr 0.9 or newer, socat or python3 there{}",
                    self.dest(),
                    last_line(&e.stderr)
                ),
            ),
            other => end_error(other, self.dest()),
        }
    }

    /// The live relay channel, starting one when there is none. A dead channel reports its death to
    /// the first caller (a retryable error) and is replaced for the next.
    fn channel(&self) -> Result<Arc<Channel>, Setup> {
        let mut slot = lock(&self.channel);
        if let Some(channel) = slot.as_ref() {
            let mut pending = lock(&channel.pending);
            match &pending.dead {
                None => return Ok(channel.clone()),
                Some(error) if !pending.reported => {
                    let error = error.clone();
                    pending.reported = true;
                    return Err(Setup::Failed(error));
                }
                Some(_) => {}
            }
        }
        *slot = None;
        let started = self.start_relay()?;
        let channel = Arc::new(Channel {
            proc: started.proc.clone(),
            stdin: Mutex::new(started.stdin),
            pending: Mutex::new(Pending::default()),
        });
        let inner = channel.clone();
        let dest = self.target.dest().to_owned();
        std::thread::spawn(move || dispatch(&inner, &started.lines, &dest));
        *slot = Some(channel.clone());
        Ok(channel)
    }

    fn next_request(&self, method: &str, params: &Value) -> (String, String) {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let line = json!({"id": id, "method": method, "params": params}).to_string();
        (id, line)
    }

    fn request_on(
        &self,
        channel: &Channel,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Answer {
        let (id, line) = self.next_request(method, params);
        let (tx, rx) = bounded(1);
        {
            let mut pending = lock(&channel.pending);
            if let Some(error) = pending.dead.clone() {
                pending.reported = true;
                return Err(error);
            }
            pending.waiting.insert(id.clone(), tx);
        }
        let written = {
            let mut stdin = lock(&channel.stdin);
            stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.write_all(b"\n"))
                .and_then(|()| stdin.flush())
        };
        if let Err(e) = written {
            // The relay is gone. Mark it dead here rather than waiting for its output to end, so the
            // request after this one starts a new relay deterministically.
            let error =
                WireError::retryable(format!("the connection to {} is gone: {e}", self.dest()));
            let mut pending = lock(&channel.pending);
            pending.waiting.remove(&id);
            pending.dead.get_or_insert_with(|| error.clone());
            pending.reported = true;
            channel.proc.kill();
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(_) => {
                lock(&channel.pending).waiting.remove(&id);
                Err(WireError::retryable(format!(
                    "herdr on {} did not answer {method} in time",
                    self.dest()
                )))
            }
        }
    }

    /// One request over a bridge process of its own.
    fn request_bridge(&self, method: &str, params: &Value, timeout: Duration) -> Answer {
        let mut started = self.start_bridge()?;
        let _kill = KillOnDrop(started.proc.clone());
        let (_, line) = self.next_request(method, params);
        started
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| started.stdin.write_all(b"\n"))
            .and_then(|()| started.stdin.flush())
            .map_err(|e| {
                WireError::retryable(format!(
                    "could not send the request to {}: {e}",
                    self.dest()
                ))
            })?;
        match started.lines.recv_timeout(timeout) {
            Ok(line) => parse_answer(&line),
            Err(RecvTimeoutError::Timeout) => Err(WireError::retryable(format!(
                "herdr on {} did not answer {method} in time",
                self.dest()
            ))),
            Err(RecvTimeoutError::Disconnected) => Err(self.bridge_end_error(&started.proc)),
        }
    }

    /// The relay is unavailable: serve this request through a bridge and remember that.
    fn fallback_request(&self, method: &str, params: &Value, timeout: Duration) -> Answer {
        self.bridge_mode.store(true, Ordering::Relaxed);
        let answer = self.request_bridge(method, params, timeout);
        if matches!(&answer, Err(e) if e.kind == crate::wire::ErrorKind::Fatal(Fatal::BridgeMissing))
        {
            self.bridge_mode.store(false, Ordering::Relaxed);
        }
        answer
    }

    fn started_for_events(&self) -> Result<Started, WireError> {
        if self.bridge_mode.load(Ordering::Relaxed) {
            return self.start_bridge();
        }
        match self.start_relay() {
            Ok(started) => Ok(started),
            Err(Setup::Failed(error)) => Err(error),
            Err(Setup::Unavailable) => {
                let started = self.start_bridge()?;
                self.bridge_mode.store(true, Ordering::Relaxed);
                Ok(started)
            }
        }
    }
}

/// The error for a process that ended: what ssh complained about, classified, or just "closed".
fn end_error(exit: Option<Exit>, dest: &str) -> WireError {
    match exit {
        Some(Exit { code, stderr }) if code == Some(255) || has_complaint(&stderr) => {
            classify_ssh(code, &stderr, dest)
        }
        _ => WireError::retryable(format!("the connection to {dest} closed")),
    }
}

/// Routes the relay's answers to the requests waiting for them, and fails the waiting ones when the
/// relay ends.
fn dispatch(channel: &Channel, lines: &Receiver<Vec<u8>>, dest: &str) {
    for line in lines {
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let waiting = lock(&channel.pending).waiting.remove(id);
        if let Some(tx) = waiting {
            let _ = tx.send(answer_result(&value));
        }
    }
    let error = end_error(channel.proc.wait_exit(EXIT_WAIT), dest);
    let mut pending = lock(&channel.pending);
    pending.dead = Some(error.clone());
    let waiting: Vec<_> = pending.waiting.drain().map(|(_, tx)| tx).collect();
    pending.reported |= !waiting.is_empty();
    drop(pending);
    for tx in waiting {
        let _ = tx.send(Err(error.clone()));
    }
}

/// `{"error":{..}}` becomes an error (a relay-side `bridge_error` is a connection problem, so retryable),
/// `{"result":..}` its value.
fn answer_result(value: &Value) -> Answer {
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("herdr reported an error");
        return Err(if code == "bridge_error" {
            WireError::retryable(message)
        } else {
            WireError::api(code, message)
        });
    }
    value.get("result").cloned().ok_or_else(|| {
        WireError::fatal(
            Fatal::Protocol,
            "herdr's answer has neither a result nor an error",
        )
    })
}

fn parse_answer(line: &[u8]) -> Answer {
    let value: Value = serde_json::from_slice(line).map_err(|e| {
        WireError::fatal(Fatal::Protocol, format!("herdr's answer is not JSON: {e}"))
    })?;
    answer_result(&value)
}

/// `: <last stderr line>` for appending to a message, or nothing.
fn last_line(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(|l| format!(" ({l})"))
        .unwrap_or_default()
}

impl Wire for SshWire {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Answer {
        let inner = &self.inner;
        if inner.bridge_mode.load(Ordering::Relaxed) {
            return inner.request_bridge(method, &params, timeout);
        }
        match inner.channel() {
            Ok(channel) => inner.request_on(&channel, method, &params, timeout),
            Err(Setup::Unavailable) => inner.fallback_request(method, &params, timeout),
            Err(Setup::Failed(error)) => Err(error),
        }
    }

    fn events(&self, subscriptions: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
        let inner = &self.inner;
        let started = inner.started_for_events()?;
        lock(&inner.streams).retain(|w| w.strong_count() > 0);
        lock(&inner.streams).push(Arc::downgrade(&started.proc));
        let mut events = SshEvents {
            inner: inner.clone(),
            proc: started.proc,
            stdin: started.stdin,
            lines: started.lines,
        };
        let (_, line) =
            inner.next_request("events.subscribe", &json!({"subscriptions": subscriptions}));
        events
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| events.stdin.write_all(b"\n"))
            .and_then(|()| events.stdin.flush())
            .map_err(|e| {
                WireError::retryable(format!("could not subscribe on {}: {e}", inner.dest()))
            })?;
        match events.lines.recv_timeout(ACK_TIMEOUT) {
            Ok(ack) => parse_answer(&ack)?,
            Err(RecvTimeoutError::Timeout) => {
                return Err(WireError::retryable(format!(
                    "herdr on {} did not acknowledge the subscription",
                    inner.dest()
                )));
            }
            Err(RecvTimeoutError::Disconnected) => return Err(inner.bridge_end_error(&events.proc)),
        };
        Ok(Box::new(events))
    }
}

/// An open `events.subscribe` stream; dropping it kills its ssh process.
struct SshEvents {
    inner: Arc<Inner>,
    proc: Arc<Proc>,
    /// Held open: the relay stops when its stdin closes.
    stdin: ChildStdin,
    lines: Receiver<Vec<u8>>,
}

impl EventStream for SshEvents {
    fn next(&mut self, timeout: Duration) -> Result<Option<Value>, WireError> {
        match self.lines.recv_timeout(timeout) {
            Ok(line) => {
                let value: Value = serde_json::from_slice(&line).map_err(|e| {
                    WireError::retryable(format!(
                        "an event from {} was not JSON: {e}",
                        self.inner.dest()
                    ))
                })?;
                if value.get("event").is_none() && value.get("error").is_some() {
                    return Err(answer_result(&value)
                        .err()
                        .unwrap_or_else(|| WireError::retryable("event stream error")));
                }
                Ok(Some(value))
            }
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err(end_error(self.proc.wait_exit(EXIT_WAIT), self.inner.dest()))
            }
        }
    }
}

impl Drop for SshEvents {
    fn drop(&mut self) {
        self.proc.kill();
    }
}
