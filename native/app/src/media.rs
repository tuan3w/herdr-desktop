//! `Media` and `Lines`: what the video and audio player, the archive and binary viewers and the big-text viewer call.
//!
//! The work is `herdr_core::files`; this file is the door TSX uses. Everything that touches a machine is `async` and
//! runs on the runtime's blocking threads, or on a thread of its own (a copy and a line scan run for as long as they
//! take, and are read back with `fetches()` and `state()` after `onFetchChange` says something moved: a tick carries no
//! data, like the rest of the app).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use herdr_core::files::{self, FetchError, Files as MachineFiles, LineIndex};
use nsh_core::prelude::*;
use parking_lot::Mutex;

use crate::api::engine;
use crate::fixture::{TEST_FLAG, test_seam_open};

/// How often a copy tells the screens it moved (its last piece and its end always do).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// How a copy of a file for the player is going.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum FetchStateName {
    /// Pieces are being copied.
    Running,
    /// The file is ready to play at `local`.
    Ready,
    /// It stopped: see `message`. Nothing is left behind.
    Failed,
    /// The person stopped it. Nothing is left behind.
    Cancelled,
}

/// A file being made ready for the player: this computer's is ready at once, another machine's is copied.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct FetchView {
    /// Names the copy to `cancelFetch` and `releaseFetch`.
    pub id: u32,
    /// How it is going.
    pub state: FetchStateName,
    /// Bytes copied so far.
    pub done: f64,
    /// Bytes in the file.
    pub total: f64,
    /// Where the file can be played on THIS computer (the file itself when it is here, the cached copy otherwise).
    #[prop(skip_none)]
    pub local: Option<String>,
    /// Whether `local` is a copy in the cache (another machine's file), not the file itself.
    pub copied: bool,
    /// Why it failed (`failed` only), in words for the person.
    #[prop(skip_none)]
    pub message: Option<String>,
    /// Whether it failed because the file is too big for the cache.
    pub too_big: bool,
}

struct Fetch {
    view: FetchView,
    cancel: Arc<AtomicBool>,
    /// The copy held in the cache, to let go of when the viewer closes.
    held: Option<PathBuf>,
}

struct Fetches {
    list: Mutex<Vec<Fetch>>,
    next: AtomicU32,
    listeners: Mutex<Vec<(u32, async_channel::Sender<()>)>>,
}

/// The test seam's switches: copy this computer's files like another machine's, and how long each progress report waits.
static FORCE_COPY: AtomicBool = AtomicBool::new(false);
static COPY_DELAY_MS: AtomicU32 = AtomicU32::new(0);

static FETCHES: Fetches = Fetches {
    list: Mutex::new(Vec::new()),
    next: AtomicU32::new(1),
    listeners: Mutex::new(Vec::new()),
};

impl Fetches {
    /// Wakes every listener; never blocks (a full channel already has a wake-up waiting).
    fn wake(&self) {
        self.listeners
            .lock()
            .retain(|(_, tx)| match tx.try_send(()) {
                Ok(()) | Err(async_channel::TrySendError::Full(())) => true,
                Err(async_channel::TrySendError::Closed(())) => false,
            });
    }

    /// Changes fetch `id` if it is still listed; `false` when the viewer already let it go.
    fn update(&self, id: u32, change: impl FnOnce(&mut Fetch)) -> bool {
        let found = {
            let mut list = self.list.lock();
            list.iter_mut()
                .find(|f| f.view.id == id)
                .map(change)
                .is_some()
        };
        self.wake();
        found
    }
}

fn number(v: u64) -> f64 {
    v as f64
}

/// Runs `work` on a blocking thread and settles with its result.
async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(work)
        .await
        .map_err(|e| format!("the task stopped: {e}"))?
}

