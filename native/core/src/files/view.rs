//! What the viewer shows of a file: its kind, the text of the first few megabytes, or a local copy of a picture.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::archive::is_archive_name;
use super::media::{MediaKind, media_kind};
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
    /// Comma or tab separated values, shown as a table (the text is read like any text file's).
    Csv,
    /// A video the player plays.
    Video,
    /// Sound the player plays.
    Audio,
    /// A PDF document: the system's viewer shows it.
    Pdf,
    /// An archive whose contents are listed.
    Archive,
    /// Something that is not text: a hex peek of its start, its size and the type its bytes announce.
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
    /// The text, for `Text`, `Markdown` and `Csv` (and an SVG picture's source): all of it, up to [`TEXT_CAP`]
    /// bytes. A bigger text file has no `text`: it is `large`.
    pub text: Option<String>,
    /// A text file over [`TEXT_CAP`]: the viewer pages through it by lines (`Lines`) instead of holding it.
    pub large: bool,
    /// Where the picture is on THIS computer: the file itself when it is local, else a copy in the cache.
    pub image: Option<PathBuf>,
    /// A sentence to show above the content: why a picture was not opened.
    pub notice: Option<String>,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];
const CSV_EXTENSIONS: &[&str] = &["csv", "tsv"];

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// What a file name says about its content, before any byte is read: pictures, Markdown, tables, sound, video, PDF
/// and archives by extension, everything else `None` (text or binary is decided by the bytes).
pub fn view_kind(name: &str) -> Option<ViewKind> {
    let ext = extension(name)?;
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(ViewKind::Image)
    } else if MARKDOWN_EXTENSIONS.contains(&ext.as_str()) {
        Some(ViewKind::Markdown)
    } else if CSV_EXTENSIONS.contains(&ext.as_str()) {
        Some(ViewKind::Csv)
    } else if let Some(kind) = media_kind(name) {
        Some(match kind {
            MediaKind::Video => ViewKind::Video,
            MediaKind::Audio => ViewKind::Audio,
        })
    } else if ext == "pdf" {
        Some(ViewKind::Pdf)
    } else if is_archive_name(name) {
        Some(ViewKind::Archive)
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
        large: false,
        image: None,
        notice: None,
    };
    match view_kind(&name) {
        Some(ViewKind::Image) => {
            view.kind = ViewKind::Image;
            if stat.size > IMAGE_CAP {
                view.notice = Some(format!(
                    "This picture is {}. The viewer opens pictures up to {}.",
                    size_text(stat.size),
                    size_text(IMAGE_CAP)
                ));
            } else {
                view.image = Some(local_copy(files, path, &name, &stat, cache, key)?);
                // An SVG is also text: its source is shown on request and copied as text.
                if extension(&name).as_deref() == Some("svg") && stat.size <= TEXT_CAP {
                    view.text = read_text(files, path, stat.size)?;
                }
            }
            return Ok(view);
        }
        // Played, listed or handed to the system's viewer: nothing of the file is read here.
        Some(kind @ (ViewKind::Video | ViewKind::Audio | ViewKind::Pdf | ViewKind::Archive)) => {
            view.kind = kind;
            return Ok(view);
        }
        _ => {}
    }

    if stat.size > TEXT_CAP {
        // Too big to hold: the viewer pages through it by lines when its start is text.
        let head = files.read(path, 0, SNIFF)?.data;
        if is_text(&head, true) {
            view.kind = ViewKind::Text;
            view.large = true;
        }
        return Ok(view);
    }
    let Some(text) = read_text(files, path, stat.size)? else {
        return Ok(view);
    };
    view.kind = match view_kind(&name) {
        Some(kind @ (ViewKind::Markdown | ViewKind::Csv)) => kind,
        _ => ViewKind::Text,
    };
    view.text = Some(text);
    Ok(view)
}

