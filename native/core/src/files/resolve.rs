//! Turning what an agent printed (a path, a `file:` address from a drop) into something to open.

use super::{FileError, FileErrorKind, Files, PATH_MAX, Stat};

/// Where `target` (a path from an agent's output) may be, best guess first.
///
/// An absolute path or `~/x` is itself and nothing else. A path that names its own place from the pane's
/// folder (`./x`, `../x`, `.`, `..`) is only there. Any other relative one is looked for in the pane's
/// folder, then the two folders above it (agents name files from the project root while the pane sits in
/// a subfolder), and without the `a/` or `b/` git puts before paths in a diff as a second try for each
/// folder, as herdr-mobile does (`lookupAttempts`). `.` and `..` are folded (`../x` from `/w/p` is `/w/x`),
/// so what is found reads as the file's own path. Nothing here touches a machine: the caller asks each in
/// turn.
pub fn candidates(cwd: &str, target: &str) -> Vec<String> {
    let target = target.trim();
    if target.is_empty() || target.contains('\0') {
        return Vec::new();
    }
    if target.starts_with('/') || target == "~" || target.starts_with("~/") {
        return vec![target.to_owned()];
    }
    if is_explicit(target) {
        let path = fold_dots(&format!("{}/{target}", cwd.trim_end_matches('/')));
        return if path.len() <= PATH_MAX {
            vec![path]
        } else {
            Vec::new()
        };
    }
    let mut names = vec![target];
    if let Some(rest) = target
        .strip_prefix("a/")
        .or_else(|| target.strip_prefix("b/"))
    {
        names.push(rest);
    }
    let mut folders = Vec::new();
    let mut folder = cwd.trim_end_matches('/');
    for _ in 0..3 {
        if folder.is_empty() {
            folders.push("/");
            break;
        }
        folders.push(folder);
        folder = folder.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
    let mut out: Vec<String> = Vec::new();
    for folder in folders {
        for name in &names {
            // `..` is a legitimate part of a path an agent names; only a NUL or an absurd length is not.
            let path = fold_dots(&format!("{}/{}", folder.trim_end_matches('/'), name));
            if path.len() <= PATH_MAX && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// Whether a relative `target` names its place from the folder it was written in: `.`, `..`, `./x`, `../x`.
fn is_explicit(target: &str) -> bool {
    matches!(target, "." | "..") || target.starts_with("./") || target.starts_with("../")
}

/// A path under `/` or `~` with its `.` and `..` segments folded and doubled slashes dropped; `..` at the
/// top stays at the top, as the system does at the root (the home folder's parent is left to `~/..` itself).
fn fold_dots(path: &str) -> String {
    let (head, rest) = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => ("~", rest),
        _ => ("", path),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." if head.is_empty() || parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return if head.is_empty() {
            "/".to_owned()
        } else {
            head.to_owned()
        };
    }
    format!("{head}/{}", parts.join("/"))
}

/// Finds what an agent named: `target` is looked for in each of `folders` in turn (the session's folder first,
/// then the checkout and the project it belongs to), as [`candidates`] orders the tries of each, and the first
/// path that exists wins, with what it is; `./x` and `../x` are the session's folder's only. A path that exists
/// but cannot be read is the answer, not a reason to look elsewhere. When nothing is there the error is
/// [`FileErrorKind::NotFound`] and says where it looked, in the words a person reads: `.scratch/x.png isn't in
/// /w/proj` (the first folder: the one the agent works in), as herdr-mobile says it (`pathNotFoundMessage`).
///
/// # Errors
///
/// Not found, denied, the machine's own failure, or [`FileErrorKind::Invalid`] for an empty target or a
/// relative one with no folder to look in.
pub fn find(
    files: &dyn Files,
    folders: &[String],
    target: &str,
) -> Result<(String, Stat), FileError> {
    let target = target.trim();
    let own = target.starts_with('/') || target == "~" || target.starts_with("~/");
    let mut tries: Vec<String> = Vec::new();
    if own {
        tries = candidates("/", target);
    } else {
        let take = if is_explicit(target) {
            1
        } else {
            folders.len()
        };
        for folder in folders.iter().filter(|f| !f.is_empty()).take(take) {
            for path in candidates(folder, target) {
                if !tries.contains(&path) {
                    tries.push(path);
                }
            }
        }
    }
    if tries.is_empty() {
        let why = if target.is_empty() {
            "There is no path".to_owned()
        } else {
            format!("Cannot tell which folder {target} is in")
        };
        return Err(FileError::new(FileErrorKind::Invalid, why));
    }
    let mut denied = None;
    for path in tries {
        match files.stat(&path) {
            Ok(stat) => return Ok((path, stat)),
            Err(e) if e.kind == FileErrorKind::NotFound => {}
            Err(e) if e.kind == FileErrorKind::Denied => denied = denied.or(Some(e)),
            Err(e) => return Err(e),
        }
    }
    Err(denied.unwrap_or_else(|| {
        let why = match folders.iter().find(|f| !f.is_empty()) {
            Some(folder) if !own => format!("{target} isn't in {folder}"),
            _ => format!("{target} does not exist"),
        };
        FileError::new(FileErrorKind::NotFound, why)
    }))
}

/// The local path a `file:` address names (what a drop delivers), percent-decoded. Only `file:` with an
/// empty or `localhost` host: a drop of anything else is not a file on this computer.
pub fn path_from_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = path.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    (!text.contains('\0')).then_some(text)
}

/// The `file:` address of a local path: everything but letters, digits and `-._~/` is percent-encoded.
pub fn uri_from_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    out.push_str("file://");
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The folder part of a path (`/a/b` is `/a`, `/a` is `/`, `/` stays `/`); `None` for a path that is
/// not absolute.
pub fn parent(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    Some(match trimmed.rsplit_once('/') {
        Some(("", _)) | None => "/".to_owned(),
        Some((parent, _)) => parent.to_owned(),
    })
}
