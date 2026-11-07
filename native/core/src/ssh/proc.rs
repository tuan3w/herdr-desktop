//! Child processes the app owns: spawned with piped stdio, killed only by their own PID.

use std::io::{BufRead, BufReader, Read};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, unbounded};
use flate2::read::ZlibDecoder;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions};

/// The most stderr text kept (the tail: that is where ssh puts the reason).
const STDERR_KEEP: usize = 8 * 1024;
/// After the process exited, how long to wait for its stderr to drain.
const STDERR_GRACE: Duration = Duration::from_millis(300);
/// The largest deflated or inflated frame accepted from the remote side.
const FRAME_MAX: usize = 64 * 1024 * 1024;

/// Locks, ignoring poisoning: every guarded value here stays consistent across a panic.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a child ended and what it said on stderr.
#[derive(Debug, Clone)]
pub(crate) struct Exit {
    /// The exit status; `None` when it was killed by a signal.
    pub code: Option<i32>,
    /// The tail of stderr, lossily decoded.
    pub stderr: String,
}

#[derive(Default)]
struct State {
    exit: Option<Option<i32>>,
    stderr: Vec<u8>,
    stderr_done: bool,
}

/// A running child. Killing goes to this PID only, and only while it has not been reaped, so a
/// recycled PID can never be hit.
pub(crate) struct Proc {
    pid: u32,
    state: Mutex<State>,
    changed: Condvar,
}

/// A spawned child with its pipes.
pub(crate) struct Spawned {
    pub proc: Arc<Proc>,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

/// Spawns `command` (stdio must be piped) and starts the threads that reap it and drain its stderr.
pub(crate) fn spawn(command: &mut Command) -> std::io::Result<Spawned> {
    let mut child = command.spawn()?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::other("child stdio was not piped"));
    };
    let proc = Arc::new(Proc {
        pid: child.id(),
        state: Mutex::new(State::default()),
        changed: Condvar::new(),
    });

    let reaper = proc.clone();
    std::thread::spawn(move || {
        // Wait without reaping, so the PID stays reserved while `kill` may still be called; reap
        // under the lock that `kill` checks.
        if let Some(pid) = i32::try_from(reaper.pid).ok().and_then(Pid::from_raw) {
            while let Err(rustix::io::Errno::INTR) = rustix::process::waitid(
                WaitId::Pid(pid),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
            ) {}
        }
        let mut state = reaper.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.exit = Some(child.wait().ok().and_then(|status| status.code()));
        reaper.changed.notify_all();
    });

    let drain = proc.clone();
    std::thread::spawn(move || drain_stderr(stderr, &drain));
    Ok(Spawned {
        proc,
        stdin,
        stdout,
    })
}

fn drain_stderr(mut stderr: ChildStderr, proc: &Proc) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut buf) {
        if n == 0 {
            break;
        }
        let mut state = proc.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.stderr.extend_from_slice(&buf[..n]);
        if state.stderr.len() > STDERR_KEEP {
            let cut = state.stderr.len() - STDERR_KEEP;
            state.stderr.drain(..cut);
        }
    }
    let mut state = proc.state.lock().unwrap_or_else(PoisonError::into_inner);
    state.stderr_done = true;
    proc.changed.notify_all();
}

impl Proc {
    /// The child's PID.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// SIGKILLs this child if it is still running. Idempotent.
    pub fn kill(&self) {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.exit.is_none()
            && let Some(pid) = i32::try_from(self.pid).ok().and_then(Pid::from_raw)
        {
            let _ = rustix::process::kill_process(pid, Signal::KILL);
        }
    }

    /// Waits until the child has exited (and its stderr drained, up to a short grace), at most
    /// `timeout`. `None` when it is still running.
    pub fn wait_exit(&self, timeout: Duration) -> Option<Exit> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        while state.exit.is_none() {
            let left = deadline.checked_duration_since(Instant::now())?;
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let drain_deadline = Instant::now() + STDERR_GRACE;
        while !state.stderr_done {
            let Some(left) = drain_deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        Some(Exit {
            code: state.exit.flatten(),
            stderr: String::from_utf8_lossy(&state.stderr).into_owned(),
        })
    }
}

/// Reads the relay's framed output on a thread: plain lines, and `Z<n>` frames inflated. The
/// receiver disconnects when the stream ends or breaks (the child is killed then, a garbled stream
/// cannot be trusted).
pub(crate) fn frames(stdout: ChildStdout, proc: Arc<Proc>) -> Receiver<Vec<u8>> {
    let (tx, rx) = unbounded();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(frame)) = read_frame(&mut reader) {
            if tx.send(frame).is_err() {
                break;
            }
        }
        proc.kill();
    });
    rx
}

/// One frame: the next line without its newline, or the inflated body of a `Z<n>` frame.
/// `Ok(None)` at end of stream.
pub(crate) fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    let digits = line
        .strip_prefix(b"Z")
        .filter(|d| !d.is_empty() && d.iter().all(u8::is_ascii_digit));
    let Some(digits) = digits else {
        return Ok(Some(line));
    };
    let len: usize = std::str::from_utf8(digits)
        .ok()
        .and_then(|d| d.parse().ok())
        .filter(|&n| n <= FRAME_MAX)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad frame length"))?;
    let mut deflated = vec![0u8; len];
    reader.read_exact(&mut deflated)?;
    let mut inflated = Vec::new();
    ZlibDecoder::new(deflated.as_slice())
        .take(FRAME_MAX as u64)
        .read_to_end(&mut inflated)?;
    Ok(Some(inflated))
}
