//! `Send a file to the machine`: a local file copied to a folder on a machine, in chunks.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use thiserror::Error;

use super::{EntryKind, FileError, FileErrorKind, Files, validate_path};

/// Why an upload did not finish. In every case nothing is left at the destination: the part file is
/// removed and an existing file of that name is untouched.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum UploadError {
    /// The person stopped it.
    #[error("Cancelled")]
    Cancelled,
    /// The source is not something to send (a folder, a device) or cannot be read.
    #[error("{0}")]
    Source(String),
    /// The machine refused or could not be reached; `Exists` here means the name is taken and
    /// `replace` was off.
    #[error("{0}")]
    Machine(FileError),
}

/// Copies the local file `source` to `dest` (a full path on the machine) and returns the bytes sent.
///
/// A name that is already there is [`FileErrorKind::Exists`] unless `replace`: it is checked up front (so
/// nothing is sent for it) and again by the final move, which is atomic, so a file that appears meanwhile
/// is not overwritten either. The data goes in `chunk` byte pieces into a hidden part file, and the part
/// file moves to `dest` only when all of it has arrived, so a dropped connection never leaves half a
/// file under the real name. `progress(sent, total)` runs after each piece; `cancel` is checked between
/// pieces.
pub fn upload(
    files: &dyn Files,
    source: &Path,
    dest: &str,
    replace: bool,
    chunk: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<u64, UploadError> {
    validate_path(dest).map_err(UploadError::Machine)?;
    let name = source.file_name().map_or_else(
        || source.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let source_error = |e: std::io::Error| UploadError::Source(format!("cannot read {name}: {e}"));
    let meta = std::fs::metadata(source).map_err(source_error)?;
    if !meta.is_file() {
        return Err(UploadError::Source(format!(
            "{name} is not a file: folders are not sent"
        )));
    }
    match files.stat(dest) {
        Ok(stat) if stat.kind == EntryKind::Dir => {
            return Err(UploadError::Machine(FileError::new(
                FileErrorKind::IsADirectory,
                format!("{dest} is a folder"),
            )));
        }
        Ok(_) if !replace => {
            return Err(UploadError::Machine(FileError::new(
                FileErrorKind::Exists,
                format!("{dest} already exists"),
            )));
        }
        Ok(_) => {}
        Err(e) if e.kind == FileErrorKind::NotFound => {}
        Err(e) => return Err(UploadError::Machine(e)),
    }
    let mut file = std::fs::File::open(source).map_err(source_error)?;
    let total = meta.len();
    let mut sent = 0u64;
    let mut buffer = vec![0u8; chunk.max(1)];
    let outcome = (|| {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(UploadError::Cancelled);
            }
            let mut filled = 0;
            while filled < buffer.len() {
                let n = file.read(&mut buffer[filled..]).map_err(source_error)?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            // The first piece is sent even when empty: it creates the part file of an empty file.
            if filled == 0 && sent > 0 {
                break;
            }
            files
                .put(dest, sent, &buffer[..filled])
                .map_err(UploadError::Machine)?;
            sent += filled as u64;
            progress(sent, total.max(sent));
            if filled < buffer.len() {
                break;
            }
        }
        files.commit(dest, replace).map_err(UploadError::Machine)
    })();
    match outcome {
        Ok(()) => Ok(sent),
        Err(e) => {
            // Best effort: the part file is only a hidden leftover if this fails too.
            let _ = files.discard(dest);
            Err(e)
        }
    }
}