/// The whole of a file of at most [`TEXT_CAP`] bytes as text, or `None` when it is not text.
fn read_text(files: &dyn Files, path: &str, size: u64) -> Result<Option<String>, FileError> {
    let mut bytes = Vec::with_capacity(size as usize);
    while (bytes.len() as u64) < size {
        let step = (size - bytes.len() as u64).min(READ_MAX as u64 / 4) as usize;
        let chunk = files.read(path, bytes.len() as u64, step)?;
        if chunk.data.is_empty() {
            break;
        }
        bytes.extend_from_slice(&chunk.data);
        if bytes.len() == chunk.data.len() && !is_text(&bytes[..bytes.len().min(SNIFF)], true) {
            // Not text: nothing more to read.
            return Ok(None);
        }
    }
    // Exactly `size` bytes were read, so a sequence that ends in half a character is not text either.
    Ok(String::from_utf8(bytes).ok())
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

/// The largest picture `Copy image` puts on the clipboard: it travels as one base64 string.
pub const CLIPBOARD_IMAGE_CAP: u64 = 24 * 1024 * 1024;

/// The standard base64 alphabet, padded.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A picture as a `data:` address the clipboard takes (`Clipboard.writeImage`): png, jpeg, gif, webp and bmp, up to
/// [`CLIPBOARD_IMAGE_CAP`]. An SVG is text, not a picture the clipboard holds: the error says to copy its source.
pub fn image_data_url(files: &dyn Files, path: &str) -> Result<String, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    if stat.kind != EntryKind::File {
        return Err(FileError::new(
            FileErrorKind::Other,
            format!("{path} is not a regular file"),
        ));
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    let mime = match extension(name).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => {
            return Err(FileError::new(
                FileErrorKind::Other,
                "An SVG is not copied as a picture: copy its source instead.",
            ));
        }
        _ => {
            return Err(FileError::new(
                FileErrorKind::Other,
                format!("{name} is not a picture the clipboard can hold"),
            ));
        }
    };
    if stat.size > CLIPBOARD_IMAGE_CAP {
        return Err(FileError::new(
            FileErrorKind::Other,
            format!(
                "This picture is {}. The clipboard takes pictures up to {}.",
                size_text(stat.size),
                size_text(CLIPBOARD_IMAGE_CAP)
            ),
        ));
    }
    let mut bytes = Vec::with_capacity(stat.size as usize);
    while (bytes.len() as u64) < stat.size {
        let step = (stat.size - bytes.len() as u64).min(READ_MAX as u64 / 4) as usize;
        let chunk = files.read(path, bytes.len() as u64, step)?;
        if chunk.data.is_empty() {
            break;
        }
        bytes.extend_from_slice(&chunk.data);
    }
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;

    #[test]
    fn base64_matches_the_standard_vectors() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(plain.as_bytes()), coded);
        }
    }

    #[test]
    fn a_picture_becomes_a_data_address_and_an_svg_says_to_copy_its_source() {
        let files = Mem::with("/a/shot.png", vec![1, 2, 3, 4]);
        assert_eq!(
            image_data_url(&files, "/a/shot.png").unwrap(),
            "data:image/png;base64,AQIDBA=="
        );
        files.set("/a/logo.svg", b"<svg/>".to_vec());
        let err = image_data_url(&files, "/a/logo.svg").unwrap_err();
        assert!(err.message.contains("copy its source"), "{err}");
        files.set("/a/notes.txt", b"x".to_vec());
        assert!(image_data_url(&files, "/a/notes.txt").is_err());
    }

    #[test]
    fn a_picture_over_the_clipboard_cap_is_refused_before_it_is_read() {
        let files = Mem::with("/big.jpg", vec![0; CLIPBOARD_IMAGE_CAP as usize + 1]);
        let err = image_data_url(&files, "/big.jpg").unwrap_err();
        assert!(err.message.contains("up to 24 MB"), "{err}");
        assert!(files.reads().is_empty());
    }

    #[test]
    fn large_text_is_paged_not_held_and_media_is_not_read() {
        let files = Mem::with("/dev/null/big.log", vec![b'a'; TEXT_CAP as usize + 1]);
        let dir = tempfile::tempdir().unwrap();
        let view = open(&files, "/dev/null/big.log", dir.path(), "m").unwrap();
        assert_eq!(
            (view.kind, view.large, view.text),
            (ViewKind::Text, true, None)
        );
        assert_eq!(
            files.reads(),
            vec![(0, SNIFF)],
            "only the start was looked at"
        );
        files.set("/v.mp4", vec![0; 1 << 20]);
        let before = files.reads().len();
        let view = open(&files, "/v.mp4", dir.path(), "m").unwrap();
        assert_eq!(view.kind, ViewKind::Video);
        assert_eq!(
            files.reads().len(),
            before,
            "a video is not read to open it"
        );
    }
}
