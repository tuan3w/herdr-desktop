//! The `Compose` module: what the chat's message box needs from the system and from the machine the chat runs on.
//!
//! * pictures made ready to send (`preparePictures`: a paste, a drop, the file dialog; scaled, without metadata,
//!   kept as a file of the app so a chip holds a path and a thumbnail, never megabytes);
//! * the system's file dialog (`pickFiles`), which `nsh` offers to Rust only;
//! * the `@` list (`mentions`: files and folders of the session's folder, hot ones first) and the one-line preview
//!   of the row under the keys (`peek`);
//! * a picture saved into the project for an agent that cannot see (`saveToProject`).
//!
//! Everything that reads a disk or a machine is `async` on the runtime's blocking threads: a 4 MB screenshot is
//! decoded and scaled off the UI thread.

use std::collections::VecDeque;
use std::path::Path;
use std::time::Duration;

use herdr_core::compose::{
    self, Fit, LONG_EDGE, MAX_BYTES, MAX_PICTURES, PictureError, THUMB, prepare,
};
use herdr_core::files::{EntryKind, HotPaths, validate_path};
use nsh_core::file_dialog::OpenDialog;
use nsh_core::prelude::*;
use parking_lot::Mutex;

use crate::api::engine;
use crate::files::QUICK;
use crate::fixture::{TEST_FLAG, test_seam_open};

/// Pictures this old are removed from the app's folder (their messages were sent long ago).
const KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The most characters of a line of a text preview.
const PEEK_LINE: usize = 110;

/// The most lines of a text preview.
const PEEK_LINES: usize = 3;

/// The most bytes read for a text preview: enough for its first lines.
const PEEK_BYTES: usize = 4096;

/// What a test's `pickFiles` answers, in order (the seam: a real dialog cannot be driven headless).
static TEST_PICKS: Mutex<VecDeque<Vec<String>>> = Mutex::new(VecDeque::new());

/// A picture ready to send.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PictureView {
    /// The prepared file, on this computer.
    pub path: String,
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    /// Pixels, after scaling.
    pub width: u32,
    /// Pixels, after scaling.
    pub height: u32,
    /// Bytes of the file.
    pub bytes: f64,
    /// The picture was made smaller than it came.
    pub scaled: bool,
    /// A JPEG thumbnail of 112 pixels, base64 (`data:image/jpeg;base64,` + this is what an `Image` shows).
    pub thumb: String,
}

/// What a path of this computer turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum DroppedKind {
    /// Any file but a picture.
    File,
    /// A folder.
    Folder,
    /// A picture, prepared (`picture`).
    Picture,
    /// Could not be used (`message`).
    Failed,
}

/// One path of a paste, a drop or the file dialog, sorted out.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct DroppedView {
    /// What it is.
    pub kind: DroppedKind,
    /// The path it came as.
    pub path: String,
    /// Its file name.
    pub name: String,
    /// The prepared picture, for `picture`.
    #[prop(skip_none)]
    pub picture: Option<PictureView>,
    /// Why it was not taken, for `failed`.
    #[prop(skip_none)]
    pub message: Option<String>,
}

/// Why a `@` row is listed before the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum HotName {
    /// Opened or mentioned lately.
    Recent,
    /// Changed, says git.
    Changed,
}

/// One file or folder a `@` can name.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct MentionView {
    /// Relative to the session's folder, `/` separated.
    pub path: String,
    /// Its name.
    pub name: String,
    /// Its folder; empty at the root.
    pub dir: String,
    /// A folder.
    pub folder: bool,
    /// Matched characters of `path` as flat `[start, end, ...]` pairs of UTF-16 units; empty for an empty query.
    pub marks: Vec<u32>,
    /// Why it is lifted, when it is.
    #[prop(skip_none)]
    pub hot: Option<HotName>,
    /// Found with a typo allowed: the name is close, not equal.
    pub typo: bool,
}

/// What `mentions` found.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct MentionsView {
    /// Best first.
    pub hits: Vec<MentionView>,
    /// Every match, whatever the limit.
    pub total: u32,
    /// Paths in the index.
    pub indexed: u32,
    /// The walk stopped at a limit: files may be missing.
    pub truncated: bool,
}

/// What a file or folder looks like, in a line or two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PeekKind {
    /// Text: `lines` are its first lines.
    Text,
    /// A picture: `thumb` is it, small.
    Picture,
    /// A folder: `count` entries.
    Folder,
    /// Something else.
    Binary,
}

