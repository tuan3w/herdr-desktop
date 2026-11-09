//! The cache manager: what this app keeps on disk so a tab opens from what was seen last time and then asks only for
//! what is new.
//!
//! One place owns the layout (`<root>/v1/<machine>/<kind>/<hash of name>`), the size cap, the eviction, the
//! per-machine forgetting and the debounced saving of three kinds of entry: the board's last snapshot of a machine, a
//! keeper chat's saved lines and an observed chat's saved records. Every entry is a file of its own: a magic, the key
//! it was written for, then the payload deflated. Anything that does not read back exactly (a wrong magic, another
//! key's echo, a bad stream) is deleted and is a miss, never an error: a cache failure never fails the person's
//! action. Files are mode 0600 in 0700 directories, like `store.rs`.
//!
//! Recency is the file's modification time (`get` touches it), so it survives a restart. When the folder passes
//! `max_bytes` it is trimmed, oldest first, to `low_water`. `MediaCache` (`files/cache.rs`) is a different thing (pinned
//! copies of videos while they play) and stays apart.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// The layout version: a change that stops files reading back moves the folder (`v1` to `v2`), the old one is just
/// never read (and is removed by `clear`).
const LAYOUT: &str = "v1";

/// What a file starts with.
const MAGIC: &[u8; 4] = b"HRC\x01";

/// What a temporary file of a half-made write is called, and how old it must be before a trim removes it.
const TMP_MARK: &str = ".tmp";
const TMP_STALE: Duration = Duration::from_secs(60);

/// Which family an entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A machine's last herdr snapshot.
    Board,
    /// A keeper chat's saved lines.
    Keeper,
    /// An observed (terminal agent) chat's saved records.
    Observed,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Kind::Board => "board",
            Kind::Keeper => "keeper",
            Kind::Observed => "observed",
        }
    }
}

/// The limits of a cache.
#[derive(Debug, Clone)]
pub struct Caps {
    /// The folder may grow to this many bytes of files before a trim.
    pub max_bytes: u64,
    /// A trim stops once the folder is at most this big.
    pub low_water: u64,
    /// The largest file (deflated) that is kept.
    pub max_entry: u64,
    /// How long a `save_soon` waits, so a stream of changes is one write.
    pub debounce: Duration,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            max_bytes: 256 * 1024 * 1024,
            low_water: 192 * 1024 * 1024,
            max_entry: 8 * 1024 * 1024,
            debounce: Duration::from_secs(3),
        }
    }
}

/// Which entry: made by [`Cache::key`], which works out the file once.
#[derive(Debug, Clone)]
pub struct Key {
    machine: String,
    /// `None`: the cache is off, or the machine id is not one that can name a folder.
    path: Option<PathBuf>,
    echo: Vec<u8>,
}

impl Key {
    /// Whether this key can be stored at all (a disabled cache and an unusable machine id make none).
    pub fn usable(&self) -> bool {
        self.path.is_some()
    }
}

/// Makes the bytes of an entry when its save is due; `None` skips the write (what it would have saved is gone or no
/// longer worth keeping).
pub type Job = Box<dyn FnOnce() -> Option<Vec<u8>> + Send>;

/// What the folder holds now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub bytes: u64,
    pub entries: u64,
}

struct Slot {
    key: Key,
    due: Instant,
    job: Job,
}

struct Inner {
    /// `<root>/v1`; `None` for a cache that stores nothing.
    base: Option<PathBuf>,
    caps: Caps,
    enabled: AtomicBool,
    /// Bytes of files, as far as this run has counted them (a scan at open, then each write and removal).
    bytes: AtomicU64,
    counter: AtomicU64,
    pending: Mutex<HashMap<PathBuf, Slot>>,
    wake: Condvar,
    stop: AtomicBool,
}

/// The manager. Cheap to share: every method takes `&self`.
pub struct Cache {
    inner: Arc<Inner>,
    saver: Mutex<Option<JoinHandle<()>>>,
}

impl Cache {
    /// A cache in `<root>/v1` (made when first written).
    pub fn open(root: PathBuf, caps: Caps) -> Cache {
        let base = root.join(LAYOUT);
        let bytes = scan(&base).iter().map(|f| f.size).sum();
        Self::with(Some(base), caps, bytes)
    }