/// What the headers of a media file say it holds.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct CodecsView {
    /// The container (`MP4`, `WebM`), when recognised.
    #[prop(skip_none)]
    pub container: Option<String>,
    /// The video codec (`H.265`), when recognised.
    #[prop(skip_none)]
    pub video: Option<String>,
    /// The audio codec (`AAC`), when recognised.
    #[prop(skip_none)]
    pub audio: Option<String>,
    /// `H.265 video and AAC audio`, or nothing when no codec was recognised.
    #[prop(skip_none)]
    pub summary: Option<String>,
}

/// The start of a file that is not text.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct BytesPeek {
    /// The file's size in bytes.
    pub size: f64,
    /// What its first bytes say it is (`ELF executable`), when recognised.
    #[prop(skip_none)]
    pub detected: Option<String>,
    /// The hex dump of the first 4 KB, a row per 16 bytes.
    pub rows: Vec<String>,
    /// How many bytes the dump shows.
    pub shown: f64,
}

/// One entry of an archive.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ArchiveEntryView {
    /// The path inside the archive.
    pub name: String,
    /// Bytes when unpacked (0 for a folder).
    pub size: f64,
    /// Whether it is a folder.
    pub dir: bool,
}

/// What is inside an archive.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ArchiveView {
    /// `zip`, `tar`, `tar.gz` or `gzip`.
    pub format: String,
    /// The entries, at most 5000.
    pub entries: Vec<ArchiveEntryView>,
    /// There are more than the list holds.
    pub truncated: bool,
}

/// How full the media cache is.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct CacheView {
    /// Bytes the folder holds (running copies counted by their size).
    pub used: f64,
    /// The most it may hold.
    pub cap: f64,
    /// The folder.
    pub dir: String,
}

/// Videos, sounds and the other viewers' reads of a file: made ready to play (copied into a size-capped cache when the
/// file is on another machine), named by their codecs when the system cannot play them, listed, or peeked at. A failure
/// throws with the words to show.
#[module]
pub struct Media;

