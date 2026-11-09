//! Child processes the app owns: spawned with piped stdio, killed only by their own PID.

use std::io::{BufRead, BufReader, Error, ErrorKind, Read};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, unbounded};
use flate2::read::ZlibDecoder;
use flate2::{Decompress, FlushDecompress, Status};
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

    /// Whether the child has not exited yet.
    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .exit
            .is_none()
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

/// Reads the relay's framed output on a thread: plain lines, `Z<n>` frames inflated on their own,
/// and `E<n>` event frames inflated through the one zlib stream this stdout carries. The receiver
/// disconnects when the stream ends or breaks (the child is killed then, a garbled stream cannot be
/// trusted).
pub(crate) fn frames(stdout: ChildStdout, proc: Arc<Proc>) -> Receiver<Vec<u8>> {
    let (tx, rx) = unbounded();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut events = Decompress::new(true);
        while let Ok(Some(frame)) = read_frame(&mut reader, &mut events) {
            if tx.send(frame).is_err() {
                break;
            }
        }
        proc.kill();
    });
    rx
}

/// One frame: the next line without its newline, the inflated body of a `Z<n>` frame, or the next
/// event of an `E<n>` frame (`events` is the stream's inflater and must outlive the frames: each
/// piece continues the one before). `Ok(None)` at end of stream.
pub(crate) fn read_frame(
    reader: &mut impl BufRead,
    events: &mut Decompress,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    let tagged = match line.split_first() {
        Some((tag, digits))
            if matches!(*tag, b'Z' | b'E')
                && !digits.is_empty()
                && digits.iter().all(u8::is_ascii_digit) =>
        {
            Some((*tag == b'E', digits))
        }
        _ => None,
    };
    let Some((event, digits)) = tagged else {
        return Ok(Some(line));
    };
    let len: usize = std::str::from_utf8(digits)
        .ok()
        .and_then(|d| d.parse().ok())
        .filter(|&n| n <= FRAME_MAX)
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "bad frame length"))?;
    let mut deflated = vec![0u8; len];
    reader.read_exact(&mut deflated)?;
    if event {
        let mut inflated = inflate_piece(events, &deflated)?;
        // The relay puts a newline after every event before deflating it.
        if inflated.last() == Some(&b'\n') {
            inflated.pop();
        }
        return Ok(Some(inflated));
    }
    let mut inflated = Vec::new();
    ZlibDecoder::new(deflated.as_slice())
        .take(FRAME_MAX as u64)
        .read_to_end(&mut inflated)?;
    Ok(Some(inflated))
}

/// Inflates one sync-flushed piece of a zlib stream, refusing more than `FRAME_MAX` of output.
fn inflate_piece(z: &mut Decompress, packed: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(packed.len().saturating_mul(8).clamp(4096, 1 << 20));
    let mut input = packed;
    loop {
        let (in_before, out_before) = (z.total_in(), out.len());
        let status = z
            .decompress_vec(input, &mut out, FlushDecompress::Sync)
            .map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
        let used = usize::try_from(z.total_in() - in_before).unwrap_or(input.len());
        input = &input[used.min(input.len())..];
        if out.len() > FRAME_MAX {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "an event frame inflates past the allowed size",
            ));
        }
        // A full output buffer may hide more output: make room and go on.
        if input.is_empty() && out.len() < out.capacity() {
            return Ok(out);
        }
        if status == Status::StreamEnd {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "the event stream ended inside its connection",
            ));
        }
        if used == 0 && out.len() == out_before && out.len() < out.capacity() {
            return Err(Error::new(ErrorKind::InvalidData, "a stalled event frame"));
        }
        out.reserve(out.capacity().max(4096));
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use flate2::write::ZlibEncoder;
    use flate2::{Compress, Compression, FlushCompress};

    use super::*;

    /// What the relay writes for each event: the event and a newline, sync-flushed on one stream.
    fn event_frames(events: &[&[u8]]) -> Vec<u8> {
        let mut z = Compress::new(Compression::new(6), true);
        let mut wire = Vec::new();
        for event in events {
            let mut input = event.to_vec();
            input.push(b'\n');
            let mut piece = Vec::with_capacity(input.len() * 2 + 128);
            z.compress_vec(&input, &mut piece, FlushCompress::Sync)
                .expect("compress");
            wire.extend_from_slice(format!("E{}\n", piece.len()).as_bytes());
            wire.extend_from_slice(&piece);
        }
        wire
    }

    fn read_all(wire: Vec<u8>) -> std::io::Result<Vec<Vec<u8>>> {
        let mut reader = Cursor::new(wire);
        let mut events = Decompress::new(true);
        let mut got = Vec::new();
        while let Some(frame) = read_frame(&mut reader, &mut events)? {
            got.push(frame);
        }
        Ok(got)
    }

    #[test]
    fn events_continue_one_stream_across_frames_between_plain_and_answer_frames() {
        let first: &[u8] = br#"{"event":"pane_updated","data":{"n":1}}"#;
        let second: &[u8] = br#"{"event":"pane_updated","data":{"n":2}}"#;
        let big = format!(
            r#"{{"event":"x","data":"{}"}}"#,
            "row of text ".repeat(5000)
        );
        let mut answer = ZlibEncoder::new(Vec::new(), Compression::new(6));
        answer.write_all(br#"{"id":"a"}"#).unwrap();
        let answer = answer.finish().unwrap();

        let mut wire = b"{\"id\":\"ack\"}\n".to_vec();
        wire.extend_from_slice(format!("Z{}\n", answer.len()).as_bytes());
        wire.extend_from_slice(&answer);
        wire.extend_from_slice(&event_frames(&[first, second, big.as_bytes(), first]));

        let got = read_all(wire).expect("decode");
        assert_eq!(got.len(), 6);
        assert_eq!(got[0], br#"{"id":"ack"}"#);
        assert_eq!(got[1], br#"{"id":"a"}"#);
        assert_eq!(got[2], first);
        assert_eq!(got[3], second);
        assert_eq!(got[4], big.as_bytes());
        assert_eq!(got[5], first, "a repeat is decoded from the shared window");
    }

    #[test]
    fn an_event_frame_cut_short_or_garbled_ends_the_stream() {
        let wire = event_frames(&[br#"{"event":"a"}"#]);
        assert!(read_all(wire[..wire.len() - 3].to_vec()).is_err());

        // The piece starts after the `E<n>` line; a zlib header that fails its check is an error.
        let mut garbled = wire.clone();
        let at = garbled.iter().position(|b| *b == b'\n').unwrap() + 1;
        garbled[at..at + 2].fill(0xff);
        assert!(read_all(garbled).is_err());
    }
}