    /// A cache that reads and stores nothing: the off state, and what code that has no data folder (a test) uses.
    pub fn disabled() -> Cache {
        Self::with(None, Caps::default(), 0)
    }

    fn with(base: Option<PathBuf>, caps: Caps, bytes: u64) -> Cache {
        let on = base.is_some();
        let inner = Arc::new(Inner {
            base,
            caps,
            enabled: AtomicBool::new(on),
            bytes: AtomicU64::new(bytes),
            counter: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let saver = if on {
            let inner = inner.clone();
            std::thread::Builder::new()
                .name("herdr-cache-save".to_owned())
                .spawn(move || inner.save_loop())
                .ok()
        } else {
            None
        };
        Cache {
            inner,
            saver: Mutex::new(saver),
        }
    }

    /// Switches the cache on or off. Off, nothing is read, written or scheduled; the files stay until [`clear`](Self::clear).
    /// A cache made with [`disabled`](Self::disabled) has no folder and stays off.
    pub fn set_enabled(&self, on: bool) {
        self.inner
            .enabled
            .store(on && self.inner.base.is_some(), Ordering::Release);
        if !on {
            self.inner.pending.lock().clear();
        }
    }

    /// Whether the cache reads and writes.
    pub fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
    }

    /// The key of an entry. `name` is anything (a keeper id, a pane id, `snapshot`).
    pub fn key(&self, kind: Kind, machine: &str, name: &str) -> Key {
        let path = match (&self.inner.base, usable_machine(machine)) {
            (Some(base), true) => Some(
                base.join(machine)
                    .join(kind.dir())
                    .join(format!("{:016x}", fnv(name))),
            ),
            _ => None,
        };
        let mut echo = Vec::with_capacity(kind.dir().len() + machine.len() + name.len() + 2);
        echo.extend_from_slice(kind.dir().as_bytes());
        echo.push(0);
        echo.extend_from_slice(machine.as_bytes());
        echo.push(0);
        echo.extend_from_slice(name.as_bytes());
        Key {
            machine: machine.to_owned(),
            path,
            echo,
        }
    }

    /// The entry's payload, or `None`: absent, off, written for another key, or damaged (a damaged file is deleted).
    /// A hit becomes the most recently used.
    pub fn get(&self, key: &Key) -> Option<Vec<u8>> {
        if !self.enabled() {
            return None;
        }
        let path = key.path.as_ref()?;
        let raw = fs::read(path).ok()?;
        match decode(&raw, &key.echo) {
            Some(payload) => {
                touch(path);
                Some(payload)
            }
            None => {
                self.inner.remove_file(path);
                None
            }
        }
    }

    /// Writes the entry now: temporary file, then rename. Failures are said once on stderr and otherwise ignored.
    pub fn put(&self, key: &Key, payload: &[u8]) {
        if self.enabled() {
            self.inner.write(key, payload);
        }
    }

    /// Writes the entry `debounce` from now with what `make` gives then. A save already waiting for the key stays as it is
    /// and `make` is not called: the job reads the state when it runs, not when it was asked for.
    pub fn save_soon(&self, key: &Key, make: impl FnOnce() -> Job) {
        let Some(path) = key.path.as_ref() else {
            return;
        };
        if !self.enabled() || self.inner.pending.lock().contains_key(path) {
            return;
        }
        let job = make();
        let mut pending = self.inner.pending.lock();
        pending.entry(path.clone()).or_insert_with(|| Slot {
            key: key.clone(),
            due: Instant::now() + self.inner.caps.debounce,
            job,
        });
        drop(pending);
        self.inner.wake.notify_one();
    }

    /// Runs every waiting save now, here. For the moments the state must be on disk: a chat detached, the hub or the
    /// engine stopping.
    pub fn flush(&self) {
        let slots: Vec<Slot> = self.inner.pending.lock().drain().map(|(_, s)| s).collect();
        for slot in slots {
            self.inner.run(slot);
        }
    }

    /// Removes one entry (and its waiting save).
    pub fn forget(&self, key: &Key) {
        let Some(path) = key.path.as_ref() else {
            return;
        };
        self.inner.pending.lock().remove(path);
        self.inner.remove_file(path);
    }

    /// Removes everything kept for a machine and its waiting saves. Machine ids are handed out again after a removal, so
    /// what was kept for the old machine must never answer for a new one.
    pub fn forget_machine(&self, machine: &str) {
        self.inner
            .pending
            .lock()
            .retain(|_, slot| slot.key.machine != machine);
        if let Some(base) = &self.inner.base
            && usable_machine(machine)
        {
            let _ = fs::remove_dir_all(base.join(machine));
            self.inner.recount();
        }
    }

    /// Removes everything.
    pub fn clear(&self) {
        self.inner.pending.lock().clear();
        if let Some(base) = &self.inner.base {
            let _ = fs::remove_dir_all(base);
        }
        self.inner.bytes.store(0, Ordering::Release);
    }

    /// What the folder holds (counted now).
    pub fn usage(&self) -> Usage {
        let Some(base) = &self.inner.base else {
            return Usage::default();
        };
        let files = scan(base);
        let usage = Usage {
            bytes: files.iter().map(|f| f.size).sum(),
            entries: files.len() as u64,
        };
        self.inner.bytes.store(usage.bytes, Ordering::Release);
        usage
    }
}

impl Drop for Cache {
    fn drop(&mut self) {
        self.flush();
        self.inner.stop.store(true, Ordering::Release);
        self.inner.wake.notify_all();
        if let Some(saver) = self.saver.lock().take() {
            let _ = saver.join();
        }
    }
}

impl Inner {
    fn save_loop(&self) {
        let mut pending = self.pending.lock();
        loop {
            if self.stop.load(Ordering::Acquire) {
                return;
            }
            let now = Instant::now();
            let due: Vec<PathBuf> = pending
                .iter()
                .filter(|(_, s)| s.due <= now)
                .map(|(p, _)| p.clone())
                .collect();
            if due.is_empty() {
                match pending.values().map(|s| s.due).min() {
                    Some(next) => {
                        let _ = self.wake.wait_until(&mut pending, next);
                    }
                    None => self.wake.wait(&mut pending),
                }
                continue;
            }
            let slots: Vec<Slot> = due.iter().filter_map(|p| pending.remove(p)).collect();
            drop(pending);
            for slot in slots {
                self.run(slot);
            }
            pending = self.pending.lock();
        }
    }

