//! `Files` and `Pages`: what the file browser, the viewers, `Send a file` and pages from a machine call.
//!
//! The work is `herdr_core::files`; this file is the door TSX uses. Everything that touches a machine is
//! `async` and runs on the runtime's blocking threads (ssh or a slow disk must never hold the UI);
//! `Send a file` runs on a thread of its own and is read back with `uploads()` after `onUploadChange`
//! says something moved, like the rest of the app (a tick carries no data).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use herdr_core::files::{
    self, EntryKind, FileView, Files as MachineFiles, Tunnel, UploadError, ViewKind, candidates,
};
use nsh_core::prelude::*;
use parking_lot::Mutex;

use crate::api::engine;
use crate::fixture::{TEST_FLAG, test_seam_open};

/// The size of one piece of an upload to this computer or to a machine: big enough that the per-request
/// cost (an ssh command) is small, small enough that progress moves and a cancel is quick.
const UPLOAD_CHUNK: usize = 2 * 1024 * 1024;

/// How often an upload tells the screens it moved (the last piece and the end always do).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// What a folder entry is, after following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum EntryKindName {
    /// A folder.
    Dir,
    /// A regular file.
    File,
    /// Something the viewer cannot open: a socket, a device, a link that leads nowhere.
    Other,
}

impl From<EntryKind> for EntryKindName {
    fn from(kind: EntryKind) -> Self {
        match kind {
            EntryKind::Dir => Self::Dir,
            EntryKind::File => Self::File,
            EntryKind::Other => Self::Other,
        }
    }
}

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct EntryView {
    /// The file name, without its folder.
    pub name: String,
    /// What it is (a link counts as what it points to).
    pub kind: EntryKindName,
    /// Bytes, for a file; 0 otherwise.
    pub size: f64,
    /// Seconds since the Unix epoch it was last changed, when known.
    #[prop(skip_none)]
    pub modified: Option<f64>,
    /// Whether this user may read it. An entry that is not readable is still listed, and still opens
    /// to explain.
    pub readable: bool,
    /// Whether the name is a symbolic link.
    pub link: bool,
}

/// A folder: where it is and what is in it, folders first and then by name.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct FolderView {
    /// The folder as the machine knows it (`~` expanded).
    pub path: String,
    /// What it holds. At most 5000: see `truncated`.
    pub entries: Vec<EntryView>,
    /// The folder holds more than the list shows.
    pub truncated: bool,
    /// Entries whose names are not text and so cannot be listed.
    pub skipped: u32,
}

/// How the viewer shows a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ViewKindName {
    /// Text in the read-only editor.
    Text,
    /// Markdown as a document.
    Markdown,
    /// A picture.
    Image,
    /// Not text: only its size is shown.
    Binary,
}

impl From<ViewKind> for ViewKindName {
    fn from(kind: ViewKind) -> Self {
        match kind {
            ViewKind::Text => Self::Text,
            ViewKind::Markdown => Self::Markdown,
            ViewKind::Image => Self::Image,
            ViewKind::Binary => Self::Binary,
        }
    }
}

/// A file opened for the viewer.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct FileData {
    /// The path asked for.
    pub path: String,
    /// The file's name.
    pub name: String,
    /// Bytes.
    pub size: f64,
    /// Seconds since the Unix epoch it was last changed, when known.
    #[prop(skip_none)]
    pub modified: Option<f64>,
    /// How to show it.
    pub kind: ViewKindName,
    /// The text of `text` and `markdown` files: the first 4 MB at most, cut at a character.
    #[prop(skip_none)]
    pub text: Option<String>,
    /// The `file:` address of the picture on THIS computer, for `image` files (a copy for a remote
    /// machine's). Absent when the picture is too big to open: see `notice`.
    #[prop(skip_none)]
    pub image: Option<String>,
    /// A sentence to show above the content when it is not the whole file (`Showing the first 4.0 MB of
    /// 18 MB`), or why a picture was not opened.
    #[prop(skip_none)]
    pub notice: Option<String>,
    /// Whether the file is on this computer: only then can it be revealed or opened in another app.
    pub local: bool,
}

/// What is at a path.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct StatView {
    /// What it is.
    pub kind: EntryKindName,
    /// Bytes, for a file.
    pub size: f64,
    /// Whether this user may read it.
    pub readable: bool,
}

/// What `find` located.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Found {
    /// The path on the machine.
    pub path: String,
    /// Whether it is a folder (the browser) or a file (the viewer).
    pub kind: EntryKindName,
}

/// How an upload is going.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum UploadStateName {
    /// Pieces are being sent.
    Running,
    /// The whole file arrived.
    Done,
    /// It stopped: see `message`. Nothing is left at the destination.
    Failed,
    /// The person stopped it. Nothing is left at the destination.
    Cancelled,
}

