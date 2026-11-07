//! The media cache: a size-capped folder on this computer holding copies of other machines' videos and sounds while they
//! are played, and the download that fills it.
//!
//! The rules, each with a test:
//!
//! - **The folder never holds more than the cap.** A download reserves its whole size before the first byte is
//!   written (finished copies count by their size, running downloads by their reservation), so two downloads
//!   together cannot pass it either. When there is no room, the least recently used copies that nobody has open go
//!   first; a file bigger than the cap, or one that cannot fit beside copies that are open, is refused with a
//!   sentence instead.
//! - **Copies that a viewer has open are never taken away** (`pin`), and a copy that was used a moment ago outlives
//!   one that was not.
//! - **A download is whole or not there**: it writes `<name>.part` and renames it when the last byte arrived; a
//!   cancel or a failure removes the part file.
//! - **Reads are 1 MB ranges** ([`CHUNK`]), so progress moves, a cancel is quick, and nothing is ever held whole in memory.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::Mutex;
use thiserror::Error;

use super::{FileError, FileErrorKind, Files, size_text, validate_path};

/// How much one range read asks for.
pub const CHUNK: usize = 1024 * 1024;

/// The cache's default cap: 1 GB.
pub const DEFAULT_CAP: u64 = 1024 * 1024 * 1024;

/// Why a download did not finish. Nothing is left behind in any case.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FetchError {
    /// The person stopped it.
    #[error("Cancelled")]
    Cancelled,
    /// The copy cannot fit under the cap, even with every copy that is not open removed.
    #[error("{0}")]
    TooBig(String),
    /// The machine failed: unreachable, no permission, the file changed while it was read.
    #[error("{0}")]
    Machine(FileError),
    /// This computer's disk refused.
    #[error("{0}")]
    Disk(String),
}

#[derive(Default)]
struct State {
    clock: u64,
    /// When each copy was last opened (a logical clock: wall time can be set backwards).
    last: HashMap<PathBuf, u64>,
    pins: HashMap<PathBuf, u32>,
    /// What running downloads will write, by their target.
    reserved: HashMap<PathBuf, u64>,
}

/// The folder and its cap. Cheap to share: every method takes `&self`.
pub struct MediaCache {
    dir: PathBuf,
    cap: AtomicU64,
    state: Mutex<State>,
}

impl MediaCache {
    /// A cache in `dir` (made when first used) holding at most `cap` bytes.
    pub fn new(dir: impl Into<PathBuf>, cap: u64) -> Self {
        Self {
            dir: dir.into(),
            cap: AtomicU64::new(cap),
            state: Mutex::new(State::default()),
        }
    }

    /// The most the folder may hold.
    pub fn cap(&self) -> u64 {
        self.cap.load(Ordering::Relaxed)
    }

    /// Changes the cap; the folder is trimmed to it at once.
    pub fn set_cap(&self, cap: u64) {
        self.cap.store(cap, Ordering::Relaxed);
        self.trim();
    }