    fn run(&self, slot: Slot) {
        if !self.enabled.load(Ordering::Acquire) {
            return;
        }
        if let Some(payload) = (slot.job)() {
            self.write(&slot.key, &payload);
        }
    }

    fn write(&self, key: &Key, payload: &[u8]) {
        let Some(path) = key.path.as_ref() else {
            return;
        };
        let Some(file) = encode(&key.echo, payload) else {
            return;
        };
        if file.len() as u64 > self.caps.max_entry {
            // Too big to keep; an older, smaller copy of the same entry would now be wrong.
            self.remove_file(path);
            return;
        }
        let before = fs::metadata(path).map_or(0, |m| m.len());
        if let Err(e) = self.replace(path, &file) {
            eprintln!("herdr-desktop: cannot write the cache: {e}");
            return;
        }
        let now = self.bytes.load(Ordering::Acquire);
        let after = now.saturating_sub(before) + file.len() as u64;
        self.bytes.store(after, Ordering::Release);
        if after > self.caps.max_bytes {
            self.trim(path);
        }
    }

    fn replace(&self, path: &Path, file: &[u8]) -> std::io::Result<()> {
        let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(
            "{}{TMP_MARK}{}-{n}",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("entry"),
            std::process::id()
        ));
        let written = (|| {
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            out.write_all(file)?;
            fs::rename(&tmp, path)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written
    }

    fn remove_file(&self, path: &Path) {
        if let Ok(meta) = fs::metadata(path)
            && fs::remove_file(path).is_ok()
        {
            let now = self.bytes.load(Ordering::Acquire);
            self.bytes
                .store(now.saturating_sub(meta.len()), Ordering::Release);
        }
    }

    fn recount(&self) {
        if let Some(base) = &self.base {
            self.bytes
                .store(scan(base).iter().map(|f| f.size).sum(), Ordering::Release);
        }
    }

    /// Deletes the least recently used files until the folder is at most `low_water`. `keep` (the file just written) goes
    /// last.
    fn trim(&self, keep: &Path) {
        let Some(base) = &self.base else {
            return;
        };
        let mut files = scan(base);
        let mut total: u64 = files.iter().map(|f| f.size).sum();
        files.sort_by_key(|f| (f.path == keep, f.modified));
        for file in files {
            if total <= self.caps.low_water {
                break;
            }
            // A temporary file of a write in progress is not ours to delete until it is old.
            if (file.stale_tmp() || !file.is_tmp()) && fs::remove_file(&file.path).is_ok() {
                total = total.saturating_sub(file.size);
            }
        }
        self.bytes.store(total, Ordering::Release);
    }
}

struct Found {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

impl Found {
    fn is_tmp(&self) -> bool {
        self.path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.contains(TMP_MARK))
    }