#[module]
impl Media {
    /// Starts making `path` of a machine ready for the player and returns the copy's id at once. A file on this
    /// computer is ready where it is (nothing is copied); another machine's is copied into the cache in 1 MB ranges
    /// (progress is `fetches()`), and refused when it is bigger than the cache's cap. Release it with `releaseFetch`
    /// when the viewer closes.
    pub async fn fetch(machine: String, path: String) -> Result<u32, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            files::validate_path(&path).map_err(|e| e.message)?;
            let stat = files.stat(&path).map_err(|e| e.message)?;
            if stat.kind != files::EntryKind::File {
                return Err(format!("{path} is not a regular file"));
            }
            if !stat.readable {
                return Err(format!("no permission to read {path}"));
            }
            let id = FETCHES.next.fetch_add(1, Ordering::Relaxed);
            let cancel = Arc::new(AtomicBool::new(false));
            let mut view = FetchView {
                id,
                state: FetchStateName::Running,
                done: 0.0,
                total: number(stat.size),
                local: None,
                copied: false,
                message: None,
                too_big: false,
            };
            if !FORCE_COPY.load(Ordering::Relaxed)
                && let Some(local) = files.local_path(&path)
            {
                view.state = FetchStateName::Ready;
                view.done = view.total;
                view.local = Some(local.to_string_lossy().into_owned());
                FETCHES.list.lock().push(Fetch {
                    view,
                    cancel,
                    held: None,
                });
                FETCHES.wake();
                return Ok(id);
            }
            view.copied = true;
            FETCHES.list.lock().push(Fetch {
                view,
                cancel: cancel.clone(),
                held: None,
            });
            FETCHES.wake();
            std::thread::Builder::new()
                .name(format!("herdr-media-{id}"))
                .spawn(move || copy(id, &engine, files, &machine, &path, stat, &cancel))
                .map_err(|e| format!("cannot start the copy: {e}"))?;
            Ok(id)
        })
        .await
    }

    /// Opens a ready file (the file itself, or its copy in the cache) with the application the system chooses for it:
    /// what `Open in the system player` does for a file of another machine. Throws when the copy is not ready.
    pub async fn open_fetched(id: u32) -> Result<(), String> {
        let local = FETCHES
            .list
            .lock()
            .iter()
            .find(|f| f.view.id == id)
            .and_then(|f| f.view.local.clone())
            .ok_or_else(|| "The file is not ready yet".to_owned())?;
        open_path(PathBuf::from(local)).await
    }

    /// Stops a running copy; nothing is left behind.
    pub fn cancel_fetch(id: u32) {
        if let Some(f) = FETCHES.list.lock().iter().find(|f| f.view.id == id) {
            f.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Lets go of a copy when its viewer closes: stops it if it runs, lets the cache take its file away when it needs
    /// the room, and forgets the entry. Safe to call twice.
    pub fn release_fetch(id: u32) {
        let removed = {
            let mut list = FETCHES.list.lock();
            list.iter()
                .position(|f| f.view.id == id)
                .map(|at| list.remove(at))
        };
        if let Ok(server) = SERVER.as_ref() {
            server.tokens.lock().retain(|_, served| served.fetch != id);
        }
        if let Some(fetch) = removed {
            fetch.cancel.store(true, Ordering::Relaxed);
            if let (Some(held), Ok(engine)) = (fetch.held, engine()) {
                engine.media_cache().unpin(&held);
            }
        }
        FETCHES.wake();
    }

    /// The state of every copy that is not released, oldest first.
    pub fn fetches() -> Vec<FetchView> {
        FETCHES.list.lock().iter().map(|f| f.view.clone()).collect()
    }

    /// Calls `listener` when a copy moved or ended (at most every 100 ms while one runs); the call carries a counter,
    /// not data: read `fetches()`. Returns the function that stops listening.
    pub fn on_fetch_change(#[args(tick)] listener: Callback<u64>, cx: CallCx<'_>) -> Stop {
        let (tx, rx) = async_channel::bounded(1);
        let id = FETCHES.next.fetch_add(1, Ordering::Relaxed);
        FETCHES.listeners.lock().push((id, tx));
        cx.start(async move {
            let mut tick = 0u64;
            while rx.recv().await.is_ok() {
                tick += 1;
                listener.post(tick);
            }
        });
        Stop::new(move || FETCHES.listeners.lock().retain(|(i, _)| *i != id))
    }

    /// Where a ready PDF is shown from: a loopback address (`http://127.0.0.1:<port>/f/<token>/<name>`, this computer only)
    /// that serves exactly that file, with ranges, to the web view that draws it. The token is random and lives as long as
    /// the copy: `releaseFetch` ends it. Throws for a file that is not ready or not a PDF.
    pub fn serve(id: u32) -> Result<String, String> {
        let path = {
            let list = FETCHES.list.lock();
            let local = list
                .iter()
                .find(|f| f.view.id == id)
                .and_then(|f| f.view.local.clone())
                .ok_or_else(|| "The file is not ready yet".to_owned())?;
            PathBuf::from(local)
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !name.to_ascii_lowercase().ends_with(".pdf") {
            return Err("Only PDF files are shown this way".to_owned());
        }
        // The name is only a label for the viewer's title: encoded so any file name is a valid path segment.
        let segment: String = name
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => {
                    (b as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect();
        let server = SERVER.as_ref().map_err(Clone::clone)?;
        let token = new_token()?;
        server
            .tokens
            .lock()
            .insert(token.clone(), Served { path, fetch: id });
        Ok(format!("{}/f/{token}/{segment}", server.origin))
    }

    /// What the headers of a video or sound file say it holds, for the sentence that names why it cannot play
    /// (`This computer cannot play H.265 video`). Reads a few ranges, never the file.
    pub async fn probe(machine: String, path: String) -> Result<CodecsView, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let codecs = files::probe_codecs(files.as_ref(), &path).map_err(|e| e.message)?;
            Ok(CodecsView {
                summary: codecs.describe(),
                container: codecs.container,
                video: codecs.video,
                audio: codecs.audio,
            })
        })
        .await
    }

    /// The first 4 KB of a file as a hex dump, its size and the type its bytes announce: what a file that is not
    /// text shows.
    pub async fn peek(machine: String, path: String) -> Result<BytesPeek, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let peek = files::peek(files.as_ref(), &path).map_err(|e| e.message)?;
            Ok(BytesPeek {
                size: number(peek.size),
                detected: peek.detected,
                rows: peek.rows,
                shown: peek.shown as f64,
            })
        })
        .await
    }

    /// What is inside a zip, tar, tar.gz or gzip file (names and sizes, at most 5000 entries) without unpacking it.
    /// Throws a sentence for a format that cannot be listed.
    pub async fn archive(machine: String, path: String) -> Result<ArchiveView, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let listing = files::list_archive(files.as_ref(), &path).map_err(|e| e.message)?;
            Ok(ArchiveView {
                format: listing.format.to_owned(),
                entries: listing
                    .entries
                    .into_iter()
                    .map(|e| ArchiveEntryView {
                        name: e.name,
                        size: number(e.size),
                        dir: e.dir,
                    })
                    .collect(),
                truncated: listing.truncated,
            })
        })
        .await
    }

    /// A picture as a base64 `data:` address, for `Clipboard.writeImage` (the clipboard takes no file path). Throws for a
    /// picture of a kind the clipboard cannot hold or over 24 MB.
    pub async fn image_data_url(machine: String, path: String) -> Result<String, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            files::image_data_url(files.as_ref(), &path).map_err(|e| e.message)
        })
        .await
    }

    /// `text` laid out as indented JSON, or `undefined` when it is not JSON: a minified document made readable, with
    /// every value as written.
    pub fn format_json(text: String) -> Option<String> {
        files::pretty_json(&text)
    }

    /// How full the cache of copies is.
    pub fn cache() -> Result<CacheView, String> {
        let cache = engine()?.media_cache();
        Ok(CacheView {
            used: number(cache.used()),
            cap: number(cache.cap()),
            dir: cache.dir().to_string_lossy().into_owned(),
        })
    }

    /// Test seam: with `force`, `fetch` copies this computer's files into the cache like another machine's, and each
    /// progress report waits `delay_ms` first, so a test can watch a copy run and stop it. Throws unless
    /// `HERDR_DESKTOP_TEST=1`.
    pub fn test_slow_copies(force: bool, delay_ms: u32) -> Result<(), String> {
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        FORCE_COPY.store(force, Ordering::Relaxed);
        COPY_DELAY_MS.store(delay_ms, Ordering::Relaxed);
        Ok(())
    }

    /// Test seam: writes `lines` lines of a synthetic log (`000123 hay hay hay`, with `NEEDLE` on line 45679) to the data
    /// directory and returns its path: a text file over 4 MB for the big-text viewer. Throws unless `HERDR_DESKTOP_TEST=1`.
    pub fn test_big_log(lines: u32) -> Result<String, String> {
        use std::io::Write;
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        let dir = engine()?.test_tree_dir().with_file_name("test-big");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("big.log");
        let mut out =
            std::io::BufWriter::new(std::fs::File::create(&path).map_err(|e| e.to_string())?);
        for i in 0..lines {
            let tail = if i == 45_678 {
                "the NEEDLE is here"
            } else {
                "hay hay hay hay hay hay hay hay hay hay hay hay hay hay hay hay"
            };
            writeln!(out, "{i:07} {tail}").map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())?;
        path.into_os_string()
            .into_string()
            .map_err(|_| "the data directory is not text".to_owned())
    }

    /// Test seam: a sparse file `huge.png` one byte over what the viewer hands to the window (no bytes are written) and
    /// its path, for the too-large message. Throws unless `HERDR_DESKTOP_TEST=1`.
    pub fn test_big_picture() -> Result<String, String> {
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        let dir = engine()?.test_tree_dir().with_file_name("test-big");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("huge.png");
        std::fs::File::create(&path)
            .and_then(|f| f.set_len(files::PICTURE_DATA_CAP + 1))
            .map_err(|e| e.to_string())?;
        path.into_os_string()
            .into_string()
            .map_err(|_| "the data directory is not text".to_owned())
    }

    /// Test seam: the most the cache may hold, in bytes. Throws unless `HERDR_DESKTOP_TEST=1`.
    pub fn test_cap(bytes: f64) -> Result<(), String> {
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        engine()?.media_cache().set_cap(bytes as u64);
        Ok(())
    }
}

