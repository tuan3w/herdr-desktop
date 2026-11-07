//! `Diagrams`: where the bundled mermaid script is served from, for the web views that draw ` ```mermaid ` blocks.
//!
//! A web view may show `http` and `https` pages of the hosts `nsh.json` lists (`127.0.0.1`), not `file:`
//! addresses, and putting a 2.7 MB script into every page's HTML would copy it through the JavaScript
//! engine once per diagram. So the script is served once from a loopback listener of this process: the
//! web view's cache then keeps it for every later diagram. The listener answers `GET /mermaid.min.js` and
//! nothing else, and only on `127.0.0.1`; the page that loads it carries a content security policy with no
//! network access at all (`components/mermaid-block.tsx`).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::LazyLock;
use std::time::Duration;

use nsh_core::prelude::*;

/// The bundled mermaid build (MIT, `NOTICE`): the minified single file.
const MERMAID: &[u8] = include_bytes!("../../../assets/mermaid.min.js");

/// How long a client may take to send its request line before the connection is dropped.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// The most bytes of a request read: the request line is all that matters.
const REQUEST_MAX: usize = 2048;

static ORIGIN: LazyLock<Result<String, String>> = LazyLock::new(start);

fn serve(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let mut buf = [0u8; REQUEST_MAX];
    let mut have = 0;
    // Only the first line decides, so stop reading as soon as it is complete.
    while have < buf.len() && !buf[..have].contains(&b'\n') {
        match stream.read(&mut buf[have..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => have += n,
        }
    }
    let line = String::from_utf8_lossy(&buf[..have]);
    let first = line.lines().next().unwrap_or("");
    let found = first.starts_with("GET /mermaid.min.js ");
    let head = if found {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/javascript; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: max-age=86400\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
            MERMAID.len()
        )
    } else {
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
    };
    let _ = stream.write_all(head.as_bytes());
    if found {
        let _ = stream.write_all(MERMAID);
    }
}

fn start() -> Result<String, String> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("cannot serve the diagram script: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot serve the diagram script: {e}"))?
        .port();
    std::thread::Builder::new()
        .name("herdr-diagrams".to_owned())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                // One short-lived thread per connection: a client that stalls holds only its own.
                let _ = std::thread::Builder::new()
                    .name("herdr-diagrams-conn".to_owned())
                    .spawn(move || serve(stream));
            }
        })
        .map_err(|e| format!("cannot serve the diagram script: {e}"))?;
    Ok(format!("http://127.0.0.1:{port}"))
}

/// Draws ` ```mermaid ` blocks: the address the bundled script is served from.
#[module]
pub struct Diagrams;

#[module]
impl Diagrams {
    /// The origin (`http://127.0.0.1:<port>`) that serves `/mermaid.min.js` to a diagram's web view. Starts
    /// the loopback listener the first time; the same origin is returned afterwards. Throws when the
    /// listener cannot start.
    pub fn origin() -> Result<String, String> {
        ORIGIN.clone()
    }
}
