//! What the viewer shows of a file: its kind, the text of the first few megabytes, or a local copy of a picture.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::{EntryKind, FileError, FileErrorKind, Files, READ_MAX, validate_path};

/// The most of a text file the viewer reads: past it the text is cut and says so. A megabyte of text is
/// about twenty thousand lines; the cap keeps a log of gigabytes from freezing the window.
pub const TEXT_CAP: u64 = 4 * 1024 * 1024;

/// The largest picture the viewer opens (mobile's limit): a bigger one says how big it is instead.
pub const IMAGE_CAP: u64 = 40 * 1024 * 1024;

/// How many bytes are looked at to tell text from binary.
const SNIFF: usize = 8 * 1024;

/// What a file is for the viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewKind {
    /// Text shown in the read-only editor, highlighted by its name.
    Text,
    /// Markdown shown as a document.
    Markdown,
    /// A picture the image viewer draws.
    Image,
    /// Something that is not text: only its size is shown.
    Binary,
}

/// What opening a file gives the viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileView {
    /// The path asked for.
    pub path: String,
    /// The file's name.
    pub name: String,
    /// Bytes.
    pub size: u64,
    /// Seconds since the Unix epoch it was last changed, when known.
    pub modified: Option<i64>,
    /// How to show it.
    pub kind: ViewKind,
    /// The text, for `Text` and `Markdown`: the first [`TEXT_CAP`] bytes at most, cut at a character.
    pub text: Option<String>,
    /// Where the picture is on THIS computer: the file itself when it is local, else a copy in the cache.
    pub image: Option<PathBuf>,
    /// A sentence to show above the content when it is not the whole file (`Showing the first 4 MB of 18 MB`).
    pub notice: Option<String>,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// What a file name says about its content, before any byte is read: pictures and Markdown by
/// extension, everything else `None` (text or binary is decided by the bytes).
pub fn view_kind(name: &str) -> Option<ViewKind> {
    let ext = extension(name)?;
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(ViewKind::Image)
    } else if MARKDOWN_EXTENSIONS.contains(&ext.as_str()) {
        Some(ViewKind::Markdown)
    } else {
        None
    }
}

/// Whether `bytes` (the start of a file) is text: no NUL byte, and valid UTF-8 apart from a character
/// the sample cut in half at its end.
fn is_text(bytes: &[u8], cut: bool) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => cut && e.error_len().is_none(),
    }
}

/// `1.4 MB`, `812 KB`, `37 bytes`: the size in the units a person reads.
pub fn size_text(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} bytes")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else if b < KB * KB * KB {
        let mb = b / (KB * KB);
        if mb < 10.0 {
            format!("{mb:.1} MB")
        } else {
            format!("{mb:.0} MB")
        }
    } else {
        format!("{:.1} GB", b / (KB * KB * KB))
    }
}

/// Opens `path` for the viewer: its kind, the text of its start, or a picture on this computer.
///
/// `cache` is a folder on this computer for copies of remote pictures and `key` names the machine
/// (together with the path, size and time it names the copy, so a changed file is fetched again). Never
/// reads more than [`TEXT_CAP`] bytes of text or [`IMAGE_CAP`] of a picture. A folder is
/// [`FileErrorKind::IsADirectory`]; a file this user may not read is [`FileErrorKind::Denied`].
pub fn open(files: &dyn Files, path: &str, cache: &Path, key: &str) -> Result<FileView, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    let name = path.rsplit('/').next().unwrap_or(path).to_owned();
    match stat.kind {
        EntryKind::Dir => {
            return Err(FileError::new(
                FileErrorKind::IsADirectory,
                format!("{path} is a folder"),
            ));
        }
        EntryKind::Other => {
            return Err(FileError::new(
                FileErrorKind::Other,
                format!("{name} is not a regular file"),
            ));
        }
        EntryKind::File => {}
    }
    if !stat.readable {
        return Err(FileError::new(
            FileErrorKind::Denied,
            format!("no permission to read {name}"),
        ));
    }
    let mut view = FileView {
        path: path.to_owned(),
        name: name.clone(),
        size: stat.size,
        modified: stat.modified,
        kind: ViewKind::Binary,
        text: None,
        image: None,
        notice: None,
    };
    if view_kind(&name) == Some(ViewKind::Image) {
        view.kind = ViewKind::Image;
        if stat.size > IMAGE_CAP {
            view.notice = Some(format!(
                "This picture is {}. The viewer opens pictures up to {}.",
                size_text(stat.size),
                size_text(IMAGE_CAP)
            ));
        } else {
            view.image = Some(local_copy(files, path, &name, &stat, cache, key)?);
        }
        return Ok(view);
    }

    let wanted = stat.size.min(TEXT_CAP);
    let mut bytes = Vec::with_capacity(wanted as usize);
    while (bytes.len() as u64) < wanted {
        let step = (wanted - bytes.len() as u64).min(READ_MAX as u64 / 4) as usize;
        let chunk = files.read(path, bytes.len() as u64, step)?;
        if chunk.data.is_empty() {
            break;
        }
        bytes.extend_from_slice(&chunk.data);
        if bytes.len() == chunk.data.len() && !is_text(&bytes[..bytes.len().min(SNIFF)], true) {
            // Not text: nothing more to read.
            return Ok(view);
        }
    }
    let cut = stat.size > bytes.len() as u64;
    if !is_text(&bytes, cut) {
        return Ok(view);
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => {
            // Only the end of a cut read can be a half character: drop it.
            let good = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(good);
            String::from_utf8(bytes).unwrap_or_default()
        }
    };
    view.kind = if view_kind(&name) == Some(ViewKind::Markdown) {
        ViewKind::Markdown
    } else {
        ViewKind::Text
    };
    if cut {
        view.notice = Some(format!(
            "Showing the first {} of {}",
            size_text(text.len() as u64),
            size_text(stat.size)
        ));
    }
    view.text = Some(text);
    Ok(view)
}

/// The picture at `path` as a file on this computer: itself when local, else a downloaded copy.
fn local_copy(
    files: &dyn Files,
    path: &str,
    name: &str,
    stat: &super::Stat,
    cache: &Path,
    key: &str,
) -> Result<PathBuf, FileError> {
    if let Some(local) = files.local_path(path) {
        return Ok(local);
    }
    let mut hasher = DefaultHasher::new();
    (key, path, stat.size, stat.modified).hash(&mut hasher);
    let ext = extension(name).unwrap_or_else(|| "img".to_owned());
    let target = cache.join(format!("{:016x}.{ext}", hasher.finish()));
    if target.is_file() {
        return Ok(target);
    }
    let io = |e: std::io::Error| {
        FileError::new(
            FileErrorKind::Other,
            format!("cannot keep a copy of {name}: {e}"),
        )
    };
    std::fs::create_dir_all(cache).map_err(io)?;
    let part = target.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(io)?;
    let mut have = 0u64;
    let result = (|| {
        while have < stat.size {
            let step = (stat.size - have).min(READ_MAX as u64) as usize;
            let chunk = files.read(path, have, step)?;
            if chunk.data.is_empty() {
                break;
            }
            out.write_all(&chunk.data).map_err(io)?;
            have += chunk.data.len() as u64;
        }
        out.flush().map_err(io)
    })();
    match result {
        Ok(()) => {
            std::fs::rename(&part, &target).map_err(io)?;
            Ok(target)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}