/// The copy thread: runs the download, records the end.
fn copy(
    id: u32,
    engine: &Arc<crate::engine::Engine>,
    files: Arc<dyn MachineFiles>,
    machine: &str,
    path: &str,
    stat: files::Stat,
    cancel: &AtomicBool,
) {
    let cache = engine.media_cache();
    let mut last = Instant::now();
    let mut progress = |done: u64, total: u64| {
        let delay = COPY_DELAY_MS.load(Ordering::Relaxed);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(u64::from(delay)));
        }
        if last.elapsed() >= PROGRESS_EVERY || done == total {
            last = Instant::now();
            FETCHES.update(id, |f| {
                f.view.done = number(done);
                f.view.total = number(total);
            });
        }
    };
    let outcome = files::fetch(
        files.as_ref(),
        &cache,
        machine,
        path,
        stat.size,
        stat.modified,
        cancel,
        &mut progress,
    );
    match outcome {
        Ok(copy) => {
            let local = copy.to_string_lossy().into_owned();
            let kept = FETCHES.update(id, |f| {
                f.held = Some(copy.clone());
                f.view.state = FetchStateName::Ready;
                f.view.done = f.view.total;
                f.view.local = Some(local);
            });
            // The viewer closed while the last piece arrived: nobody holds this copy.
            if !kept {
                cache.unpin(&copy);
            }
        }
        Err(e) => {
            FETCHES.update(id, |f| match &e {
                FetchError::Cancelled => f.view.state = FetchStateName::Cancelled,
                other => {
                    f.view.state = FetchStateName::Failed;
                    f.view.too_big = matches!(other, FetchError::TooBig(_));
                    f.view.message = Some(other.to_string());
                }
            });
        }
    }
}