/// The preview of the row under the keys.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PeekView {
    pub kind: PeekKind,
    /// Bytes, for a file.
    pub size: f64,
    /// Entries, for a folder.
    pub count: u32,
    /// The first non-blank lines of a text, cut to a line's width.
    pub lines: Vec<String>,
    /// A JPEG thumbnail, base64, for a picture small enough to decode for a preview.
    #[prop(skip_none)]
    pub thumb: Option<String>,
}

/// A picture saved into the project.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SavedView {
    /// Where, on the session's machine.
    pub path: String,
    /// The project's `.gitignore` names `.herdr-desktop` already.
    pub ignored: bool,
}

/// The limits the message box shows and enforces, one place for TSX and Rust.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ComposeLimits {
    /// Pictures one message carries.
    pub max_pictures: u32,
    /// Bytes of one picture after preparing it.
    pub max_picture_bytes: f64,
    /// Pixels on the long side of a picture unless the original is asked for.
    pub long_edge: u32,
    /// Pixels of a thumbnail.
    pub thumb: u32,
}

fn picture_view(p: compose::Picture) -> PictureView {
    PictureView {
        path: p.path.display().to_string(),
        mime: p.mime.to_owned(),
        width: p.width,
        height: p.height,
        bytes: p.bytes as f64,
        scaled: p.scaled,
        thumb: p.thumb,
    }
}

fn fit(original: bool) -> Fit {
    if original {
        Fit::Original
    } else {
        Fit::Long(LONG_EDGE)
    }
}

fn pictures_dir() -> Result<std::path::PathBuf, String> {
    let dir = engine()?.data_dir().join("composer");
    static PURGED: std::sync::Once = std::sync::Once::new();
    PURGED.call_once(|| compose::purge(&dir, KEEP));
    Ok(dir)
}

fn name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// The first bytes of a file of this computer (a sniff needs sixteen).
fn head(path: &Path, n: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(n);
    std::fs::File::open(path)?
        .take(n as u64)
        .read_to_end(&mut buf)?;
    Ok(buf)
}

fn sort_out(path: &str, dir: &Path, original: bool) -> DroppedView {
    let name = name_of(path);
    let failed = |message: String| DroppedView {
        kind: DroppedKind::Failed,
        path: path.to_owned(),
        name: name.clone(),
        picture: None,
        message: Some(message),
    };
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return failed(format!("Cannot read {name}: {e}")),
    };
    if meta.is_dir() {
        return DroppedView {
            kind: DroppedKind::Folder,
            path: path.to_owned(),
            name,
            picture: None,
            message: None,
        };
    }
    let is_picture = head(Path::new(path), 32)
        .ok()
        .is_some_and(|h| compose::sniff(&h).is_some());
    if !is_picture {
        return DroppedView {
            kind: DroppedKind::File,
            path: path.to_owned(),
            name,
            picture: None,
            message: None,
        };
    }
    // A bigger file than the reader takes is not read at all.
    if meta.len() > compose::MAX_SOURCE as u64 {
        return failed(format!("{name} is too big to attach as a picture"));
    }
    match std::fs::read(path)
        .map_err(|e| PictureError::Io(e.to_string()))
        .and_then(|bytes| prepare(&bytes, dir, fit(original)))
    {
        Ok(p) => DroppedView {
            kind: DroppedKind::Picture,
            path: path.to_owned(),
            name,
            picture: Some(picture_view(p)),
            message: None,
        },
        Err(e) => failed(format!("{name}: {e}")),
    }
}

/// The first non-blank lines of `text`, trimmed and cut to a line's width.
fn first_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .take(PEEK_LINES)
        .map(|l| {
            let mut cut: String = l.chars().take(PEEK_LINE).collect();
            if l.chars().count() > PEEK_LINE {
                cut.push('…');
            }
            cut.chars()
                .filter(|c| !c.is_control() || *c == '\t')
                .collect()
        })
        .collect()
}

/// The message box: pictures, the file dialog, `@`.
#[module]
pub struct Compose;

#[module]
impl Compose {
    /// The limits the box shows (`maxPictures` per message and so on), so the screen never repeats them.
    pub fn limits() -> ComposeLimits {
        ComposeLimits {
            max_pictures: MAX_PICTURES as u32,
            max_picture_bytes: MAX_BYTES as f64,
            long_edge: LONG_EDGE,
            thumb: THUMB,
        }
    }

