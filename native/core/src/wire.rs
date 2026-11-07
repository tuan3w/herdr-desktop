//! The seam between herdr and everything above it: one request per call, plus a long-lived event stream.
//!
//! Framing (herdr 0.9.5, protocol 22): newline-delimited JSON, ONE request per connection,
//! request `{"id":..,"method":..,"params":..}`, response `{"id":..,"result":..}` or `{"id":..,"error":{"code","message"}}`.
//! `events.subscribe` keeps the connection open: an ack `{"result":{"type":"subscription_started"}}`, then one
//! `{"event":"pane_updated","data":{..}}` line per event (event names use underscores, subscription types dots).

use std::time::Duration;

use serde_json::Value;
use thiserror::Error;

/// Why a wire call failed, and whether trying again can help.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct WireError {
    pub kind: ErrorKind,
    pub message: String,
}

/// Whether a failure may be retried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    /// Network, timeout, herdr restarting: the link backs off and tries again.
    Retryable,
    /// Retrying cannot help: the link stops and shows `Attention` with the reason.
    Fatal(Fatal),
    /// herdr answered with `{"error":{"code","message"}}`: the request was wrong, the link is fine.
    Api { code: String },
}

/// The reasons a link stops retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fatal {
    HostKeyUnknown,
    HostKeyChanged,
    AuthFailed,
    SshMissing,
    BridgeMissing,
    HerdrMissing,
    Protocol,
}

impl WireError {
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Retryable,
            message: message.into(),
        }
    }

    pub fn fatal(fatal: Fatal, message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Fatal(fatal),
            message: message.into(),
        }
    }

    pub fn api(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Api { code: code.into() },
            message: message.into(),
        }
    }

    /// True when the link must stop retrying.
    pub fn is_fatal(&self) -> bool {
        matches!(self.kind, ErrorKind::Fatal(_))
    }
}

/// A source of events: `next` blocks up to `timeout` and returns `Ok(None)` on a quiet interval.
/// An `Err` ends the stream (the link reconnects or stops by the error's kind).
pub trait EventStream: Send {
    fn next(&mut self, timeout: Duration) -> Result<Option<Value>, WireError>;
}

/// A connection to one herdr: local socket or ssh relay. Implementations are cheap to share.
pub trait Wire: Send + Sync {
    /// One request; the `result` value of the answer. A herdr error answer is `ErrorKind::Api`.
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, WireError>;

    /// Subscribes (`subscriptions` is the `events.subscribe` params array, e.g. `[{"type":"pane.updated"}]`)
    /// and returns the stream of `{"event","data"}` objects after the ack.
    fn events(&self, subscriptions: &[Value]) -> Result<Box<dyn EventStream>, WireError>;

    /// The PIDs of the processes this wire started and that are still running (the ssh relay and
    /// event streams of a remote machine); none for a socket. They are the only processes the app
    /// may signal on this machine's behalf: diagnostics and tests that cut a connection use them.
    fn child_pids(&self) -> Vec<u32> {
        Vec::new()
    }
}