// ---- Served: a ready PDF, to the web view that shows it --------------------------------------------------------

/// What a token opens: a ready file, and the copy it belongs to (released together).
struct Served {
    path: PathBuf,
    fetch: u32,
}

struct Server {
    origin: String,
    tokens: Mutex<std::collections::HashMap<String, Served>>,
}

static SERVER: LazyLock<Result<Arc<Server>, String>> = LazyLock::new(start_server);

/// 16 random bytes as hex, from the system's source: a token is the only thing that opens a file, so it is not guessed.
fn new_token() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("cannot make a token for the file: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `bytes=a-b` of a Range header against a file of `len` bytes: the first and last byte to send, or `None` for a range
/// that cannot be met (an `Err` of `()` means "416").
fn byte_range(header: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (from, to) = spec.split_once('-')?;
    if len == 0 {
        return Some(Err(()));
    }
    let (first, last) = match (from.trim().parse::<u64>(), to.trim().parse::<u64>()) {
        (Ok(f), Ok(t)) => (f, t.min(len - 1)),
        (Ok(f), Err(_)) if to.trim().is_empty() => (f, len - 1),
        // `bytes=-N`: the last N bytes.
        (Err(_), Ok(n)) if from.trim().is_empty() => (len.saturating_sub(n), len - 1),
        _ => return Some(Err(())),
    };
    Some(if first > last || first >= len {
        Err(())
    } else {
        Ok((first, last))
    })
}

fn serve_file(server: &Server, mut stream: std::net::TcpStream) {
    use std::io::{Read, Seek, SeekFrom, Write};
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let mut buf = vec![0u8; 8192];
    let mut have = 0;
    while have < buf.len() && !buf[..have].windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf[have..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => have += n,
        }
    }
    let text = String::from_utf8_lossy(&buf[..have]).into_owned();
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("");
    let range = lines.find_map(|l| {
        l.split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case("range"))
            .map(|(_, v)| v.to_owned())
    });
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let refuse = |stream: &mut std::net::TcpStream, status: &str| {
        let _ = stream.write_all(
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        );
    };
    if method != "GET" && method != "HEAD" {
        return refuse(&mut stream, "405 Method Not Allowed");
    }
    // `/f/<token>/<name>`: nothing else is served.
    let token = target
        .strip_prefix("/f/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    let path = server.tokens.lock().get(token).map(|s| s.path.clone());
    let Some(path) = path else {
        return refuse(&mut stream, "404 Not Found");
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return refuse(&mut stream, "404 Not Found");
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return refuse(&mut stream, "404 Not Found");
    };
    let (status, first_byte, last_byte) = match range.as_deref().and_then(|r| byte_range(r, len)) {
        Some(Ok((a, b))) => ("206 Partial Content", a, b),
        Some(Err(())) => {
            let _ = stream.write_all(
                format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
            );
            return;
        }
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let size = if len == 0 {
        0
    } else {
        last_byte - first_byte + 1
    };
    let content_range = if status.starts_with("206") {
        format!("Content-Range: bytes {first_byte}-{last_byte}/{len}\r\n")
    } else {
        String::new()
    };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/pdf\r\nContent-Length: {size}\r\n{content_range}Accept-Ranges: bytes\r\nContent-Disposition: inline\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() || method == "HEAD" || size == 0 {
        return;
    }
    if file.seek(SeekFrom::Start(first_byte)).is_err() {
        return;
    }
    // Never the file whole: 64 KB at a time.
    let mut left = size;
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = chunk.len().min(left as usize);
        match file.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
                left -= n as u64;
            }
        }
    }
}

