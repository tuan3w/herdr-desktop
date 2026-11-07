//! Pages a machine serves on its own `localhost`, reached through a forward on its shared ssh connection.

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ssh::{SshClient, SshTarget};
use crate::wire::WireError;

/// Why a tunnel could not be opened.
pub type TunnelError = WireError;

/// How many free ports are tried before giving up (a port can be taken between the check and ssh's bind).
const ATTEMPTS: usize = 4;

/// A port on `127.0.0.1` that nothing listens on right now.
pub fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    Ok(listener.local_addr()?.port())
}

/// If `url` is a web address on the machine's own loopback (`localhost`, `127.0.0.1`, `[::1]`,
/// `0.0.0.0`), its port and what follows the host (`/path?query#fragment`, possibly empty), with the
/// scheme. Only `http` and `https`; a port is required unless the scheme implies it.
pub fn localhost_port(url: &str) -> Option<(String, u16, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // A user name in front of the host is how `http://localhost@evil.example` hides where it goes.
    if authority.contains('@') {
        return None;
    }
    let (host, port) = if authority.starts_with('[') {
        // An IPv6 literal: its own colons are inside the brackets.
        let close = authority.find(']')?;
        let (host, after) = authority.split_at(close + 1);
        match after {
            "" => (host, default),
            _ => (
                host,
                after
                    .strip_prefix(':')?
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p != 0)?,
            ),
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().ok().filter(|p| *p != 0)?),
            None => (authority, default),
        }
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0"
    )
    .then(|| (scheme, port, tail.to_owned()))
}

/// A forward from a free port of this computer to a port of a machine's `localhost`. Closing it (or
/// dropping it) removes the forward from the machine's shared connection.
#[derive(Debug)]
pub struct Tunnel {
    client: SshClient,
    target: SshTarget,
    local_port: u16,
    remote_port: u16,
    closed: AtomicBool,
}

impl Tunnel {
    /// Opens a tunnel to `remote_port` on the machine `target`.
    pub fn open(
        client: SshClient,
        target: SshTarget,
        remote_port: u16,
    ) -> Result<Tunnel, TunnelError> {
        let mut last = None;
        for _ in 0..ATTEMPTS {
            let local_port = free_port()
                .map_err(|e| WireError::retryable(format!("no free port on this computer: {e}")))?;
            match client.forward(&target, local_port, remote_port) {
                Ok(()) => {
                    return Ok(Tunnel {
                        client,
                        target,
                        local_port,
                        remote_port,
                        closed: AtomicBool::new(false),
                    });
                }
                // A refused login or host key will not be better with another port.
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| WireError::retryable("could not open the tunnel")))
    }

    /// The port on `127.0.0.1` of this computer.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// The port on the machine's `localhost` it leads to.
    pub fn remote_port(&self) -> u16 {
        self.remote_port
    }

    /// Removes the forward. Safe to call twice.
    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            // The shared connection may already be gone, which takes the forward with it.
            let _ = self
                .client
                .cancel_forward(&self.target, self.local_port, self.remote_port);
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.close();
    }
}
