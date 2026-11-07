//! The commands run on the remote machine: the relay, and the bridges it falls back to.
//!
//! Every command is shipped as ONE single-quoted word (`sh -c '...'` around base64 text), so the
//! remote login shell (bash, zsh, fish, csh) never parses our script. Values inside the script go
//! through [`shq`].

use super::validate::{SshTarget, shq};

/// The python relay that serves pipelined requests (see the docstring of `relay.py`).
pub const RELAY_SCRIPT: &str = include_str!("relay.py");

/// The 20-line python bridge: one herdr connection over stdin/stdout, last in the fallback chain.
pub const BRIDGE_SCRIPT: &str = include_str!("bridge.py");

/// The first line the relay prints when it can serve requests.
pub const READY_LINE: &str = "herdr-desktop-relay-v1";

/// What `herdr remote-api-bridge --check` prints when that bridge works.
pub const HERDR_BRIDGE_CHECK: &str = "herdr-api-bridge-v1";

/// Exit status of the relay and of the bridge script for "this machine cannot do it".
pub const EXIT_UNAVAILABLE: i32 = 78;

/// How responses longer than this many bytes are framed (`Z<n>`, newline, `n` bytes of zlib).
pub const COMPRESS_MIN: usize = 512;

/// Where the remote herdr socket is looked for, as a shell word evaluated on the remote machine.
///
/// An explicit path wins. The default session is `$HERDR_SOCKET_PATH` or
/// `${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock`; a named session lives in
/// `.../herdr/sessions/<name>/herdr.sock`. The named layout is the one herdr-mobile uses; on this
/// machine only the default session exists, so it is unverified for named sessions, which is why
/// `herdr --session NAME remote-api-bridge` (which knows the truth) is tried when the relay cannot find the socket.
pub fn socket_word(target: &SshTarget) -> String {
    if let Some(path) = target.socket_path() {
        return shq(path);
    }
    match target.session() {
        "default" => {
            r#""${HERDR_SOCKET_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock}""#
                .to_owned()
        }
        // The name passed validation, so it holds none of the characters special inside double quotes.
        name => {
            format!(r#""${{XDG_CONFIG_HOME:-$HOME/.config}}/herdr/sessions/{name}/herdr.sock""#)
        }
    }
}

/// The remote command that starts the relay (or exits 78 with a hint when `python3` or the socket is missing).
pub fn relay_command(target: &SshTarget) -> String {
    wrap_sh(&format!(
        "if ! command -v python3 >/dev/null 2>&1; then\n  echo 'herdr-desktop: the relay needs python3 on this machine' >&2\n  exit {EXIT_UNAVAILABLE}\nfi\nS={}\nexec python3 -c {} \"$S\"\n",
        socket_word(target),
        shq(RELAY_SCRIPT),
    ))
}

/// The remote command that connects stdin/stdout to herdr's socket once.
///
/// Preference: `herdr --session NAME remote-api-bridge` when its `--check` prints
/// [`HERDR_BRIDGE_CHECK`] (it knows where its own socket is), then `socat`, then the python bridge.
/// Exits 78 when none exists.
pub fn bridge_command(target: &SshTarget) -> String {
    let session = shq(target.session());
    wrap_sh(&format!(
        "for H in \"$HOME/.local/bin/herdr\" \"$(command -v herdr 2>/dev/null)\"; do\n  \
         if [ -n \"$H\" ] && [ -x \"$H\" ] && [ \"$(\"$H\" --session {session} remote-api-bridge --check </dev/null 2>/dev/null)\" = {HERDR_BRIDGE_CHECK} ]; then\n    \
         exec \"$H\" --session {session} remote-api-bridge\n  fi\ndone\n\
         S={socket}\n\
         if command -v socat >/dev/null 2>&1; then exec socat - \"UNIX-CONNECT:$S\"; fi\n\
         if command -v python3 >/dev/null 2>&1; then exec python3 -c {bridge} \"$S\"; fi\n\
         echo 'herdr-desktop: need herdr 0.9 or newer, socat or python3 on this machine' >&2\nexit {EXIT_UNAVAILABLE}\n",
        socket = socket_word(target),
        bridge = shq(BRIDGE_SCRIPT),
    ))
}

/// `exec` of `argv` with every word quoted, as one remote command (see [`wrap_sh`]).
pub fn argv_command(argv: &[&str]) -> String {
    let words: Vec<String> = argv.iter().map(|w| shq(w)).collect();
    wrap_sh(&format!("exec {}\n", words.join(" ")))
}

/// `sh -c 'eval "$(echo <base64> | base64 -d)"'`: a script as one quote-free word.
///
/// The remote login shell may be fish or csh, which parse `$( )`, `{ }` and `||` differently from
/// sh; base64 has no character any shell treats specially. `base64 -D` is the macOS spelling.
/// Standard input stays untouched: it is the data path.
pub fn wrap_sh(script: &str) -> String {
    format!(
        "sh -c 'eval \"$(echo {} | {{ base64 -d 2>/dev/null || base64 -D; }})\"'",
        base64(script.as_bytes())
    )
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard padded base64 (RFC 4648), for [`wrap_sh`].
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        out.push(char::from(ALPHABET[(n >> 18) as usize & 63]));
        out.push(char::from(ALPHABET[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(n >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[n as usize & 63])
        } else {
            '='
        });
    }
    out
}
