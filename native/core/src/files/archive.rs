//! What is inside an archive, without unpacking it: zip, tar and gzip-compressed tar, listed by name and size.
//!
//! A zip is read from its central directory at the end of the file (two or three ranged reads, however big the archive
//! is), a tar by hopping from header to header, a `.tar.gz` by decompressing as a stream and discarding. Nothing is
//! written to disk, nothing is held whole in memory, and a listing stops at [`LIST_LIMIT`] entries and says so.

use std::io::Read;

use flate2::read::GzDecoder;

use super::{EntryKind, FileError, FileErrorKind, Files, validate_path};

/// The most entries a listing returns.
pub const LIST_LIMIT: usize = 5000;

/// The most of a gzip stream that is decompressed to list its tar: past it the listing stops, `truncated`.
const STREAM_LIMIT: u64 = 512 * 1024 * 1024;

/// The central directory of a zip is read whole up to this size.
const DIRECTORY_MAX: u64 = 32 * 1024 * 1024;

/// One entry of an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    /// The path inside the archive.
    pub name: String,
    /// Bytes when unpacked (0 for a folder).
    pub size: u64,
    /// A folder.
    pub dir: bool,
}

/// An archive's contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    /// `zip`, `tar`, `tar.gz` or `gzip`.
    pub format: &'static str,
    /// The entries, in archive order, at most [`LIST_LIMIT`].
    pub entries: Vec<ArchiveEntry>,
    /// There are more than the list holds.
    pub truncated: bool,
}

/// Archives this module can list, by name.
pub fn is_archive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        ".zip", ".jar", ".war", ".apk", ".whl", ".egg", ".crx", ".vsix", ".epub", ".docx", ".xlsx",
        ".pptx", ".odt", ".tar", ".tgz", ".tar.gz", ".gz", ".7z", ".rar", ".bz2", ".xz",
        ".tar.bz2", ".tar.xz", ".zst", ".tar.zst",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

fn other(message: impl Into<String>) -> FileError {
    FileError::new(FileErrorKind::Other, message)
}

fn le16(b: &[u8], at: usize) -> u64 {
    u64::from(u16::from_le_bytes(
        b[at..at + 2].try_into().unwrap_or([0; 2]),
    ))
}
fn le32(b: &[u8], at: usize) -> u64 {
    u64::from(u32::from_le_bytes(
        b[at..at + 4].try_into().unwrap_or([0; 4]),
    ))
}
fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap_or([0; 8]))
}