    fn stale_tmp(&self) -> bool {
        self.is_tmp() && self.modified.elapsed().is_ok_and(|age| age >= TMP_STALE)
    }
}

/// Every file of the folder (`<base>/<machine>/<kind>/<file>`), temporary files included.
fn scan(base: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let Ok(machines) = fs::read_dir(base) else {
        return out;
    };
    for machine in machines.flatten() {
        let Ok(kinds) = fs::read_dir(machine.path()) else {
            continue;
        };
        for kind in kinds.flatten() {
            let Ok(files) = fs::read_dir(kind.path()) else {
                continue;
            };
            for file in files.flatten() {
                let Ok(meta) = file.metadata() else {
                    continue;
                };
                if meta.is_file() {
                    out.push(Found {
                        path: file.path(),
                        size: meta.len(),
                        modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    });
                }
            }
        }
    }
    out
}

fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// A machine id that can name a folder: what ids are made of, never a path.
fn usable_machine(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && id.bytes().any(|b| b != b'.')
}

/// FNV-1a 64: a stable name for an entry (`std`'s hashers are not stable across versions). A collision is caught by the
/// key echo in the file.
fn fnv(name: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn encode(echo: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let echo_len = u16::try_from(echo.len()).ok()?;
    let mut out = Vec::with_capacity(MAGIC.len() + 2 + echo.len() + payload.len() / 4 + 16);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&echo_len.to_le_bytes());
    out.extend_from_slice(echo);
    let mut z = ZlibEncoder::new(out, Compression::new(6));
    z.write_all(payload).ok()?;
    z.finish().ok()
}

fn decode(raw: &[u8], echo: &[u8]) -> Option<Vec<u8>> {
    let rest = raw.strip_prefix(MAGIC.as_slice())?;
    let (len, rest) = rest.split_first_chunk::<2>()?;
    let len = usize::from(u16::from_le_bytes(*len));
    let (stored, deflated) = rest.split_at_checked(len)?;
    if stored != echo {
        return None;
    }
    let mut payload = Vec::new();
    ZlibDecoder::new(deflated).read_to_end(&mut payload).ok()?;
    Some(payload)
}

/// A header and lines as one payload: the header as a JSON line, then each line of the conversation. Lines are JSON
/// documents without newlines, so the lines need no escaping.
pub fn encode_lines<H: Serialize>(header: &H, lines: &[&str]) -> Vec<u8> {
    let mut out = serde_json::to_vec(header).unwrap_or_default();
    out.push(b'\n');
    for line in lines {
        debug_assert!(!line.contains('\n'));
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    }
    out
}

/// What [`encode_lines`] made, or `None` when the header does not read as `H` or the bytes are not text.
pub fn decode_lines<H: DeserializeOwned>(bytes: &[u8]) -> Option<(H, Vec<String>)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let (head, body) = text.split_once('\n')?;
    let header = serde_json::from_str(head).ok()?;
    let mut lines: Vec<String> = body.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    Some((header, lines))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use serde::Deserialize;

    use super::*;

    fn cache(dir: &Path, caps: Caps) -> Cache {
        Cache::open(dir.to_path_buf(), caps)
    }

    /// Bytes that do not deflate, so a file's size is about the payload's.
    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut x = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect()
    }