    /// Makes a picture from the bytes a paste gave (`PasteEvent.files`): decoded, turned upright, scaled to 2000
    /// pixels on the long side unless `original`, encoded again with no metadata and kept under 5 MB. Runs off the
    /// UI thread. Throws with a sentence for anything that is not a PNG, JPEG, GIF or WebP, or cannot be made
    /// small enough.
    pub async fn prepare_picture(bytes: Vec<u8>, original: bool) -> Result<PictureView, String> {
        let dir = pictures_dir()?;
        blocking(move || prepare(&bytes, &dir, fit(original)))
            .await
            .map_err(|e| format!("the task stopped: {e}"))?
            .map(picture_view)
            .map_err(|e| e.to_string())
    }

    /// Sorts out paths of THIS computer (a drop, a pasted file list, the dialog's answer): a picture is prepared as
    /// `preparePicture` does, a folder and any other file are told apart. One entry per path, in order; a path
    /// that cannot be used says why.
    pub async fn prepare_paths(
        paths: Vec<String>,
        original: bool,
    ) -> Result<Vec<DroppedView>, String> {
        let dir = pictures_dir()?;
        blocking(move || {
            paths
                .iter()
                .map(|p| sort_out(p, &dir, original))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("the task stopped: {e}"))
    }

    /// Shows the system's file dialog (several files may be picked) and resolves with their paths on this
    /// computer; `[]` when it was cancelled. Throws when the dialog cannot show (a Linux without a file chooser):
    /// the screen then offers its own list.
    pub async fn pick_files() -> Result<Vec<String>, String> {
        if test_seam_open()
            && let Some(answer) = TEST_PICKS.lock().pop_front()
        {
            return Ok(answer);
        }
        let picked = pick_paths(
            OpenDialog::files()
                .multiple(true)
                .title("Attach files")
                .button_label("Attach"),
        )
        .await?;
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_os_string().into_string().ok())
            .collect())
    }

    /// Test seam: the next `pickFiles` answers `paths` instead of showing a dialog. Throws unless
    /// `HERDR_DESKTOP_TEST=1`.
    pub fn test_pick(paths: Vec<String>) -> Result<(), String> {
        if !test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        TEST_PICKS.lock().push_back(paths);
        Ok(())
    }

    /// The files and folders of `root` (the session's folder on `machine`) a `@query` can mean, best first, at
    /// most `limit`: every word of the query must match, typos in a name are forgiven when little else matches,
    /// folders count, and files git ignores are never offered. `recent` (what the person opened or mentioned,
    /// newest first) and `changed` (what git says changed) are paths relative to `root`; they lift a match. An
    /// empty query lists those, then the top-level folders, then the files changed last. The first ask of a root
    /// waits for the walk that indexes it (at most 5 seconds): call `Files.warm` earlier.
    pub async fn mentions(
        machine: String,
        root: String,
        query: String,
        limit: u32,
        recent: Vec<String>,
        changed: Vec<String>,
    ) -> Result<MentionsView, String> {
        let engine = engine()?;
        run_blocking(move || {
            let files = engine.files_of(&machine)?;
            let found = QUICK
                .mentions(
                    &machine,
                    &files,
                    &root,
                    &query,
                    limit as usize,
                    &HotPaths { recent, changed },
                )
                .map_err(|e| e.message)?;
            Ok(MentionsView {
                hits: found
                    .hits
                    .into_iter()
                    .map(|h| MentionView {
                        path: h.path,
                        name: h.name,
                        dir: h.dir,
                        folder: h.folder,
                        marks: h.marks,
                        hot: h.hot.map(|hot| match hot {
                            herdr_core::files::Hot::Recent => HotName::Recent,
                            herdr_core::files::Hot::Changed => HotName::Changed,
                        }),
                        typo: h.typo,
                    })
                    .collect(),
                total: found.total as u32,
                indexed: found.indexed as u32,
                truncated: found.truncated,
            })
        })
        .await
    }

    /// What `path` (relative to `root`) looks like, for the line under the `@` list: a text's first lines, a
    /// picture's thumbnail, a folder's entry count, or just its size. Throws when it cannot be read.
    pub async fn peek(
        machine: String,
        root: String,
        path: String,
        folder: bool,
    ) -> Result<PeekView, String> {
        let engine = engine()?;
        run_blocking(move || {
            let files = engine.files_of(&machine)?;
            let abs = format!("{}/{}", root.trim_end_matches('/'), path);
            validate_path(&abs).map_err(|e| e.message)?;
            if folder {
                let listing = files.list(&abs).map_err(|e| e.message)?;
                return Ok(PeekView {
                    kind: PeekKind::Folder,
                    size: 0.0,
                    count: listing.entries.len() as u32,
                    lines: Vec::new(),
                    thumb: None,
                });
            }
            let stat = files.stat(&abs).map_err(|e| e.message)?;
            if stat.kind != EntryKind::File {
                return Ok(PeekView {
                    kind: PeekKind::Binary,
                    size: 0.0,
                    count: 0,
                    lines: Vec::new(),
                    thumb: None,
                });
            }
            let want = if stat.size <= compose::PREVIEW_MAX as u64 {
                stat.size as usize
            } else {
                PEEK_BYTES
            };
            let chunk = files
                .read(&abs, 0, want.max(PEEK_BYTES))
                .map_err(|e| e.message)?;
            if let Some(thumb) = compose::thumbnail_of(&chunk.data) {
                return Ok(PeekView {
                    kind: PeekKind::Picture,
                    size: stat.size as f64,
                    count: 0,
                    lines: Vec::new(),
                    thumb: Some(thumb),
                });
            }
            let head = &chunk.data[..chunk.data.len().min(PEEK_BYTES)];
            let text = !head.contains(&0) && compose::sniff(head).is_none();
            Ok(PeekView {
                kind: if text {
                    PeekKind::Text
                } else {
                    PeekKind::Binary
                },
                size: stat.size as f64,
                count: 0,
                lines: if text {
                    first_lines(&String::from_utf8_lossy(head))
                } else {
                    Vec::new()
                },
                thumb: None,
            })
        })
        .await
    }

    /// Saves the prepared picture at `picture` (a path from `preparePicture`) into `<cwd>/.herdr-desktop/
    /// attachments/` on `machine` under `name`, never over another file, and says where. For an agent that
    /// cannot see pictures: the one way to show it one is a file it can open.
    pub async fn save_to_project(
        machine: String,
        cwd: String,
        picture: String,
        name: String,
    ) -> Result<SavedView, String> {
        let engine = engine()?;
        run_blocking(move || {
            let files = engine.files_of(&machine)?;
            compose::save_to_project(files.as_ref(), &cwd, Path::new(&picture), &name).map(|s| {
                SavedView {
                    path: s.path,
                    ignored: s.ignored,
                }
            })
        })
        .await
    }
}