/// One upload, as the `Send a file` list shows it.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct UploadView {
    /// Names the upload to `cancelUpload` and `forgetUpload`.
    pub id: u32,
    /// The machine it goes to.
    pub machine: String,
    /// The file's name.
    pub name: String,
    /// The full path it is going to on the machine.
    pub dest: String,
    /// Bytes sent so far.
    pub sent: f64,
    /// Bytes in the file.
    pub total: f64,
    /// How it is going.
    pub state: UploadStateName,
    /// Why it failed (`failed` only).
    #[prop(skip_none)]
    pub message: Option<String>,
    /// Whether it failed because a file of that name is already there: ask, then send again with `replace`.
    pub existed: bool,
}

/// Where uploads are kept for `uploads()`, and the wake-up for whoever listens.
struct Uploads {
    list: Mutex<Vec<(UploadView, Arc<AtomicBool>)>>,
    next: AtomicU32,
    listeners: Mutex<Vec<(u32, async_channel::Sender<()>)>>,
}

static UPLOADS: Uploads = Uploads {
    list: Mutex::new(Vec::new()),
    next: AtomicU32::new(1),
    listeners: Mutex::new(Vec::new()),
};

impl Uploads {
    /// Wakes every listener; never blocks (a full channel already has a wake-up waiting).
    fn wake(&self) {
        self.listeners
            .lock()
            .retain(|(_, tx)| match tx.try_send(()) {
                Ok(()) | Err(async_channel::TrySendError::Full(())) => true,
                Err(async_channel::TrySendError::Closed(())) => false,
            });
    }