    /// The folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The finished copies in the folder: `(path, size, modified seconds)`.
    fn copies(&self) -> Vec<(PathBuf, u64, u64)> {
        let Ok(read) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        read.filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_none_or(|x| x != "part"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                meta.is_file().then(|| {
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                        .map_or(0, |d| d.as_secs());
                    (e.path(), meta.len(), modified)
                })
            })
            .collect()
    }

    /// What the folder is charged: finished copies by size, running downloads by reservation.
    pub fn used(&self) -> u64 {
        let state = self.state.lock();
        self.copies().iter().map(|(_, s, _)| s).sum::<u64>() + state.reserved.values().sum::<u64>()
    }

    /// Removes the part files of downloads that no longer run (call once, when the app starts), then trims to the cap.
    pub fn start(&self) {
        if let Ok(read) = std::fs::read_dir(&self.dir) {
            for e in read.filter_map(|e| e.ok()) {
                if e.path().extension().is_some_and(|x| x == "part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        self.trim();
    }

    /// The name of the copy of `path` on machine `key` as it is now: the machine, the path, the size and the time
    /// name it, so a file that changed is fetched again, and the original extension stays (a player decides by it).
    pub fn target(&self, key: &str, path: &str, size: u64, modified: Option<i64>) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        (key, path, size, modified).hash(&mut hasher);
        let ext = path
            .rsplit('/')
            .next()
            .and_then(|n| n.rsplit_once('.'))
            .map(|(_, e)| e.to_ascii_lowercase())
            .filter(|e| {
                !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())
            })
            .unwrap_or_else(|| "bin".to_owned());
        self.dir.join(format!("{:016x}.{ext}", hasher.finish()))
    }

    /// Marks `copy` as used now and held by one more viewer.
    pub fn pin(&self, copy: &Path) {
        let mut state = self.state.lock();
        state.clock += 1;
        let now = state.clock;
        state.last.insert(copy.to_owned(), now);
        *state.pins.entry(copy.to_owned()).or_insert(0) += 1;
    }

    /// One viewer fewer holds `copy`; then the folder is trimmed to the cap.
    pub fn unpin(&self, copy: &Path) {
        {
            let mut state = self.state.lock();
            if let Some(n) = state.pins.get_mut(copy) {
                *n -= 1;
                if *n == 0 {
                    state.pins.remove(copy);
                }
            }
        }
        self.trim();
    }

    /// Removes least recently used copies that nobody holds until the folder has `room` bytes to spare under the cap.
    /// With `all_or_nothing` (a download asking for room) nothing is removed unless that makes the room: a download
    /// that cannot be made to fit must not cost the person their cached copies. Returns whether the room is there.
    fn make_room(&self, state: &mut State, room: u64, all_or_nothing: bool) -> bool {
        let mut copies = self.copies();
        let reserved: u64 = state.reserved.values().sum();
        let mut used = copies.iter().map(|(_, s, _)| s).sum::<u64>() + reserved;
        let cap = self.cap();
        if used + room <= cap {
            return true;
        }
        let free = |state: &State, p: &PathBuf| {
            !state.pins.contains_key(p) && !state.reserved.contains_key(p)
        };
        let evictable: u64 = copies
            .iter()
            .filter(|(p, _, _)| free(state, p))
            .map(|(_, s, _)| s)
            .sum();
        if all_or_nothing && used - evictable + room > cap {
            return false;
        }
        // Oldest use first; copies never used this session by their modified time.
        copies.sort_by_key(|(p, _, modified)| (state.last.get(p).copied().unwrap_or(0), *modified));
        for (path, size, _) in copies {
            if used + room <= cap {
                break;
            }
            if !free(state, &path) {
                continue;
            }
            if std::fs::remove_file(&path).is_ok() {
                state.last.remove(&path);
                used -= size;
            }
        }
        used + room <= cap
    }

    /// Brings the folder within the cap, least recently used first, never a copy that a viewer holds.
    pub fn trim(&self) {
        let mut state = self.state.lock();
        self.make_room(&mut state, 0, false);
    }

    /// Reserves `size` bytes for a download to `target`: makes room, or says why there is none.
    fn reserve(&self, target: &Path, size: u64) -> Result<(), FetchError> {
        if size > self.cap() {
            return Err(FetchError::TooBig(format!(
                "This file is {}. The cache for files from other machines keeps up to {}: open it on that machine instead.",
                size_text(size),
                size_text(self.cap())
            )));
        }
        let mut state = self.state.lock();
        if !self.make_room(&mut state, size, true) {
            return Err(FetchError::TooBig(format!(
                "There is no room for this {} file: the copies that are open use the rest of the {} cache. Close one and try again.",
                size_text(size),
                size_text(self.cap())
            )));
        }
        state.reserved.insert(target.to_owned(), size);
        Ok(())
    }

    fn release(&self, target: &Path) {
        self.state.lock().reserved.remove(target);
    }

    /// The finished copy at `target`, when it is there and whole: it counts as used now and held by a viewer.
    fn open_copy(&self, target: &Path, size: u64) -> Option<PathBuf> {
        let meta = std::fs::metadata(target).ok()?;
        (meta.is_file() && meta.len() == size).then(|| {
            self.pin(target);
            target.to_owned()
        })
    }
}