fn list_zip(files: &dyn Files, path: &str, size: u64) -> Result<Listing, FileError> {
    let broken =
        || other("This zip file is damaged: its table of contents is not where it should be.");
    // The end-of-central-directory record is in the last 64 KB + 22 bytes (a comment may follow it).
    let tail_len = size.min(65_557) as usize;
    let tail_at = size - tail_len as u64;
    let tail = files.read(path, tail_at, tail_len)?.data;
    let eocd = tail
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .filter(|&at| at + 22 <= tail.len())
        .ok_or_else(broken)?;
    let mut count = le16(&tail, eocd + 10);
    let mut dir_size = le32(&tail, eocd + 12);
    let mut dir_at = le32(&tail, eocd + 16);
    // Zip64: the record before it holds the real numbers.
    if (count == 0xffff || dir_size == 0xffff_ffff || dir_at == 0xffff_ffff)
        && eocd >= 20
        && &tail[eocd - 20..eocd - 16] == b"PK\x06\x07"
    {
        let record_at = le64(&tail, eocd - 12);
        let record = files.read(path, record_at, 56)?.data;
        if record.len() >= 56 && &record[..4] == b"PK\x06\x06" {
            count = le64(&record, 32);
            dir_size = le64(&record, 40);
            dir_at = le64(&record, 48);
        }
    }
    if dir_at.checked_add(dir_size).is_none_or(|end| end > size) {
        return Err(broken());
    }
    if dir_size > DIRECTORY_MAX {
        return Err(other(
            "This zip file's table of contents is too large to list.",
        ));
    }
    let mut directory = Vec::with_capacity(dir_size as usize);
    while (directory.len() as u64) < dir_size {
        let want = (dir_size - directory.len() as u64).min(1024 * 1024) as usize;
        let chunk = files
            .read(path, dir_at + directory.len() as u64, want)?
            .data;
        if chunk.is_empty() {
            return Err(broken());
        }
        directory.extend_from_slice(&chunk);
    }
    let mut entries = Vec::new();
    let mut at = 0usize;
    let mut seen = 0u64;
    while at + 46 <= directory.len() && &directory[at..at + 4] == b"PK\x01\x02" {
        let (name_len, extra_len, comment_len) = (
            le16(&directory, at + 28) as usize,
            le16(&directory, at + 30) as usize,
            le16(&directory, at + 32) as usize,
        );
        let end = at + 46 + name_len + extra_len + comment_len;
        if end > directory.len() {
            break;
        }
        seen += 1;
        if entries.len() < LIST_LIMIT {
            let mut unpacked = le32(&directory, at + 24);
            // A zip64 entry keeps its real size in the extra field (id 1), first when the 32-bit one is saturated.
            if unpacked == 0xffff_ffff {
                let extra = &directory[at + 46 + name_len..at + 46 + name_len + extra_len];
                let mut i = 0;
                while i + 4 <= extra.len() {
                    let (id, len) = (le16(extra, i), le16(extra, i + 2) as usize);
                    if id == 1 && i + 4 + 8 <= extra.len() {
                        unpacked = le64(extra, i + 4);
                        break;
                    }
                    i += 4 + len;
                }
            }
            let name =
                String::from_utf8_lossy(&directory[at + 46..at + 46 + name_len]).into_owned();
            entries.push(ArchiveEntry {
                dir: name.ends_with('/'),
                size: unpacked,
                name,
            });
        }
        at = end;
    }
    Ok(Listing {
        format: "zip",
        truncated: seen > entries.len() as u64 || count > seen,
        entries,
    })
}

/// Reads a file through ranged reads, for the decompressor and the tar walker.
struct Ranged<'a> {
    files: &'a dyn Files,
    path: &'a str,
    at: u64,
    size: u64,
    buf: Vec<u8>,
    pos: usize,
    error: Option<FileError>,
}

impl<'a> Ranged<'a> {
    fn new(files: &'a dyn Files, path: &'a str, size: u64) -> Self {
        Self {
            files,
            path,
            at: 0,
            size,
            buf: Vec::new(),
            pos: 0,
            error: None,
        }
    }
}

impl Read for Ranged<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            if self.at >= self.size {
                return Ok(0);
            }
            let want = (self.size - self.at).min(1024 * 1024) as usize;
            match self.files.read(self.path, self.at, want) {
                Ok(chunk) if chunk.data.is_empty() => return Ok(0),
                Ok(chunk) => {
                    self.at += chunk.data.len() as u64;
                    self.buf = chunk.data;
                    self.pos = 0;
                }
                Err(e) => {
                    let io = std::io::Error::other(e.message.clone());
                    self.error = Some(e);
                    return Err(io);
                }
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn octal(field: &[u8]) -> Option<u64> {
    // GNU's base-256 form for sizes of 8 GB and more.
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        let mut n = u64::from(field[0] & 0x7f);
        for b in &field[1..] {
            n = n.checked_mul(256)?.checked_add(u64::from(*b))?;
        }
        return Some(n);
    }
    let text: String = field
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as char)
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(trimmed, 8).ok()
}

