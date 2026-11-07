//! [`LocalWire`]: herdr's public JSON API over its unix socket on this computer.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use crate::schema::{Request, Response};
use crate::wire::{EventStream, Wire, WireError};

/// How long `events.subscribe` may take to answer with its ack.
const SUBSCRIBE_ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// herdr's default-session socket: `HERDR_SOCKET_PATH` when set, else `~/.config/herdr/herdr.sock`.
pub fn default_socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HERDR_SOCKET_PATH").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/herdr/herdr.sock")
}

/// Talks to herdr's socket: one connection per request, because herdr serves one request per
/// connection. Sockets are 0600 and owned by the user, so there is nothing to authenticate.
#[derive(Debug)]
pub struct LocalWire {
    socket_path: PathBuf,
    next_id: AtomicU64,
}

impl LocalWire {
    /// A wire to the herdr listening on `socket_path`. Nothing connects until the first request.
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            next_id: AtomicU64::new(1),
        }
    }

    /// The socket this wire talks to.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    fn connect(&self) -> Result<UnixStream, WireError> {
        UnixStream::connect(&self.socket_path).map_err(|e| {
            // Not fatal: herdr may be starting. Whether it is installed at all is decided higher up.
            WireError::retryable(format!(
                "cannot reach herdr at {}: {e}",
                self.socket_path.display()
            ))
        })
    }

    fn send(
        &self,
        stream: &mut UnixStream,
        method: &str,
        params: Value,
    ) -> Result<String, WireError> {
        let id = format!("hd-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        stream
            .write_all(&Request::new(id.clone(), method, params).to_line())
            .map_err(|e| io_error("sending the request", &e))?;
        Ok(id)
    }
}

fn io_error(what: &str, e: &io::Error) -> WireError {
    match e.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => {
            WireError::retryable(format!("herdr did not answer while {what}"))
        }
        _ => WireError::retryable(format!("lost the connection to herdr while {what}: {e}")),
    }
}

impl Wire for LocalWire {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, WireError> {
        let mut stream = self.connect()?;
        let timeout = Some(timeout.max(Duration::from_millis(1)));
        stream
            .set_read_timeout(timeout)
            .and_then(|()| stream.set_write_timeout(timeout))
            .map_err(|e| io_error("connecting", &e))?;
        self.send(&mut stream, method, params)?;
        let mut line = Vec::new();
        let read = BufReader::new(&stream)
            .read_until(b'\n', &mut line)
            .map_err(|e| io_error("waiting for the answer", &e))?;
        if read == 0 || !line.ends_with(b"\n") {
            return Err(WireError::retryable(
                "herdr closed the connection before answering",
            ));
        }
        Response::parse(&line)?.into_result()
    }

    fn events(&self, subscriptions: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
        let mut stream = self.connect()?;
        stream
            .set_read_timeout(Some(SUBSCRIBE_ACK_TIMEOUT))
            .and_then(|()| stream.set_write_timeout(Some(SUBSCRIBE_ACK_TIMEOUT)))
            .map_err(|e| io_error("connecting", &e))?;
        self.send(
            &mut stream,
            "events.subscribe",
            json!({ "subscriptions": subscriptions }),
        )?;
        let mut reader = BufReader::new(stream);
        let mut ack = Vec::new();
        let read = reader
            .read_until(b'\n', &mut ack)
            .map_err(|e| io_error("waiting for the subscription ack", &e))?;
        if read == 0 || !ack.ends_with(b"\n") {
            return Err(WireError::retryable(
                "herdr closed the connection before acknowledging the subscription",
            ));
        }
        let result = Response::parse(&ack)?.into_result()?;
        if result.get("type").and_then(Value::as_str) != Some("subscription_started") {
            return Err(WireError::retryable(
                "herdr answered the subscription with something else than an ack",
            ));
        }
        Ok(Box::new(LocalEvents {
            reader,
            partial: Vec::new(),
        }))
    }
}

/// The open connection after `events.subscribe`.
struct LocalEvents {
    reader: BufReader<UnixStream>,
    /// A line cut by a read timeout; the rest arrives on a later call.
    partial: Vec<u8>,
}

impl EventStream for LocalEvents {
    fn next(&mut self, timeout: Duration) -> Result<Option<Value>, WireError> {
        self.reader
            .get_ref()
            .set_read_timeout(Some(timeout.max(Duration::from_millis(1))))
            .map_err(|e| io_error("waiting for events", &e))?;
        loop {
            match self.reader.read_until(b'\n', &mut self.partial) {
                Ok(0) => return Err(WireError::retryable("herdr closed the event stream")),
                Ok(_) if !self.partial.ends_with(b"\n") => {
                    return Err(WireError::retryable("herdr closed the event stream"));
                }
                Ok(_) => {
                    let line = std::mem::take(&mut self.partial);
                    match serde_json::from_slice::<Value>(&line) {
                        Ok(v) if v.get("event").is_some() => return Ok(Some(v)),
                        Ok(v) if v.get("error").is_some() => {
                            return Response::parse(&line)?.into_result().map(|_| None);
                        }
                        // An answer line or something this app does not know: not an event.
                        Ok(_) | Err(_) => continue,
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(io_error("reading events", &e)),
            }
        }
    }
}