/// Runs `f` on a blocking thread and settles with its result.
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(f)
        .await
        .map_err(|e| format!("the task stopped: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real 1 x 1 PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x64,
        0x60, 0xF8, 0x5F, 0x0F, 0x00, 0x02, 0x87, 0x01, 0x80, 0xEB, 0x47, 0xBA, 0x92, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn a_path_is_a_picture_a_folder_a_file_or_a_failure_by_what_it_holds_not_by_its_name() {
        let dir = tempfile::tempdir().expect("dir");
        let out = tempfile::tempdir().expect("dir");
        let disguised = dir.path().join("notes.txt");
        std::fs::write(&disguised, PNG).expect("write");
        let honest = dir.path().join("pic.png");
        std::fs::write(&honest, b"not a picture").expect("write");
        let folder = dir.path().join("src");
        std::fs::create_dir(&folder).expect("dir");
        let text = dir.path().join("a.rs");
        std::fs::write(&text, "fn a() {}").expect("write");

        let kinds: Vec<DroppedKind> = [
            &disguised,
            &honest,
            &folder,
            &text,
            &dir.path().join("gone"),
        ]
        .iter()
        .map(|p| sort_out(&p.display().to_string(), out.path(), false).kind)
        .collect();
        assert_eq!(
            kinds,
            [
                DroppedKind::Picture,
                DroppedKind::File,
                DroppedKind::Folder,
                DroppedKind::File,
                DroppedKind::Failed
            ]
        );
        let shown = sort_out(&disguised.display().to_string(), out.path(), false);
        let picture = shown.picture.expect("prepared");
        assert_eq!((picture.width, picture.height), (1, 1));
        assert!(picture.path.starts_with(&out.path().display().to_string()));
        assert!(!picture.thumb.is_empty());
    }

    #[test]
    fn a_preview_is_the_first_lines_cut_to_a_line_and_free_of_control_characters() {
        let long = "x".repeat(300);
        let lines = first_lines(&format!("\n  \nfirst\u{1b}[31m\n{long}\nthird\nfourth\n"));
        assert_eq!(lines.len(), PEEK_LINES);
        assert_eq!(lines[0], "first[31m");
        assert!(lines[1].ends_with('…') && lines[1].chars().count() == PEEK_LINE + 1);
        assert_eq!(lines[2], "third");
    }
}