    fn slow() -> Caps {
        Caps {
            debounce: Duration::from_secs(3600),
            ..Caps::default()
        }
    }

    #[test]
    fn what_was_put_comes_back_and_a_miss_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), Caps::default());
        let key = c.key(Kind::Keeper, "m1", "abc");
        assert_eq!(c.get(&key), None);
        c.put(&key, b"hello hello hello");
        assert_eq!(c.get(&key).as_deref(), Some(&b"hello hello hello"[..]));
        let other = c.key(Kind::Keeper, "m1", "abd");
        assert_eq!(c.get(&other), None);
        let same_name_elsewhere = c.key(Kind::Observed, "m1", "abc");
        assert_eq!(c.get(&same_name_elsewhere), None);
    }

    #[test]
    fn a_file_written_for_another_key_is_a_miss_and_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), Caps::default());
        let a = c.key(Kind::Keeper, "m1", "a");
        let b = c.key(Kind::Keeper, "m1", "b");
        c.put(&a, b"A's conversation");
        // A name collision: B's file is A's bytes.
        let from = a.path.clone().unwrap();
        let to = b.path.clone().unwrap();
        fs::copy(&from, &to).unwrap();
        assert_eq!(c.get(&b), None, "B must not be answered with A's data");
        assert!(!to.exists());
        assert!(c.get(&a).is_some());
    }

    #[test]
    fn a_damaged_file_is_a_miss_and_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), Caps::default());
        let key = c.key(Kind::Board, "local", "snapshot");
        c.put(&key, &noise(2000, 1));
        let path = key.path.clone().unwrap();
        let mut raw = fs::read(&path).unwrap();
        raw.truncate(raw.len() - 20);
        fs::write(&path, raw).unwrap();
        assert_eq!(c.get(&key), None);
        assert!(!path.exists());
    }

    #[test]
    fn the_least_recently_used_goes_first_and_a_read_counts_as_use() {
        let dir = tempfile::tempdir().unwrap();
        let caps = Caps {
            max_bytes: 3500,
            low_water: 3200,
            max_entry: 4000,
            debounce: Duration::from_secs(3600),
        };
        let c = cache(dir.path(), caps);
        let keys: Vec<Key> = ["a", "b", "c"]
            .iter()
            .map(|n| c.key(Kind::Keeper, "m1", n))
            .collect();
        for (i, k) in keys.iter().enumerate() {
            c.put(k, &noise(1000, i as u64 + 1));
        }
        // Fixed, distinct ages: a oldest, then b, then c.
        for (i, k) in keys.iter().enumerate() {
            let file = fs::OpenOptions::new()
                .write(true)
                .open(k.path.as_ref().unwrap())
                .unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1000 + i as u64))
                .unwrap();
        }
        // Reading `a` makes it the newest; `b` is now the oldest.
        assert!(c.get(&keys[0]).is_some());
        let d = c.key(Kind::Keeper, "m1", "d");
        c.put(&d, &noise(1000, 9));
        assert!(c.get(&keys[1]).is_none(), "b was the least recently used");
        assert!(c.get(&keys[0]).is_some());
        assert!(c.get(&keys[2]).is_some());
        assert!(
            c.get(&d).is_some(),
            "the entry just written is never the one trimmed"
        );
        assert!(c.usage().bytes <= 3500);
    }

    #[test]
    fn an_entry_over_the_cap_is_not_kept_and_removes_its_older_copy() {
        let dir = tempfile::tempdir().unwrap();
        let caps = Caps {
            max_entry: 1500,
            ..Caps::default()
        };
        let c = cache(dir.path(), caps);
        let key = c.key(Kind::Keeper, "m1", "a");
        c.put(&key, &noise(500, 1));
        assert!(c.get(&key).is_some());
        c.put(&key, &noise(5000, 2));
        assert_eq!(c.get(&key), None);
    }

    #[test]
    fn forgetting_a_machine_removes_its_entries_only_and_its_waiting_saves() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), slow());
        let one = c.key(Kind::Keeper, "m1", "a");
        let two = c.key(Kind::Keeper, "m2", "a");
        c.put(&one, b"one");
        c.put(&two, b"two");
        c.save_soon(&one, || Box::new(|| Some(b"later".to_vec())));
        c.forget_machine("m1");
        c.flush();
        assert_eq!(c.get(&one), None, "a waiting save must not bring it back");
        assert_eq!(c.get(&two).as_deref(), Some(&b"two"[..]));
    }

    #[test]
    fn a_save_waits_for_flush_and_asks_for_its_bytes_once() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), slow());
        let key = c.key(Kind::Observed, "m1", "w1:p2");
        let made = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let made = made.clone();
            c.save_soon(&key, move || {
                made.fetch_add(1, Ordering::SeqCst);
                Box::new(|| Some(b"state at the time it ran".to_vec()))
            });
        }
        assert_eq!(
            made.load(Ordering::SeqCst),
            1,
            "a pending save is not asked again"
        );
        assert_eq!(c.get(&key), None, "nothing is written before it is due");
        c.flush();
        assert_eq!(
            c.get(&key).as_deref(),
            Some(&b"state at the time it ran"[..])
        );
        // A job that gives nothing writes nothing and leaves what is there.
        c.save_soon(&key, || Box::new(|| None));
        c.flush();
        assert!(c.get(&key).is_some());
    }

    #[test]
    fn a_due_save_is_written_by_the_saver_thread() {
        let dir = tempfile::tempdir().unwrap();
        let caps = Caps {
            debounce: Duration::ZERO,
            ..Caps::default()
        };
        let c = cache(dir.path(), caps);
        let key = c.key(Kind::Board, "local", "snapshot");
        c.save_soon(&key, || Box::new(|| Some(b"x".to_vec())));
        let deadline = Instant::now() + Duration::from_secs(10);
        while c.get(&key).is_none() {
            assert!(Instant::now() < deadline, "the saver never wrote it");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_disabled_cache_and_an_unusable_machine_store_nothing() {
        let off = Cache::disabled();
        let key = off.key(Kind::Keeper, "m1", "a");
        assert!(!key.usable());
        off.put(&key, b"x");
        assert_eq!(off.get(&key), None);

        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), Caps::default());
        for bad in ["", "..", "a/b", "../x", "m 1"] {
            assert!(!c.key(Kind::Keeper, bad, "a").usable(), "{bad:?}");
        }
        let key = c.key(Kind::Keeper, "m1", "a");
        c.put(&key, b"x");
        c.set_enabled(false);
        assert_eq!(c.get(&key), None, "off reads nothing");
        c.put(&key, b"y");
        c.set_enabled(true);
        assert_eq!(c.get(&key).as_deref(), Some(&b"x"[..]), "off wrote nothing");
    }

    #[test]
    fn clear_empties_it_and_usage_counts_files() {
        let dir = tempfile::tempdir().unwrap();
        let c = cache(dir.path(), Caps::default());
        c.put(&c.key(Kind::Keeper, "m1", "a"), &noise(100, 1));
        c.put(&c.key(Kind::Board, "m2", "snapshot"), &noise(100, 2));
        let usage = c.usage();
        assert_eq!(usage.entries, 2);
        assert!(usage.bytes > 200);
        c.clear();
        assert_eq!(c.usage(), Usage::default());
        // A fresh cache over the same folder starts from what is really there.
        c.put(&c.key(Kind::Keeper, "m1", "a"), &noise(100, 1));
        let again = cache(dir.path(), Caps::default());
        assert_eq!(again.usage().entries, 1);
    }

    #[test]
    fn lines_round_trip_with_their_header() {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct Header {
            v: u32,
            sid: Option<String>,
        }
        let header = Header {
            v: 1,
            sid: Some("s".into()),
        };
        let lines = [r#"{"a":1}"#, r#"{"b":"two"}"#];
        let bytes = encode_lines(&header, &lines);
        let (back, got): (Header, _) = decode_lines(&bytes).unwrap();
        assert_eq!(back, header);
        assert_eq!(got, lines);
        let (_, none): (Header, Vec<String>) = decode_lines(&encode_lines(&header, &[])).unwrap();
        assert!(none.is_empty());
        assert!(decode_lines::<Header>(b"not json\nx\n").is_none());
    }
}
