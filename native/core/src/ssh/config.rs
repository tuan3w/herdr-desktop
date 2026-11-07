//! The host aliases of `~/.ssh/config`, for the destination field's suggestions.
//!
//! Minimal on purpose: ssh itself resolves the alias when connecting, so this only has to list names.

use std::path::{Path, PathBuf};

use super::validate::validate_dest;

/// `~/.ssh/config`, or `None` when the home directory is unknown.
pub fn default_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config"))
}

/// The `Host` aliases defined in the ssh config at `path`, in file order, without duplicates.
///
/// Patterns (`*`, `?`, `!`) are skipped because they are not names to connect to, as are aliases that
/// [`validate_dest`] would refuse. `Include` is followed one level (relative paths are relative to
/// the config's directory, `~` is the home directory, `*` globs file names). A missing or unreadable
/// file yields nothing.
pub fn config_hosts(path: &Path) -> Vec<String> {
    let mut hosts = Vec::new();
    let base = path.parent().unwrap_or(Path::new("."));
    collect(path, base, true, &mut hosts);
    hosts
}

fn collect(path: &Path, base: &Path, follow_includes: bool, hosts: &mut Vec<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let Some((keyword, rest)) = split_directive(line) else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            for alias in words(rest) {
                if !alias.contains(['*', '?', '!'])
                    && validate_dest(&alias).is_ok()
                    && !hosts.contains(&alias)
                {
                    hosts.push(alias);
                }
            }
        } else if follow_includes && keyword.eq_ignore_ascii_case("include") {
            for pattern in words(rest) {
                for file in expand_include(&pattern, base) {
                    collect(&file, base, false, hosts);
                }
            }
        }
    }
}

/// `Keyword value` or `Keyword=value`, comments and blank lines excluded.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let rest = line[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((&line[..end], rest))
}

/// Splits on whitespace, honouring double quotes, and stops at a `#` comment.
fn words(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_word = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has_word = true;
            }
            '#' if !quoted => break,
            c if c.is_whitespace() && !quoted => {
                if has_word {
                    out.push(std::mem::take(&mut current));
                    has_word = false;
                }
            }
            c => {
                current.push(c);
                has_word = true;
            }
        }
    }
    if has_word {
        out.push(current);
    }
    out
}

fn expand_include(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let full = if let Some(rest) = pattern.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => return Vec::new(),
        }
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        base.join(pattern)
    };
    let (Some(dir), Some(name)) = (full.parent(), full.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    if !name.contains('*') {
        return vec![full];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| glob_matches(name, n))
                && e.path().is_file()
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

/// `*` matches any run of characters; everything else matches itself.
fn glob_matches(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if parts.len() == 1 {
        return pattern == text;
    }
    if !text.starts_with(first) || !text.ends_with(last) || text.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for middle in &parts[1..parts.len() - 1] {
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    true
}
