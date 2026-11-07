//! This computer's files, through `std::fs`.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::{Access, access};

use super::{
    Chunk, Entry, EntryKind, FileError, FileErrorKind, Files, LIST_MAX, Listing, READ_MAX, Stat,
    Tree, TreeLimits, part_name, validate_path, walk,
};

/// The files of the computer the app runs on.
#[derive(Debug, Clone, Default)]
pub struct LocalFiles {
    home: Option<PathBuf>,
}

impl LocalFiles {
    /// Files of this computer; `~` is the current user's home folder.
    pub fn new() -> Self {
        Self {
            home: dirs::home_dir(),
        }
    }

    /// Files of this computer with an explicit home folder (tests).
    pub fn with_home(home: impl Into<PathBuf>) -> Self {
        Self {
            home: Some(home.into()),
        }
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, FileError> {
        validate_path(path)?;
        let Some(rest) = path.strip_prefix('~') else {
            return Ok(PathBuf::from(path));
        };
        let home = self.home.as_ref().ok_or_else(|| {
            FileError::new(FileErrorKind::Other, "This computer has no home folder")
        })?;
        Ok(home.join(rest.trim_start_matches('/')))
    }
}

fn kind_of(meta: &fs::Metadata) -> EntryKind {
    if meta.is_dir() {
        EntryKind::Dir
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

fn readable(path: &Path, kind: EntryKind) -> bool {
    let wanted = if kind == EntryKind::Dir {
        Access::READ_OK | Access::EXEC_OK
    } else {
        Access::READ_OK
    };
    access(path, wanted).is_ok()
}

impl Files for LocalFiles {
    fn list(&self, dir: &str) -> Result<Listing, FileError> {
        let real = self.resolve(dir)?;
        let mut listing = Listing {
            path: real.to_string_lossy().into_owned(),
            entries: Vec::new(),
            truncated: false,
            skipped: 0,
        };
        let read = fs::read_dir(&real).map_err(|e| FileError::from_io(&e, dir))?;
        for item in read {
            if listing.entries.len() >= LIST_MAX {
                listing.truncated = true;
                break;
            }
            let Ok(item) = item else { continue };
            let Ok(name) = item.file_name().into_string() else {
                listing.skipped += 1;
                continue;
            };
            let path = item.path();
            let Ok(lstat) = fs::symlink_metadata(&path) else {
                listing.entries.push(Entry {
                    name,
                    kind: EntryKind::Other,
                    size: 0,
                    modified: None,
                    readable: false,
                    link: false,
                });
                continue;
            };
            let link = lstat.file_type().is_symlink();
            // A link that does not lead anywhere is listed as what it is: something nobody can open.
            let real_meta = if link {
                fs::metadata(&path).ok()
            } else {
                Some(lstat.clone())
            };
            let (kind, size, modified, can_read) = match &real_meta {
                Some(meta) => {
                    let kind = kind_of(meta);
                    (
                        kind,
                        if kind == EntryKind::File {
                            meta.len()
                        } else {
                            0
                        },
                        Some(meta.mtime()),
                        readable(&path, kind),
                    )
                }
                None => (EntryKind::Other, 0, Some(lstat.mtime()), false),
            };
            listing.entries.push(Entry {
                name,
                kind,
                size,
                modified,
                readable: can_read,
                link,
            });
        }
        listing.sort();
        Ok(listing)
    }

    fn stat(&self, path: &str) -> Result<Stat, FileError> {
        let real = self.resolve(path)?;
        let meta = fs::metadata(&real).map_err(|e| FileError::from_io(&e, path))?;
        let kind = kind_of(&meta);
        Ok(Stat {
            kind,
            size: if kind == EntryKind::File {
                meta.len()
            } else {
                0
            },
            modified: Some(meta.mtime()),
            readable: readable(&real, kind),
        })
    }

    fn read(&self, path: &str, start: u64, len: usize) -> Result<Chunk, FileError> {
        let real = self.resolve(path)?;
        let mut file = fs::File::open(&real).map_err(|e| FileError::from_io(&e, path))?;
        let meta = file.metadata().map_err(|e| FileError::from_io(&e, path))?;
        if meta.is_dir() {
            return Err(FileError::new(
                FileErrorKind::IsADirectory,
                format!("{path} is a folder"),
            ));
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|e| FileError::from_io(&e, path))?;
        let mut data = Vec::new();
        file.take(len.min(READ_MAX) as u64)
            .read_to_end(&mut data)
            .map_err(|e| FileError::from_io(&e, path))?;
        Ok(Chunk {
            size: meta.len(),
            modified: Some(meta.mtime()),
            data,
        })
    }

    fn put(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        let part = part_path(&self.resolve(path)?)?;
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create(true)
            // A stale part file that is a symbolic link must not be followed to somewhere else.
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
        if offset == 0 {
            options.truncate(true);
        }
        let dir = path.rsplit_once('/').map_or(path, |(dir, _)| dir);
        let mut file = options
            .open(&part)
            .map_err(|e| FileError::from_io(&e, dir))?;
        let have = file
            .metadata()
            .map_err(|e| FileError::from_io(&e, dir))?
            .len();
        if have != offset {
            return Err(FileError::new(
                FileErrorKind::Other,
                "the upload is out of order",
            ));
        }
        file.seek(SeekFrom::End(0))
            .and_then(|_| file.write_all(data))
            .map_err(|e| FileError::from_io(&e, dir))
    }

    fn mkdir(&self, path: &str) -> Result<(), FileError> {
        fs::create_dir_all(self.resolve(path)?).map_err(|e| FileError::from_io(&e, path))
    }

    fn commit(&self, path: &str, replace: bool) -> Result<(), FileError> {
        let real = self.resolve(path)?;
        let part = part_path(&real)?;
        if replace {
            return fs::rename(&part, &real).map_err(|e| FileError::from_io(&e, path));
        }
        match fs::hard_link(&part, &real) {
            Ok(()) => fs::remove_file(&part).map_err(|e| FileError::from_io(&e, path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(FileError::from_io(&e, path))
            }
            Err(_) => {
                // A file system without hard links: check, then rename (a small window remains there).
                if real.symlink_metadata().is_ok() {
                    return Err(FileError::new(
                        FileErrorKind::Exists,
                        format!("{path} already exists"),
                    ));
                }
                fs::rename(&part, &real).map_err(|e| FileError::from_io(&e, path))
            }
        }
    }

    fn discard(&self, path: &str) -> Result<(), FileError> {
        let part = part_path(&self.resolve(path)?)?;
        match fs::remove_file(&part) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(FileError::from_io(&e, path)),
        }
    }

    fn tree(&self, root: &str, limits: &TreeLimits) -> Result<Tree, FileError> {
        walk::walk_index(&self.resolve(root)?, limits)
    }

    fn tree_ignored(&self, root: &str, limits: &TreeLimits) -> Result<Tree, FileError> {
        walk::walk_ignored(&self.resolve(root)?, limits)
    }

    fn local_path(&self, path: &str) -> Option<PathBuf> {
        self.resolve(path).ok()
    }
}

/// `<folder>/.<name>.herdr-part` for the file `real` will become.
fn part_path(real: &Path) -> Result<PathBuf, FileError> {
    let name = real
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FileError::new(FileErrorKind::Invalid, "That path has no file name"))?;
    Ok(real.with_file_name(part_name(name)))
}