    fn update(&self, id: u32, change: impl FnOnce(&mut UploadView)) {
        if let Some((view, _)) = self.list.lock().iter_mut().find(|(v, _)| v.id == id) {
            change(view);
        }
        self.wake();
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

fn entry_view(e: files::Entry) -> EntryView {
    EntryView {
        name: e.name,
        kind: e.kind.into(),
        size: number(e.size),
        modified: e.modified.map(|m| m as f64),
        readable: e.readable,
        link: e.link,
    }
}

fn file_data(view: FileView, local: bool) -> FileData {
    FileData {
        path: view.path,
        name: view.name,
        size: number(view.size),
        modified: view.modified.map(|m| m as f64),
        kind: view.kind.into(),
        text: view.text,
        image: view
            .image
            .map(|p| files::uri_from_path(&p.to_string_lossy())),
        notice: view.notice,
        local,
    }
}

/// The files of every machine: the browser, the viewers and `Send a file`. A path is absolute (or `~/`);
/// anything else is refused with a sentence. A failure throws with the words to show: what happened and
/// where.
#[module]
pub struct Files;

#[module]
impl Files {
    /// The entries of a folder on a machine, folders first and then by name.
    pub async fn list(machine: String, dir: String) -> Result<FolderView, String> {
        let engine = engine()?;
        run(move || {
            let listing = engine
                .files_of(&machine)?
                .list(&dir)
                .map_err(|e| e.message)?;
            Ok(FolderView {
                path: listing.path,
                entries: listing.entries.into_iter().map(entry_view).collect(),
                truncated: listing.truncated,
                skipped: listing.skipped as u32,
            })
        })
        .await
    }

    /// What is at a path (following links): a folder, a file or something else. Throws when there is nothing.
    pub async fn stat(machine: String, path: String) -> Result<StatView, String> {
        let engine = engine()?;
        run(move || {
            let stat = engine
                .files_of(&machine)?
                .stat(&path)
                .map_err(|e| e.message)?;
            Ok(StatView {
                kind: stat.kind.into(),
                size: number(stat.size),
                readable: stat.readable,
            })
        })
        .await
    }

    /// Opens a file for the viewer: text (the first 4 MB), Markdown, a picture, or just its size when
    /// it is not text. Throws for a folder, a missing file and one this user may not read.
    pub async fn open(machine: String, path: String) -> Result<FileData, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let local = engine.is_local_machine(&machine)?;
            files::open(files.as_ref(), &path, &engine.files_cache(), &machine)
                .map(|view| file_data(view, local))
                .map_err(|e| e.message)
        })
        .await
    }

    /// Finds what an agent's output named: a path is looked for in `cwd` and the two folders above it
    /// (an absolute path only where it says), and git's `a/` and `b/` prefixes are tried without.
    /// Resolves with the first match and whether it is a folder or a file; throws `<path> isn't in
    /// <cwd>` when there is none, which is also what a person reads.
    pub async fn find(machine: String, cwd: String, target: String) -> Result<Found, String> {
        let engine = engine()?;
        run(move || {
            let files = engine.files_of(&machine)?;
            let tries = candidates(&cwd, &target);
            let mut denied = None;
            for path in &tries {
                match files.stat(path) {
                    Ok(stat) => {
                        return Ok(Found {
                            path: path.clone(),
                            kind: stat.kind.into(),
                        });
                    }
                    Err(e) if e.kind == files::FileErrorKind::NotFound => {}
                    // A path that exists but cannot be read is the answer, not a reason to look elsewhere.
                    Err(e) if e.kind == files::FileErrorKind::Denied => denied = Some(e.message),
                    Err(e) => return Err(e.message),
                }
            }
            Err(denied.unwrap_or_else(|| {
                if tries.len() > 1 {
                    format!("{target} isn't in {cwd} or the folders above it")
                } else {
                    format!("{target} does not exist")
                }
            }))
        })
        .await
    }

    /// Shows a file of THIS computer in the system's file manager. Throws for another machine's file.
    pub async fn reveal(machine: String, path: String) -> Result<(), String> {
        let local = local_path(&machine, &path)?;
        reveal_path(local).await
    }

    /// Opens a file of THIS computer with the application the system chooses for it. Throws for
    /// another machine's file.
    pub async fn open_externally(machine: String, path: String) -> Result<(), String> {
        let local = local_path(&machine, &path)?;
        open_path(local).await
    }

    /// The local path a dropped `file:` address names, or `undefined` for anything that is not a file of
    /// this computer.
    pub fn path_from_uri(uri: String) -> Option<String> {
        files::path_from_uri(&uri)
    }

    /// Starts sending the local file `source` (a path, from `pathFromUri`) into the folder `destDir` on a
    /// machine, under its own name, and returns the upload's id at once. A name that is already there
    /// stops it as `failed` with `existed` set and nothing overwritten; send again with `replace` after
    /// the person agreed. Progress is `uploads()`, read after `onUploadChange`.
    pub fn start_upload(
        machine: String,
        source: String,
        dest_dir: String,
        replace: bool,
    ) -> Result<u32, String> {
        let engine = engine()?;
        let files = engine.files_of(&machine)?;
        let source = std::path::PathBuf::from(source);
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "That is not a file".to_owned())?
            .to_owned();
        let dest = files::join(&dest_dir, &name).map_err(|e| e.message)?;
        let id = UPLOADS.next.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        UPLOADS.list.lock().push((
            UploadView {
                id,
                machine,
                name: name.clone(),
                dest: dest.clone(),
                sent: 0.0,
                total: source.metadata().map_or(0.0, |m| number(m.len())),
                state: UploadStateName::Running,
                message: None,
                existed: false,
            },
            cancel.clone(),
        ));
        UPLOADS.wake();
        std::thread::Builder::new()
            .name(format!("herdr-upload-{id}"))
            .spawn(move || send(id, files, &source, &dest, replace, &cancel))
            .map_err(|e| format!("cannot start the upload: {e}"))?;
        Ok(id)
    }

    /// Stops a running upload; nothing is left at the destination.
    pub fn cancel_upload(id: u32) {
        if let Some((_, cancel)) = UPLOADS.list.lock().iter().find(|(v, _)| v.id == id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Takes a finished upload off the list.
    pub fn forget_upload(id: u32) {
        UPLOADS
            .list
            .lock()
            .retain(|(v, _)| v.id != id || v.state == UploadStateName::Running);
        UPLOADS.wake();
    }

    /// Every upload since the app started, oldest first, minus the forgotten ones.
    pub fn uploads() -> Vec<UploadView> {
        UPLOADS.list.lock().iter().map(|(v, _)| v.clone()).collect()
    }

    /// Test seam: copies the synthetic folder `fixtures/files/project` into the data directory and
    /// returns its path, so a test browses, views and uploads into a folder it owns. Throws unless
    /// `HERDR_DESKTOP_TEST=1`.
    pub fn test_tree() -> Result<String, String> {
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        let from = [
            std::env::current_dir()
                .ok()
                .map(|d| d.join("fixtures/files/project")),
            Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../fixtures/files/project"),
            ),
        ]
        .into_iter()
        .flatten()
        .find(|d| d.is_dir())
        .ok_or_else(|| "fixtures/files/project was not found".to_owned())?;
        let to = engine()?.test_tree_dir();
        let _ = std::fs::remove_dir_all(&to);
        copy_tree(&from, &to).map_err(|e| format!("cannot copy the test tree: {e}"))?;
        to.into_os_string()
            .into_string()
            .map_err(|_| "the data directory is not text".to_owned())
    }

    /// Calls `listener` when an upload moved or ended (at most every 100 ms while one sends); the call
    /// carries a counter, not data: read `uploads()`. Returns the function that stops listening.
    pub fn on_upload_change(#[args(tick)] listener: Callback<u64>, cx: CallCx<'_>) -> Stop {
        let (tx, rx) = async_channel::bounded(1);
        let id = UPLOADS.next.fetch_add(1, Ordering::Relaxed);
        UPLOADS.listeners.lock().push((id, tx));
        cx.start(async move {
            let mut tick = 0u64;
            while rx.recv().await.is_ok() {
                tick += 1;
                listener.post(tick);
            }
        });
        Stop::new(move || UPLOADS.listeners.lock().retain(|(i, _)| *i != id))
    }
}

