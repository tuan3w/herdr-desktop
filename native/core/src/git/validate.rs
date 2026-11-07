//! What a path must be before it reaches git or a remote shell.

use crate::files::{PATH_MAX, validate_path};

use super::{GitError, GitErrorKind};

fn invalid(why: impl Into<String>) -> GitError {
    GitError::new(GitErrorKind::Invalid, why)
}

/// A folder to run git in: absolute (or `~` / `~/...`, which each side expands), no NUL byte, bounded.
pub fn validate_dir(dir: &str) -> Result<(), GitError> {
    validate_path(dir).map_err(|e| invalid(e.message))
}

/// A file inside a checkout, as git lists it: relative to the root, no NUL byte, bounded, and never a way out of the
/// root (`..`) or a `.git` entry. A leading `-` or `~`, a newline or a quote are legal parts of a name and are passed
/// on as they are: every use puts the path after `--` or in a file the helper opens by `root + path`, never in shell
/// syntax and never through tilde expansion.
pub fn validate_rel(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(invalid("There is no file"));
    }
    if path.len() > PATH_MAX {
        return Err(invalid("That path is too long"));
    }
    if path.contains('\0') {
        return Err(invalid("That path has a NUL byte in it"));
    }
    if path.starts_with('/') {
        return Err(invalid("A file is named from the checkout's root"));
    }
    for part in path.split('/') {
        if part == ".." {
            return Err(invalid("A file cannot be outside its checkout"));
        }
        if part.eq_ignore_ascii_case(".git") {
            return Err(invalid("git's own folder is not a file to review"));
        }
    }
    Ok(())
}