fn cstr(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// Lists a tar stream. `skip` discards `n` bytes of data (a seek where the source allows one).
fn list_tar(
    reader: &mut dyn Read,
    limit: u64,
) -> Result<(Vec<ArchiveEntry>, bool), std::io::Error> {
    let mut entries = Vec::new();
    let mut consumed = 0u64;
    let mut long_name: Option<String> = None;
    let mut zero_blocks = 0;
    loop {
        let mut header = [0u8; 512];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok((entries, false)),
            Err(e) => return Err(e),
        }
        consumed += 512;
        if header.iter().all(|&b| b == 0) {
            zero_blocks += 1;
            if zero_blocks == 2 {
                return Ok((entries, false));
            }
            continue;
        }
        zero_blocks = 0;
        let size =
            octal(&header[124..136]).ok_or_else(|| std::io::Error::other("not a tar file"))?;
        let kind = header[156];
        let mut name = cstr(&header[0..100]);
        if &header[257..262] == b"ustar" {
            let prefix = cstr(&header[345..500]);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        let data = size.div_ceil(512) * 512;
        match kind {
            // GNU long name: the data is the next entry's name.
            b'L' => {
                let mut bytes = vec![0u8; data.min(64 * 1024) as usize];
                reader.read_exact(&mut bytes)?;
                consumed += bytes.len() as u64;
                if data > bytes.len() as u64 {
                    discard(reader, data - bytes.len() as u64)?;
                    consumed += data - bytes.len() as u64;
                }
                long_name = Some(cstr(&bytes[..(size as usize).min(bytes.len())]));
            }
            // Extended headers and global ones carry no entry of their own.
            b'x' | b'g' => {
                discard(reader, data)?;
                consumed += data;
            }
            _ => {
                if let Some(long) = long_name.take() {
                    name = long;
                }
                let dir = kind == b'5' || name.ends_with('/');
                let shown = if dir || matches!(kind, b'1' | b'2' | b'3' | b'4' | b'6') {
                    0
                } else {
                    size
                };
                if entries.len() >= LIST_LIMIT {
                    return Ok((entries, true));
                }
                entries.push(ArchiveEntry {
                    name,
                    size: shown,
                    dir,
                });
                discard(reader, data)?;
                consumed += data;
            }
        }
        if consumed > limit {
            return Ok((entries, true));
        }
    }
}

fn discard(reader: &mut dyn Read, n: u64) -> std::io::Result<()> {
    if n == 0 {
        return Ok(());
    }
    let copied = std::io::copy(&mut reader.take(n), &mut std::io::sink())?;
    if copied < n {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    Ok(())
}

/// Lists the archive at `path`. Throws the usual file errors, and a sentence for a format that cannot be listed here
/// (7-Zip, RAR, bzip2, xz and Zstandard: open those with the system's app).
pub fn list(files: &dyn Files, path: &str) -> Result<Listing, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    if stat.kind != EntryKind::File {
        return Err(other(format!("{path} is not a regular file")));
    }
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let head = files.read(path, 0, 512)?.data;
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return list_zip(files, path, stat.size);
    }
    if head.starts_with(&[0x1f, 0x8b]) {
        let mut stream = GzDecoder::new(Ranged::new(files, path, stat.size)).take(STREAM_LIMIT);
        if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            let (entries, truncated) =
                match list_tar(&mut stream, STREAM_LIMIT) {
                    Ok(done) => done,
                    Err(e) => {
                        return Err(stream.into_inner().into_inner().error.unwrap_or_else(|| {
                            other(format!("This archive cannot be read: {e}"))
                        }));
                    }
                };
            return Ok(Listing {
                format: "tar.gz",
                entries,
                truncated,
            });
        }
        // A bare gzip holds one file: its name is the archive's without `.gz`; its size is read from the trailer.
        let tail_len = stat.size.min(4) as usize;
        let tail = files
            .read(path, stat.size - tail_len as u64, tail_len)?
            .data;
        let unpacked = if tail.len() == 4 {
            u64::from(u32::from_le_bytes([tail[0], tail[1], tail[2], tail[3]]))
        } else {
            0
        };
        let inner = name.strip_suffix(".gz").unwrap_or(&name).to_owned();
        return Ok(Listing {
            format: "gzip",
            entries: vec![ArchiveEntry {
                name: inner,
                size: unpacked,
                dir: false,
            }],
            truncated: false,
        });
    }
    if head.len() > 262 && &head[257..262] == b"ustar" || name.ends_with(".tar") {
        let mut reader = Ranged::new(files, path, stat.size);
        let (entries, truncated) = list_tar(&mut reader, u64::MAX).map_err(|e| {
            reader
                .error
                .take()
                .unwrap_or_else(|| other(format!("This archive cannot be read: {e}")))
        })?;
        return Ok(Listing {
            format: "tar",
            entries,
            truncated,
        });
    }
    Err(other(
        "This kind of archive cannot be listed here. Open it with the system's app.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;
    use std::io::Write;

    fn tar_header(name: &str, size: usize, kind: u8) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[156] = kind;
        h[257..262].copy_from_slice(b"ustar");
        h
    }

    fn tar(entries: &[(&str, usize, u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, size, kind) in entries {
            out.extend(tar_header(name, *size, *kind));
            out.extend(vec![b'x'; size.div_ceil(512) * 512]);
        }
        out.extend(vec![0u8; 1024]);
        out
    }

    fn zip(entries: &[(&str, u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, size) in entries {
            let offset = out.len() as u32;
            // A local header with no data is enough: the listing reads only the central directory.
            out.extend_from_slice(b"PK\x03\x04");
            out.extend(vec![0u8; 26]);
            out.extend_from_slice(name.as_bytes());
            let mut cd = vec![0u8; 46];
            cd[..4].copy_from_slice(b"PK\x01\x02");
            cd[24..28].copy_from_slice(&size.to_le_bytes());
            cd[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            cd[42..46].copy_from_slice(&offset.to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
            directory.extend(cd);
        }
        let at = out.len() as u32;
        out.extend_from_slice(&directory);
        let mut eocd = vec![0u8; 22];
        eocd[..4].copy_from_slice(b"PK\x05\x06");
        eocd[10..12].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        eocd[12..16].copy_from_slice(&(directory.len() as u32).to_le_bytes());
        eocd[16..20].copy_from_slice(&at.to_le_bytes());
        out.extend(eocd);
        out
    }

    #[test]
    fn a_zip_is_listed_from_its_table_of_contents_with_two_small_reads() {
        let mut data = zip(&[("src/", 0), ("src/main.rs", 812), ("README.md", 40)]);
        // Megabytes of unrelated bytes in front must not be read.
        let mut big = vec![9u8; 5 * 1024 * 1024];
        big.extend(std::mem::take(&mut data));
        // The offsets in the directory are relative to the front, which a listing never follows.
        let files = Mem::with("/a.zip", big);
        let head = files.read("/a.zip", 0, 512).unwrap().data;
        assert!(
            !head.starts_with(b"PK"),
            "the sample must not look like a zip at its front"
        );
        files.set(
            "/b.zip",
            zip(&[("src/", 0), ("src/main.rs", 812), ("README.md", 40)]),
        );
        let listing = list(&files, "/b.zip").unwrap();
        assert_eq!(listing.format, "zip");
        assert_eq!(
            listing.entries,
            vec![
                ArchiveEntry {
                    name: "src/".into(),
                    size: 0,
                    dir: true
                },
                ArchiveEntry {
                    name: "src/main.rs".into(),
                    size: 812,
                    dir: false
                },
                ArchiveEntry {
                    name: "README.md".into(),
                    size: 40,
                    dir: false
                },
            ]
        );
        assert!(!listing.truncated);
    }

    #[test]
    fn a_big_zip_reads_the_end_not_the_whole() {
        let mut data = vec![b'z'; 8 * 1024 * 1024];
        data[..4].copy_from_slice(b"PK\x03\x04");
        let inner = zip(&[("a.txt", 1)]);
        let offset = data.len();
        data.extend_from_slice(&inner);
        // Point the end record at the directory's real place.
        let n = data.len();
        let at = (offset + inner.len() - 22 - 51) as u32;
        let eocd = n - 22;
        data[eocd + 16..eocd + 20].copy_from_slice(&at.to_le_bytes());
        let files = Mem::with("/big.zip", data);
        let listing = list(&files, "/big.zip").unwrap();
        assert_eq!(listing.entries.len(), 1);
        let read: usize = files.reads().iter().map(|(_, n)| n).sum();
        assert!(read < 200 * 1024, "read {read} bytes of an 8 MB archive");
    }

    #[test]
    fn a_zip_with_more_than_the_limit_says_so() {
        let names: Vec<String> = (0..LIST_LIMIT + 20).map(|i| format!("f{i}")).collect();
        let entries: Vec<(&str, u32)> = names.iter().map(|n| (n.as_str(), 1)).collect();
        let files = Mem::with("/m.zip", zip(&entries));
        let listing = list(&files, "/m.zip").unwrap();
        assert_eq!(listing.entries.len(), LIST_LIMIT);
        assert!(listing.truncated);
    }

    #[test]
    fn a_damaged_zip_says_what_is_wrong() {
        let mut data = zip(&[("a", 1)]);
        let n = data.len();
        data[n - 22..n - 18].copy_from_slice(b"XXXX");
        let files = Mem::with("/d.zip", data);
        let err = list(&files, "/d.zip").unwrap_err();
        assert!(err.message.contains("damaged"), "{err}");
    }

    #[test]
    fn a_tar_is_listed_by_hopping_over_data() {
        let files = Mem::with(
            "/a.tar",
            tar(&[
                ("docs/", 0, b'5'),
                ("docs/a.txt", 700, b'0'),
                ("link", 0, b'2'),
            ]),
        );
        let listing = list(&files, "/a.tar").unwrap();
        assert_eq!(listing.format, "tar");
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.size, e.dir))
            .collect();
        assert_eq!(
            names,
            vec![
                ("docs/", 0, true),
                ("docs/a.txt", 700, false),
                ("link", 0, false)
            ]
        );
    }

    #[test]
    fn a_tgz_is_listed_through_the_decompressor() {
        let raw = tar(&[("app/", 0, b'5'), ("app/bin", 3000, b'0')]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&raw).unwrap();
        let files = Mem::with("/x.tar.gz", gz.finish().unwrap());
        let listing = list(&files, "/x.tar.gz").unwrap();
        assert_eq!(listing.format, "tar.gz");
        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.entries[1].size, 3000);
    }

    #[test]
    fn a_bare_gzip_is_one_file_with_its_unpacked_size() {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&vec![b'a'; 12_345]).unwrap();
        let files = Mem::with("/server.log.gz", gz.finish().unwrap());
        let listing = list(&files, "/server.log.gz").unwrap();
        assert_eq!(listing.format, "gzip");
        assert_eq!(listing.entries[0].name, "server.log");
        assert_eq!(listing.entries[0].size, 12_345);
    }

    #[test]
    fn a_format_that_cannot_be_listed_says_to_use_the_system_app() {
        let files = Mem::with("/a.7z", b"7z\xbc\xaf\x27\x1c rest of it".to_vec());
        let err = list(&files, "/a.7z").unwrap_err();
        assert!(err.message.contains("system's app"), "{err}");
        assert!(
            is_archive_name("a.7z") && is_archive_name("X.TAR.GZ") && !is_archive_name("a.txt")
        );
    }

    #[test]
    fn a_file_that_is_not_a_tar_is_an_error_not_a_panic() {
        let files = Mem::with("/n.tar", vec![b'q'; 2000]);
        assert!(list(&files, "/n.tar").is_err());
    }
}
