//! What may reach `ssh`'s argument list and the remote shell.
//!
//! A destination, session name or socket path comes from a form the person typed into (or from
//! `~/.ssh/config`), and ends up on a remote command line. Nothing is spawned for a value that has not
//! passed through [`SshTarget::new`], so the rest of the module can trust what it is given.

use thiserror::Error;

/// The longest destination ssh accepts in practice (a DNS name is at most 253 characters).
const DEST_MAX: usize = 255;

/// A value that must not reach ssh or the remote shell.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid {field}: {reason}")]
pub struct InvalidTarget {
    /// Which input was rejected (`destination`, `session`, `port`, `socket path`).
    pub field: &'static str,
    /// What is wrong with it, ready to show next to the field.
    pub reason: String,
}

fn invalid(field: &'static str, reason: &str) -> InvalidTarget {
    InvalidTarget {
        field,
        reason: reason.to_owned(),
    }
}

/// Accepts `user@host`, a host name, an IPv4/IPv6 literal or an ssh config alias.
///
/// The set is `[A-Za-z0-9._@:\[\]-]`, 1 to 255 characters, and the value may not start with `-`:
/// a leading dash would be read by ssh as an option (`-oProxyCommand=...` runs a command), so the
/// destination also always follows `--` on the command line.
pub fn validate_dest(dest: &str) -> Result<(), InvalidTarget> {
    if dest.is_empty() || dest.len() > DEST_MAX {
        return Err(invalid("destination", "must be 1 to 255 characters"));
    }
    if dest.starts_with('-') {
        return Err(invalid("destination", "must not start with '-'"));
    }
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | ':' | '[' | ']' | '-');
    if !dest.chars().all(allowed) {
        return Err(invalid(
            "destination",
            "may only contain letters, digits and . _ @ : [ ] -",
        ));
    }
    Ok(())
}

/// Accepts a herdr session name: `[A-Za-z0-9._-]+`, and not `.` or `..` because the name becomes a
/// directory in the remote socket path.
pub fn validate_name(name: &str) -> Result<(), InvalidTarget> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(invalid(
            "session",
            "may only contain letters, digits and . _ -",
        ));
    }
    if name == "." || name == ".." {
        return Err(invalid("session", "must not be '.' or '..'"));
    }
    Ok(())
}

/// Single-quotes `s` for a POSIX shell: the result is one word whose value is exactly `s`.
///
/// This is the only quoting function in the module. A single quote inside the value is written as
/// `'\''` (close, escaped quote, reopen), so no character of `s` is ever special.
pub fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// A validated remote machine: where to connect and which herdr to talk to.
///
/// Fields are private so a value of this type is always safe to spawn with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    dest: String,
    port: Option<u16>,
    session: Option<String>,
    socket_path: Option<String>,
}

impl SshTarget {
    /// Validates every input. `session` `None` or `"default"` means herdr's default session;
    /// `socket_path` overrides where the remote herdr socket is looked for (an absolute path on the
    /// remote machine).
    pub fn new(
        dest: &str,
        port: Option<u16>,
        session: Option<&str>,
        socket_path: Option<&str>,
    ) -> Result<Self, InvalidTarget> {
        validate_dest(dest)?;
        if port == Some(0) {
            return Err(invalid("port", "must be 1 to 65535"));
        }
        let session = match session {
            None | Some("") | Some("default") => None,
            Some(name) => {
                validate_name(name)?;
                Some(name.to_owned())
            }
        };
        let socket_path = match socket_path {
            None | Some("") => None,
            Some(path) if path.starts_with('/') && !path.contains('\0') => Some(path.to_owned()),
            Some(_) => return Err(invalid("socket path", "must be an absolute path")),
        };
        Ok(Self {
            dest: dest.to_owned(),
            port,
            session,
            socket_path,
        })
    }

    /// The `user@host` or alias to connect to.
    pub fn dest(&self) -> &str {
        &self.dest
    }

    /// The ssh port, `None` for ssh's own default (or the one in `~/.ssh/config`).
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// The herdr session name; `"default"` for the default session.
    pub fn session(&self) -> &str {
        self.session.as_deref().unwrap_or("default")
    }

    /// The explicit remote socket path, if one was given.
    pub fn socket_path(&self) -> Option<&str> {
        self.socket_path.as_deref()
    }
}
