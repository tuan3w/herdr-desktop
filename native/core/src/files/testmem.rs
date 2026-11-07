//! An in-memory machine for the unit tests of the readers (media probe, cache, archive, lines): files by path, every read
//! logged, so a test can say that a reader never asked for more than it should.

use std::collections::BTreeMap;

use parking_lot::Mutex;

use super::{Chunk, EntryKind, FileError, FileErrorKind, Files, Listing, Stat};

/// Files held in memory. `read` honours the range and the ask like a real machine, and is logged as `(start, len asked)`.
#[derive(Default)]
pub struct Mem {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    log: Mutex<Vec<(u64, usize)>>,
    /// Bytes the machine returns at most per read (a remote's cap); 0 means as asked.
    pub cap: usize,
}

impl Mem {
    pub fn with(path: &str, body: Vec<u8>) -> Self {
        let mem = Self::default();
        mem.set(path, body);
        mem
    }

    pub fn set(&self, path: &str, body: Vec<u8>) {
        self.files.lock().insert(path.to_owned(), body);
    }

    /// Every read so far: where it started and how much it asked.
    pub fn reads(&self) -> Vec<(u64, usize)> {
        self.log.lock().clone()
    }
}

fn missing(path: &str) -> FileError {
    FileError::new(FileErrorKind::NotFound, format!("{path} does not exist"))
}

impl Files for Mem {
    fn list(&self, dir: &str) -> Result<Listing, FileError> {
        Err(FileError::new(FileErrorKind::NotADirectory, dir))
    }

    fn stat(&self, path: &str) -> Result<Stat, FileError> {
        let files = self.files.lock();
        let body = files.get(path).ok_or_else(|| missing(path))?;
        Ok(Stat {
            kind: EntryKind::File,
            size: body.len() as u64,
            modified: Some(1_700_000_000),
            readable: true,
        })
    }

    fn read(&self, path: &str, start: u64, len: usize) -> Result<Chunk, FileError> {
        self.log.lock().push((start, len));
        let files = self.files.lock();
        let body = files.get(path).ok_or_else(|| missing(path))?;
        let from = usize::try_from(start).unwrap_or(usize::MAX).min(body.len());
        let ask = if self.cap > 0 { len.min(self.cap) } else { len };
        let to = from.saturating_add(ask).min(body.len());
        Ok(Chunk {
            size: body.len() as u64,
            modified: Some(1_700_000_000),
            data: body[from..to].to_vec(),
        })
    }

    fn put(&self, path: &str, _offset: u64, _data: &[u8]) -> Result<(), FileError> {
        Err(FileError::new(FileErrorKind::Other, path))
    }

    fn commit(&self, path: &str, _replace: bool) -> Result<(), FileError> {
        Err(FileError::new(FileErrorKind::Other, path))
    }

    fn discard(&self, _path: &str) -> Result<(), FileError> {
        Ok(())
    }
}