/// The upload thread: sends, records the end.
fn send(
    id: u32,
    files: Arc<dyn MachineFiles>,
    source: &std::path::Path,
    dest: &str,
    replace: bool,
    cancel: &AtomicBool,
) {
    let mut last = Instant::now();
    let mut progress = |sent: u64, total: u64| {
        if last.elapsed() >= PROGRESS_EVERY || sent == total {
            last = Instant::now();
            UPLOADS.update(id, |v| {
                v.sent = number(sent);
                v.total = number(total);
            });
        }
    };
    let outcome = files::upload(
        files.as_ref(),
        source,
        dest,
        replace,
        UPLOAD_CHUNK,
        cancel,
        &mut progress,
    );
    UPLOADS.update(id, |v| match &outcome {
        Ok(sent) => {
            v.sent = number(*sent);
            v.total = number(*sent);
            v.state = UploadStateName::Done;
        }
        Err(UploadError::Cancelled) => v.state = UploadStateName::Cancelled,
        Err(UploadError::Source(message)) => {
            v.state = UploadStateName::Failed;
            v.message = Some(message.clone());
        }
        Err(UploadError::Machine(e)) => {
            v.state = UploadStateName::Failed;
            v.existed = e.kind == files::FileErrorKind::Exists;
            v.message = Some(e.message.clone());
        }
    });
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn local_path(machine: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let engine = engine()?;
    if !engine.is_local_machine(machine)? {
        return Err("That file is on another machine: this computer cannot open it".to_owned());
    }
    engine
        .files_of(machine)?
        .local_path(path)
        .ok_or_else(|| "That is not a path on this computer".to_owned())
}

/// A web address on a machine's own `localhost`.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct LocalhostAddress {
    /// `http` or `https`.
    pub scheme: String,
    /// The port on the machine.
    pub port: u32,
}

/// A page of a machine, reachable on this computer.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PageView {
    /// Names the page to `closePage`.
    pub id: u32,
    /// The address to load: `127.0.0.1` on this computer, forwarded to the machine's port.
    pub url: String,
    /// The address as the machine sees it (`http://localhost:5173/app`), for `Copy link` and the title.
    pub remote_url: String,
}

static PAGES: Mutex<Option<HashMap<u32, Arc<Tunnel>>>> = Mutex::new(None);
static NEXT_PAGE: AtomicU32 = AtomicU32::new(1);

/// Pages that a machine serves on its own `localhost`: a dev server an agent started. A page on another
/// machine is reached through a forward on that machine's shared ssh connection, bound to this
/// computer's loopback address only and removed when the page closes.
#[module]
pub struct Pages;

#[module]
impl Pages {
    /// Whether `url` is a web address on a machine's own loopback (`localhost`, `127.0.0.1`, `[::1]`,
    /// `0.0.0.0`): `undefined` for any other address, which is never tunnelled.
    pub fn localhost(url: String) -> Option<LocalhostAddress> {
        files::localhost_port(&url).map(|(scheme, port, _)| LocalhostAddress {
            scheme,
            port: u32::from(port),
        })
    }

    /// Opens a tunnel to a page on a remote machine and resolves with where to load it. Throws with what
    /// to do when the machine cannot be reached, and for this computer (its pages open in the browser).
    pub async fn open(machine: String, url: String) -> Result<PageView, String> {
        let engine = engine()?;
        run(move || {
            let (scheme, port, rest) = files::localhost_port(&url)
                .ok_or_else(|| "That is not an address on the machine's localhost".to_owned())?;
            let tunnel = engine.open_tunnel(&machine, port)?;
            let local = tunnel.local_port();
            let id = NEXT_PAGE.fetch_add(1, Ordering::Relaxed);
            PAGES
                .lock()
                .get_or_insert_with(HashMap::new)
                .insert(id, Arc::new(tunnel));
            // The machine's own host name, whichever loopback name the address used.
            let rest = if rest.is_empty() {
                "/".to_owned()
            } else {
                rest
            };
            Ok(PageView {
                id,
                url: format!("{scheme}://127.0.0.1:{local}{rest}"),
                remote_url: format!("{scheme}://localhost:{port}{rest}"),
            })
        })
        .await
    }

    /// Closes a page's tunnel. Safe to call twice.
    pub fn close_page(id: u32) {
        let tunnel = PAGES.lock().as_mut().and_then(|pages| pages.remove(&id));
        if let Some(tunnel) = tunnel {
            // Cancelling a forward runs ssh: not on the UI thread.
            std::thread::spawn(move || drop(tunnel));
        }
    }
}
