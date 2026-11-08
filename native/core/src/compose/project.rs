//! A picture saved into the project: for an agent that cannot see pictures, the one way to show it one is a file the
//! agent can open. The file goes to `<project>/.herdr-desktop/attachments/` (on whatever machine the project is, over
//! the shared ssh connection for another one), named after the picture, never over another file.

use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::files::{FileErrorKind, Files, join, validate_path};

/// Where pictures are saved, relative to the session's folder.
pub const ATTACHMENTS_DIR: &str = ".herdr-desktop/attachments";

/// One upload chunk: a remote `put` is one ssh command, so a picture is a handful of them, not hundreds.
const CHUNK: usize = 1024 * 1024;

/// The most names tried for one file (`shot.png`, `shot-2.png`, ...).
const NAMES: u32 = 50;

/// A picture that was saved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    /// Where, as the machine says it (absolute).
    pub path: String,
    /// The project's `.gitignore` already lists `.herdr-desktop`: the picture will not be committed by accident.
    pub ignored: bool,
}

fn candidate(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_owned();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}-{n}.{ext}"),
        None => format!("{name}-{n}"),
    }
}

/// `name` as one file name: no folder part, no control character, nothing a shell or a path would read specially.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || c == ':' { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() {
        "picture.png".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// Saves `source` (a file of this computer) into `cwd/.herdr-desktop/attachments/` on the machine `fs` reads and
/// writes, under `name`, and says where.
///
/// # Errors
/// The reason in words: the folder cannot be made, the file cannot be written, or 50 names were taken.
pub fn save_to_project(
    fs: &dyn Files,
    cwd: &str,
    source: &Path,
    name: &str,
) -> Result<Saved, String> {
    let bytes = std::fs::read(source).map_err(|e| format!("Could not read the picture: {e}"))?;
    validate_path(cwd).map_err(|e| e.message)?;
    let folder = format!("{}/{ATTACHMENTS_DIR}", cwd.trim_end_matches('/'));
    fs.mkdir(&folder)
        .map_err(|e| format!("Could not make {ATTACHMENTS_DIR}: {}", e.message))?;
    // The folder ignores itself, so a picture is never committed and the project's own .gitignore is never asked to change.
    let own = self_ignored(fs, cwd);
    let name = clean_name(name);
    for n in 1..=NAMES {
        let path = join(&folder, &candidate(&name, n)).map_err(|e| e.message)?;
        match write_new(fs, &path, &bytes) {
            Ok(()) => {
                return Ok(Saved {
                    path,
                    ignored: own || gitignored(fs, cwd),
                });
            }
            Err(e) if e.kind == FileErrorKind::Exists => {}
            Err(e) => return Err(format!("Could not save the picture: {}", e.message)),
        }
    }
    Err(format!(
        "{ATTACHMENTS_DIR} already holds {NAMES} files named like {name}"
    ))
}

/// Writes `.herdr-desktop/.gitignore` holding `*` when it is not there; true when it is in place.
fn self_ignored(fs: &dyn Files, cwd: &str) -> bool {
    let path = format!("{}/.herdr-desktop/.gitignore", cwd.trim_end_matches('/'));
    match write_new(fs, &path, b"*\n") {
        Ok(()) => true,
        Err(e) => e.kind == FileErrorKind::Exists,
    }
}

fn write_new(fs: &dyn Files, path: &str, bytes: &[u8]) -> Result<(), crate::files::FileError> {
    let mut offset = 0_u64;
    for chunk in bytes
        .chunks(CHUNK)
        .chain(bytes.is_empty().then_some(&[][..]))
    {
        if let Err(e) = fs.put(path, offset, chunk) {
            let _ = fs.discard(path);
            return Err(e);
        }
        offset += chunk.len() as u64;
    }
    fs.commit(path, false).inspect_err(|_| {
        let _ = fs.discard(path);
    })
}

/// Whether `cwd/.gitignore` names `.herdr-desktop` (with or without a slash or a leading one).
fn gitignored(fs: &dyn Files, cwd: &str) -> bool {
    let Ok(path) = join(cwd, ".gitignore") else {
        return false;
    };
    let Ok(chunk) = fs.read(&path, 0, 64 * 1024) else {
        return false;
    };
    String::from_utf8_lossy(&chunk.data).lines().any(|l| {
        matches!(
            l.trim(),
            ".herdr-desktop"
                | ".herdr-desktop/"
                | "/.herdr-desktop"
                | "/.herdr-desktop/"
                | ".herdr-desktop/*"
        )
    })
}

/// Removes the files of `dir` last written more than `older` ago (pictures of messages long sent). Folders and
/// anything it cannot remove are left alone.
pub fn purge(dir: &Path, older: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|m| m.modified().ok())
            .is_some_and(|t| now.duration_since(t).is_ok_and(|age| age > older));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::LocalFiles;

    fn project() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        (dir, cwd)
    }

    fn picture(dir: &Path) -> std::path::PathBuf {
        let p = dir.join("source.png");
        std::fs::write(&p, b"pixels").expect("write");
        p
    }

    #[test]
    fn a_picture_lands_in_the_attachments_folder_and_a_taken_name_gets_a_number() {
        let (dir, cwd) = project();
        let elsewhere = tempfile::tempdir().expect("dir");
        let source = picture(elsewhere.path());
        let fs = LocalFiles::new();
        let a = save_to_project(&fs, &cwd, &source, "shot.png").expect("saved");
        assert_eq!(a.path, format!("{cwd}/.herdr-desktop/attachments/shot.png"));
        assert_eq!(std::fs::read(&a.path).expect("read"), b"pixels");
        let b = save_to_project(&fs, &cwd, &source, "shot.png").expect("saved again");
        assert_eq!(
            b.path,
            format!("{cwd}/.herdr-desktop/attachments/shot-2.png")
        );
        // The folder ignores itself: the project's own .gitignore is left alone.
        assert!(a.ignored);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".herdr-desktop/.gitignore")).expect("read"),
            "*\n"
        );
        assert!(!dir.path().join(".gitignore").exists());
    }

    #[test]
    fn a_name_is_only_a_name() {
        let (_dir, cwd) = project();
        let elsewhere = tempfile::tempdir().expect("dir");
        let source = picture(elsewhere.path());
        let fs = LocalFiles::new();
        for (given, expect) in [
            ("../../etc/passwd", "passwd"),
            ("a/b/c.png", "c.png"),
            ("bad\u{1b}[2J.png", "bad_[2J.png"),
            ("..", "picture.png"),
            ("", "picture-2.png"), // `..` took picture.png
        ] {
            let saved = save_to_project(&fs, &cwd, &source, given).expect("saved");
            assert!(
                saved.path.ends_with(&format!("/attachments/{expect}")),
                "{given:?} -> {}",
                saved.path
            );
        }
    }

    #[test]
    fn old_files_go_and_new_ones_and_folders_stay() {
        let dir = tempfile::tempdir().expect("dir");
        let old = dir.path().join("old.png");
        let fresh = dir.path().join("fresh.png");
        std::fs::write(&old, b"x").expect("write");
        std::fs::write(&fresh, b"x").expect("write");
        std::fs::create_dir(dir.path().join("sub")).expect("dir");
        let long_ago = SystemTime::now() - Duration::from_secs(10 * 86_400);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .expect("open")
            .set_modified(long_ago)
            .expect("mtime");
        purge(dir.path(), Duration::from_secs(7 * 86_400));
        assert!(!old.exists() && fresh.exists() && dir.path().join("sub").is_dir());
    }
}