/// Copies `path` of a machine into the cache, in [`CHUNK`] reads, and returns the copy, held by one viewer (`unpin` it
/// when the viewer closes). A copy that is already there and whole is returned at once.
///
/// `size` and `modified` are what `stat` said: they name the copy, and a file that changed while it was read (its
/// size or time differs in a later chunk) fails the download instead of making a corrupt copy. `progress(done,
/// total)` runs after each chunk; `cancel` is checked between chunks.
#[allow(clippy::too_many_arguments)]
pub fn fetch(
    files: &dyn Files,
    cache: &MediaCache,
    key: &str,
    path: &str,
    size: u64,
    modified: Option<i64>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, FetchError> {
    validate_path(path).map_err(FetchError::Machine)?;
    let target = cache.target(key, path, size, modified);
    if let Some(copy) = cache.open_copy(&target, size) {
        progress(size, size);
        return Ok(copy);
    }
    let disk =
        |e: std::io::Error| FetchError::Disk(format!("cannot keep a copy on this computer: {e}"));
    std::fs::create_dir_all(cache.dir()).map_err(disk)?;
    cache.reserve(&target, size)?;
    let part = target.with_extension("part");
    let result = (|| {
        let mut out = std::fs::File::create(&part).map_err(disk)?;
        let mut have = 0u64;
        progress(0, size);
        while have < size {
            if cancel.load(Ordering::Relaxed) {
                return Err(FetchError::Cancelled);
            }
            let ask = (size - have).min(CHUNK as u64) as usize;
            let chunk = files.read(path, have, ask).map_err(FetchError::Machine)?;
            if chunk.size != size || (modified.is_some() && chunk.modified != modified) {
                return Err(FetchError::Machine(FileError::new(
                    FileErrorKind::Other,
                    "The file changed while it was copied. Open it again.",
                )));
            }
            if chunk.data.is_empty() {
                return Err(FetchError::Machine(FileError::new(
                    FileErrorKind::Other,
                    "The machine stopped sending the file before its end.",
                )));
            }
            // A machine may answer with less than asked; never write past what was reserved.
            let take = chunk.data.len().min((size - have) as usize);
            out.write_all(&chunk.data[..take]).map_err(disk)?;
            have += take as u64;
            progress(have, size);
        }
        out.flush().map_err(disk)?;
        std::fs::rename(&part, &target).map_err(disk)
    })();
    // The finished copy is charged by size from now, so the reservation can go.
    cache.release(&target);
    match result {
        Ok(()) => {
            cache.pin(&target);
            Ok(target)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;

    fn body(n: usize, seed: u8) -> Vec<u8> {
        (0..n).map(|i| (i as u8).wrapping_add(seed)).collect()
    }

    fn run(
        files: &Mem,
        cache: &MediaCache,
        path: &str,
        cancel: &AtomicBool,
    ) -> Result<PathBuf, FetchError> {
        let stat = files.stat(path).unwrap();
        fetch(
            files,
            cache,
            "m",
            path,
            stat.size,
            stat.modified,
            cancel,
            &mut |_, _| {},
        )
    }

    #[test]
    fn a_copy_is_the_file_read_in_one_megabyte_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path().join("media"), 8 * CHUNK as u64);
        let data = body(CHUNK * 2 + 123, 3);
        let files = Mem::with("/v.mp4", data.clone());
        let copy = run(&files, &cache, "/v.mp4", &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), data);
        assert_eq!(copy.extension().unwrap(), "mp4");
        let asks: Vec<usize> = files.reads().into_iter().map(|(_, n)| n).collect();
        assert_eq!(asks, vec![CHUNK, CHUNK, 123]);
        assert!(!copy.with_extension("part").exists());
    }

    #[test]
    fn a_second_open_of_the_same_file_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path(), 8 * CHUNK as u64);
        let files = Mem::with("/a.mp3", body(1000, 1));
        let first = run(&files, &cache, "/a.mp3", &AtomicBool::new(false)).unwrap();
        let reads = files.reads().len();
        let second = run(&files, &cache, "/a.mp3", &AtomicBool::new(false)).unwrap();
        assert_eq!(first, second);
        assert_eq!(files.reads().len(), reads);
    }

    #[test]
    fn a_cancel_leaves_nothing_and_stops_reading() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path(), 16 * CHUNK as u64);
        let files = Mem::with("/v.mkv", body(CHUNK * 6, 9));
        let cancel = AtomicBool::new(false);
        let stat = files.stat("/v.mkv").unwrap();
        let mut seen = Vec::new();
        let out = fetch(
            &files,
            &cache,
            "m",
            "/v.mkv",
            stat.size,
            stat.modified,
            &cancel,
            &mut |done, total| {
                seen.push((done, total));
                if done >= 2 * CHUNK as u64 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert_eq!(out, Err(FetchError::Cancelled));
        assert_eq!(files.reads().len(), 2, "no read after the cancel");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(cache.used(), 0, "the reservation went with it");
        assert_eq!(seen.last().unwrap().1, 6 * CHUNK as u64);
    }

    #[test]
    fn the_folder_never_passes_its_cap_whatever_is_fetched_in_whatever_order() {
        let dir = tempfile::tempdir().unwrap();
        let cap = 5 * CHUNK as u64;
        let cache = MediaCache::new(dir.path(), cap);
        let files = Mem::default();
        let sizes = [2, 1, 3, 2, 4, 1, 1, 5, 2, 3, 1, 4];
        for (i, mb) in sizes.iter().enumerate() {
            files.set(&format!("/f{i}.mp4"), body(mb * CHUNK - 7, i as u8));
        }
        let mut worst = 0u64;
        for (i, _) in sizes.iter().enumerate() {
            let path = format!("/f{i}.mp4");
            let stat = files.stat(&path).unwrap();
            let copy = fetch(
                &files,
                &cache,
                "m",
                &path,
                stat.size,
                stat.modified,
                &AtomicBool::new(false),
                &mut |_, _| {
                    let held: u64 = std::fs::read_dir(dir.path())
                        .unwrap()
                        .map(|e| e.unwrap().metadata().unwrap().len())
                        .sum();
                    worst = worst.max(held);
                },
            )
            .unwrap();
            // The viewer closes after each file: its copy stays as a cache, within the cap.
            cache.unpin(&copy);
            assert!(cache.used() <= cap, "after {path}: {}", cache.used());
        }
        assert!(worst <= cap, "the bytes on disk peaked at {worst}");
    }

    #[test]
    fn the_least_recently_used_copy_goes_first_and_an_open_one_never_does() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path(), 3 * CHUNK as u64);
        let files = Mem::default();
        for name in ["a", "b", "c", "d"] {
            files.set(&format!("/{name}.mp4"), body(CHUNK, 1));
        }
        let cancel = AtomicBool::new(false);
        let a = run(&files, &cache, "/a.mp4", &cancel).unwrap();
        let b = run(&files, &cache, "/b.mp4", &cancel).unwrap();
        let c = run(&files, &cache, "/c.mp4", &cancel).unwrap();
        cache.unpin(&b);
        cache.unpin(&c);
        // b is used again after c: of the two copies nobody holds, c was used longest ago.
        let b_again = run(&files, &cache, "/b.mp4", &cancel).unwrap();
        cache.unpin(&b_again);
        // a is open. d needs room: c goes, not b (created earlier) and never a.
        let d = run(&files, &cache, "/d.mp4", &cancel).unwrap();
        assert!(a.exists() && b.exists() && d.exists());
        assert!(!c.exists());
        // Two megabytes cannot fit beside the open a and d even with b gone: refused, and b is not removed in vain.
        files.set("/e.mp4", body(2 * CHUNK, 1));
        let refused = run(&files, &cache, "/e.mp4", &cancel).unwrap_err();
        assert!(matches!(refused, FetchError::TooBig(_)), "{refused:?}");
        assert!(b.exists(), "nothing was removed to try");
        // One megabyte fits once b goes.
        files.set("/f.mp4", body(CHUNK, 1));
        let f = run(&files, &cache, "/f.mp4", &cancel).unwrap();
        assert!(!b.exists() && a.exists() && d.exists() && f.exists());
        // Everything open: nothing fits.
        files.set("/g.mp4", body(CHUNK, 1));
        let refused = run(&files, &cache, "/g.mp4", &cancel).unwrap_err();
        assert!(matches!(refused, FetchError::TooBig(_)), "{refused:?}");
        assert!(a.exists() && d.exists() && f.exists());
    }

    #[test]
    fn a_file_over_the_cap_is_refused_with_both_sizes_and_nothing_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path(), 2 * CHUNK as u64);
        let files = Mem::with("/big.mp4", body(3 * CHUNK, 1));
        let err = run(&files, &cache, "/big.mp4", &AtomicBool::new(false)).unwrap_err();
        let FetchError::TooBig(message) = err else {
            panic!("expected TooBig")
        };
        assert!(
            message.contains("3.0 MB") && message.contains("2.0 MB"),
            "{message}"
        );
        assert!(files.reads().is_empty());
    }

    #[test]
    fn a_file_that_changes_mid_read_is_an_error_not_a_corrupt_copy() {
        struct Changing(Mem);
        impl Files for Changing {
            fn list(&self, d: &str) -> Result<crate::files::Listing, FileError> {
                self.0.list(d)
            }
            fn stat(&self, p: &str) -> Result<crate::files::Stat, FileError> {
                self.0.stat(p)
            }
            fn read(&self, p: &str, s: u64, l: usize) -> Result<crate::files::Chunk, FileError> {
                let mut chunk = self.0.read(p, s, l)?;
                if s > 0 {
                    chunk.modified = Some(1);
                }
                Ok(chunk)
            }
            fn put(&self, p: &str, o: u64, d: &[u8]) -> Result<(), FileError> {
                self.0.put(p, o, d)
            }
            fn commit(&self, p: &str, r: bool) -> Result<(), FileError> {
                self.0.commit(p, r)
            }
            fn discard(&self, p: &str) -> Result<(), FileError> {
                self.0.discard(p)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(dir.path(), 8 * CHUNK as u64);
        let files = Changing(Mem::with("/v.mp4", body(CHUNK * 2, 1)));
        let stat = files.stat("/v.mp4").unwrap();
        let err = fetch(
            &files,
            &cache,
            "m",
            "/v.mp4",
            stat.size,
            stat.modified,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(err.to_string().contains("changed"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn start_removes_leftover_part_files_and_trims() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.mp4.part"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.path().join("old.mp4"), vec![0u8; 3 * CHUNK]).unwrap();
        let cache = MediaCache::new(dir.path(), 2 * CHUNK as u64);
        cache.start();
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
    }
}
