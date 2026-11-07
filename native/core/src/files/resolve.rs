//! Turning what an agent printed (a path, a `file:` address from a drop) into something to open.

use super::PATH_MAX;

/// Where `target` (a path from an agent's output) may be, best guess first.
///
/// An absolute path or `~/x` is itself and nothing else. A relative one is looked for in the pane's
/// folder, then the two folders above it (agents name files from the project root while the pane sits in
/// a subfolder). A leading `./` is dropped, and so is the `a/` or `b/` git puts before paths in a diff,
/// as a second try for each folder. Nothing here touches a machine: the caller asks each in turn.
pub fn candidates(cwd: &str, target: &str) -> Vec<String> {
    let target = target.trim();
    if target.is_empty() || target.contains('\0') {
        return Vec::new();
    }
    if target.starts_with('/') || target == "~" || target.starts_with("~/") {
        return vec![target.to_owned()];
    }
    let target = target.strip_prefix("./").unwrap_or(target);
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
            let path = format!("{}/{}", folder.trim_end_matches('/'), name);
            if path.len() <= PATH_MAX && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
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