fn start_server() -> Result<Arc<Server>, String> {
    use std::net::{Ipv4Addr, SocketAddr, TcpListener};
    let fail = |e: std::io::Error| format!("cannot serve the file to the viewer: {e}");
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).map_err(fail)?;
    let port = listener.local_addr().map_err(fail)?.port();
    let server = Arc::new(Server {
        origin: format!("http://127.0.0.1:{port}"),
        tokens: Mutex::new(std::collections::HashMap::new()),
    });
    let serving = server.clone();
    std::thread::Builder::new()
        .name("herdr-served".to_owned())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = serving.clone();
                // One short-lived thread per connection: a client that stalls holds only its own.
                let _ = std::thread::Builder::new()
                    .name("herdr-served-conn".to_owned())
                    .spawn(move || serve_file(&server, stream));
            }
        })
        .map_err(fail)?;
    Ok(server)
}

// ---- Lines: a big text file read a page at a time ---------------------------------------------------------

/// The state of a big text file's line index.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct LinesView {
    /// Names the file to `read`, `find` and `close`.
    pub id: u32,
    /// The file's size in bytes.
    pub size: f64,
    /// Lines counted so far: it grows while `done` is false.
    pub lines: f64,
    /// The count is final.
    pub done: bool,
    /// How much of the file the count has covered, 0 to 1.
    pub scanned: f64,
    /// Why the count stopped early (the machine went away), when it did.
    #[prop(skip_none)]
    pub message: Option<String>,
}

struct OpenLines {
    files: Arc<dyn MachineFiles>,
    path: String,
    index: Arc<Mutex<LineIndex>>,
    cancel: Arc<AtomicBool>,
    /// The search that is running; a new one stops it.
    search: Mutex<Arc<AtomicBool>>,
    failure: Arc<Mutex<Option<String>>>,
}

static OPEN_LINES: LazyLock<Mutex<std::collections::HashMap<u32, Arc<OpenLines>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static NEXT_LINES: AtomicU32 = AtomicU32::new(1);

fn open_lines(id: u32) -> Result<Arc<OpenLines>, String> {
    OPEN_LINES
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| "The file was closed".to_owned())
}

fn lines_view(id: u32, open: &OpenLines) -> LinesView {
    let index = open.index.lock();
    LinesView {
        id,
        size: number(index.size),
        lines: number(index.lines),
        done: index.done,
        scanned: if index.size == 0 {
            1.0
        } else {
            number(index.scanned) / number(index.size)
        },
        message: open.failure.lock().clone(),
    }
}

/// A big text file (over 4 MB) read by lines: a sparse index built by one pass in the background, pages read from the
/// nearest checkpoint, a search that streams in 1 MB ranges. Nothing holds the file.
#[module]
pub struct Lines;

#[module]
impl Lines {
    /// Opens `path` of a machine for paging and starts counting its lines on a thread of its own; resolves with the
    /// first state (poll `state` while `done` is false).
    pub async fn open(machine: String, path: String) -> Result<LinesView, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let size = files::lines_size(files.as_ref(), &path).map_err(|e| e.message)?;
            let id = NEXT_LINES.fetch_add(1, Ordering::Relaxed);
            let open = Arc::new(OpenLines {
                files,
                path,
                index: Arc::new(Mutex::new(LineIndex::new(size))),
                cancel: Arc::new(AtomicBool::new(false)),
                search: Mutex::new(Arc::new(AtomicBool::new(false))),
                failure: Arc::new(Mutex::new(None)),
            });
            OPEN_LINES.lock().insert(id, open.clone());
            let scanner = open.clone();
            std::thread::Builder::new()
                .name(format!("herdr-lines-{id}"))
                .spawn(move || {
                    if let Err(e) = files::scan_lines(
                        scanner.files.as_ref(),
                        &scanner.path,
                        &scanner.index,
                        &scanner.cancel,
                    ) {
                        *scanner.failure.lock() = Some(e.message);
                    }
                })
                .map_err(|e| format!("cannot start reading the file: {e}"))?;
            Ok(lines_view(id, &open))
        })
        .await
    }

    /// The count so far.
    pub fn state(id: u32) -> Result<LinesView, String> {
        let open = open_lines(id)?;
        Ok(lines_view(id, &open))
    }

    /// Up to `count` lines from line `from` (0 based). Lines longer than 4000 characters are cut with an ellipsis;
    /// lines the count has not reached yet are not returned.
    pub async fn read(id: u32, from: f64, count: u32) -> Result<Vec<String>, String> {
        let open = open_lines(id)?;
        run(move || {
            files::read_lines(
                open.files.as_ref(),
                &open.path,
                &open.index,
                from.max(0.0) as u64,
                count.min(2000) as usize,
            )
            .map_err(|e| e.message)
        })
        .await
    }

    /// The line number after `from` (before it when `forward` is false) that holds `query`, ignoring case, wrapping
    /// once around the file; `undefined` when nothing matches. `from` `undefined` starts at the top (the end,
    /// backwards). A new search stops the one running. Searches only what the count has reached.
    pub async fn find(
        id: u32,
        query: String,
        from: Option<f64>,
        forward: bool,
    ) -> Result<Option<f64>, String> {
        let open = open_lines(id)?;
        let stop = Arc::new(AtomicBool::new(false));
        open.search.lock().store(true, Ordering::Relaxed);
        *open.search.lock() = stop.clone();
        run(move || {
            files::find_line(
                open.files.as_ref(),
                &open.path,
                &open.index,
                &query,
                from.map(|f| f.max(0.0) as u64),
                forward,
                &stop,
            )
            .map(|hit| hit.map(number))
            .map_err(|e| e.message)
        })
        .await
    }

    /// Closes the file: stops its count and any search. Safe to call twice.
    pub fn close(id: u32) {
        if let Some(open) = OPEN_LINES.lock().remove(&id) {
            open.cancel.store(true, Ordering::Relaxed);
            open.search.lock().store(true, Ordering::Relaxed);
        }
    }

    /// How many files are open for paging (a test reads it after closing viewers).
    pub fn open_count() -> u32 {
        OPEN_LINES.lock().len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn a_range_is_met_clamped_or_refused() {
        assert_eq!(byte_range("bytes=0-9", 100), Some(Ok((0, 9))));
        assert_eq!(byte_range("bytes=90-", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=90-500", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=-10", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=100-", 100), Some(Err(())), "past the end");
        assert_eq!(byte_range("bytes=9-3", 100), Some(Err(())), "backwards");
        assert_eq!(
            byte_range("bytes=0-1", 0),
            Some(Err(())),
            "an empty file has no range"
        );
        assert_eq!(
            byte_range("items=0-1", 100),
            None,
            "not a byte range: the whole file"
        );
    }

    fn ask(port: u16, request: &str) -> (String, Vec<u8>) {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut all = Vec::new();
        stream.read_to_end(&mut all).unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        (
            String::from_utf8_lossy(&all[..split]).into_owned(),
            all[split..].to_vec(),
        )
    }

    #[test]
    fn the_viewer_server_serves_only_a_registered_file_with_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("doc.pdf");
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &body).unwrap();
        let server = SERVER.as_ref().unwrap().clone();
        let port: u16 = server.origin.rsplit(':').next().unwrap().parse().unwrap();
        let token = new_token().unwrap();
        assert_eq!(token.len(), 32);
        server.tokens.lock().insert(
            token.clone(),
            Served {
                path: file,
                fetch: 9_999,
            },
        );

        let (head, all) = ask(
            port,
            &format!("GET /f/{token}/doc.pdf HTTP/1.1\r\nHost: x\r\n\r\n"),
        );
        assert!(
            head.starts_with("HTTP/1.1 200 OK") && head.contains("application/pdf"),
            "{head}"
        );
        assert!(head.contains("Accept-Ranges: bytes") && head.contains("Content-Length: 200000"));
        assert_eq!(all, body);

        let (head, part) = ask(
            port,
            &format!("GET /f/{token}/doc.pdf HTTP/1.1\r\nrange: bytes=1000-1999\r\n\r\n"),
        );
        assert!(
            head.starts_with("HTTP/1.1 206")
                && head.contains("Content-Range: bytes 1000-1999/200000"),
            "{head}"
        );
        assert_eq!(part, body[1000..2000]);

        let (head, tail) = ask(
            port,
            &format!("GET /f/{token}/doc.pdf HTTP/1.1\r\nRange: bytes=-5\r\n\r\n"),
        );
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert_eq!(tail, body[199_995..]);

        let (head, _) = ask(
            port,
            &format!("GET /f/{token}/doc.pdf HTTP/1.1\r\nRange: bytes=300000-\r\n\r\n"),
        );
        assert!(
            head.starts_with("HTTP/1.1 416") && head.contains("bytes */200000"),
            "{head}"
        );

        let (head, empty) = ask(port, &format!("HEAD /f/{token}/doc.pdf HTTP/1.1\r\n\r\n"));
        assert!(head.starts_with("HTTP/1.1 200") && empty.is_empty());

        // Nothing else is served: a guessed token, the root, a path that climbs, a method that writes.
        for request in [
            "GET /f/00000000000000000000000000000000/doc.pdf HTTP/1.1\r\n\r\n".to_owned(),
            "GET / HTTP/1.1\r\n\r\n".to_owned(),
            "GET /f/../../etc/passwd HTTP/1.1\r\n\r\n".to_owned(),
            "GET /etc/passwd HTTP/1.1\r\n\r\n".to_owned(),
        ] {
            let (head, body) = ask(port, &request);
            assert!(
                head.starts_with("HTTP/1.1 404") && body.is_empty(),
                "{request}: {head}"
            );
        }
        let (head, _) = ask(port, &format!("POST /f/{token}/doc.pdf HTTP/1.1\r\n\r\n"));
        assert!(head.starts_with("HTTP/1.1 405"), "{head}");

        // Letting go of the copy ends its tokens.
        server.tokens.lock().retain(|_, s| s.fetch != 9_999);
        let (head, _) = ask(port, &format!("GET /f/{token}/doc.pdf HTTP/1.1\r\n\r\n"));
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
    }
}
