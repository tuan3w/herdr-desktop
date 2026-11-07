//! A look inside a file that is not text: the first 4 KB as a hex dump, and what its first bytes say it is.

use super::{EntryKind, FileError, FileErrorKind, Files, validate_path};

/// How many bytes the peek shows.
pub const PEEK_BYTES: usize = 4096;

/// Bytes per row of the dump.
const ROW: usize = 16;

/// A hex dump of the start of a file and the type its bytes announce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peek {
    /// The file's size.
    pub size: u64,
    /// What the first bytes say it is (`PNG image`, `ELF executable`), when recognised.
    pub detected: Option<String>,
    /// The dump, one row per 16 bytes: `00000010  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|`.
    pub rows: Vec<String>,
    /// How many bytes the dump shows.
    pub shown: usize,
}

/// Signatures at the start of a file (offset 0) and what they name. The order matters where one is a prefix of another.
const MAGIC: &[(&[u8], &str)] = &[
    (b"\x89PNG\r\n\x1a\n", "PNG image"),
    (b"\xff\xd8\xff", "JPEG image"),
    (b"GIF87a", "GIF image"),
    (b"GIF89a", "GIF image"),
    (b"%PDF-", "PDF document"),
    (b"PK\x03\x04", "ZIP archive"),
    (b"PK\x05\x06", "ZIP archive (empty)"),
    (b"\x1f\x8b", "gzip data"),
    (b"BZh", "bzip2 data"),
    (b"\xfd7zXZ\x00", "xz data"),
    (b"\x28\xb5\x2f\xfd", "Zstandard data"),
    (b"7z\xbc\xaf\x27\x1c", "7-Zip archive"),
    (b"Rar!\x1a\x07", "RAR archive"),
    (b"\x7fELF", "ELF executable"),
    (b"\xcf\xfa\xed\xfe", "Mach-O executable (64-bit)"),
    (b"\xce\xfa\xed\xfe", "Mach-O executable (32-bit)"),
    (b"\xca\xfe\xba\xbe", "Mach-O universal binary or Java class"),
    (b"\xbe\xba\xfe\xca", "Mach-O universal binary"),
    (b"MZ", "Windows executable"),
    (b"\0asm", "WebAssembly module"),
    (b"SQLite format 3\0", "SQLite database"),
    (b"OggS", "Ogg audio or video"),
    (b"fLaC", "FLAC audio"),
    (b"ID3", "MP3 audio"),
    (b"RIFF", "RIFF container (WAV, AVI or WebP)"),
    (b"\x1a\x45\xdf\xa3", "Matroska or WebM video"),
    (b"\x00\x00\x01\x00", "Windows icon"),
    (b"wOFF", "WOFF font"),
    (b"wOF2", "WOFF2 font"),
    (b"\0\x01\0\0\0", "TrueType font"),
    (b"OTTO", "OpenType font"),
    (b"{\\rtf", "RTF document"),
    (
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
        "Microsoft Office document (legacy)",
    ),
    (b"bplist00", "Apple property list"),
    (b"#!", "script"),
];

/// What the first bytes of a file say it is.
pub fn detect(head: &[u8]) -> Option<String> {
    if head.get(4..8) == Some(b"ftyp") {
        return Some(
            match head.get(8..12) {
                Some(b"qt  ") => "QuickTime video",
                Some(b"M4A ") => "MPEG-4 audio",
                Some(b"heic" | b"heix" | b"mif1") => "HEIF image",
                _ => "MPEG-4 video",
            }
            .to_owned(),
        );
    }
    if head.len() > 262 && &head[257..262] == b"ustar" {
        return Some("tar archive".to_owned());
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return Some("WebP image".to_owned());
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        return Some("WAV audio".to_owned());
    }
    if head.starts_with(&[0xff]) && head.get(1).is_some_and(|b| b & 0xe0 == 0xe0) {
        return Some("MP3 audio".to_owned());
    }
    MAGIC
        .iter()
        .find(|(magic, _)| head.starts_with(magic))
        .map(|(_, name)| (*name).to_owned())
}

/// The dump of `bytes`, whose first byte is at `base`.
pub fn hex_rows(bytes: &[u8], base: usize) -> Vec<String> {
    bytes
        .chunks(ROW)
        .enumerate()
        .map(|(i, row)| {
            let mut line = format!("{:08x}  ", base + i * ROW);
            for col in 0..ROW {
                match row.get(col) {
                    Some(b) => line.push_str(&format!("{b:02x} ")),
                    None => line.push_str("   "),
                }
                if col == 7 {
                    line.push(' ');
                }
            }
            line.push_str(" |");
            line.extend(row.iter().map(|&b| {
                if (0x20..0x7f).contains(&b) {
                    b as char
                } else {
                    '.'
                }
            }));
            line.push('|');
            line
        })
        .collect()
}

/// Reads the first [`PEEK_BYTES`] of `path`. Throws the usual file errors for a folder, a missing or an unreadable file.
pub fn peek(files: &dyn Files, path: &str) -> Result<Peek, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    if stat.kind != EntryKind::File {
        return Err(FileError::new(
            FileErrorKind::Other,
            format!("{path} is not a regular file"),
        ));
    }
    let head = files
        .read(path, 0, PEEK_BYTES.min(stat.size as usize))?
        .data;
    Ok(Peek {
        size: stat.size,
        detected: detect(&head),
        rows: hex_rows(&head, 0),
        shown: head.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;

    #[test]
    fn a_row_has_offset_hex_and_ascii() {
        let rows = hex_rows(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRabc", 0x10);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            "00000010  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|"
        );
        // The short row is padded so the ASCII column lines up with the row above.
        assert!(rows[1].starts_with("00000020  61 62 63 "), "{}", rows[1]);
        assert!(rows[1].ends_with("  |abc|"), "{}", rows[1]);
        assert_eq!(rows[1].len() - 3, rows[0].len() - 16);
    }

    #[test]
    fn the_first_bytes_name_the_type() {
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n....").unwrap(), "PNG image");
        assert_eq!(detect(b"\x7fELF\x02\x01").unwrap(), "ELF executable");
        assert_eq!(detect(b"\0\0\0\x18ftypqt  ").unwrap(), "QuickTime video");
        assert_eq!(detect(b"RIFF\x24\0\0\0WEBPVP8 ").unwrap(), "WebP image");
        assert_eq!(detect(b"RIFF\x24\0\0\0WAVEfmt ").unwrap(), "WAV audio");
        let mut tar = vec![0u8; 512];
        tar[257..262].copy_from_slice(b"ustar");
        assert_eq!(detect(&tar).unwrap(), "tar archive");
        assert_eq!(detect(b"\x01\x02\x03\x04"), None);
        assert_eq!(detect(b""), None);
    }

    #[test]
    fn a_peek_reads_only_the_first_four_kilobytes() {
        let files = Mem::with("/blob.bin", (0..200_000u32).map(|i| i as u8).collect());
        let peek = peek(&files, "/blob.bin").unwrap();
        assert_eq!(peek.shown, PEEK_BYTES);
        assert_eq!(peek.rows.len(), PEEK_BYTES / 16);
        assert_eq!(peek.size, 200_000);
        assert_eq!(files.reads(), vec![(0, PEEK_BYTES)]);
    }

    #[test]
    fn an_empty_file_has_no_rows() {
        let files = Mem::with("/e.bin", Vec::new());
        let peek = peek(&files, "/e.bin").unwrap();
        assert!(peek.rows.is_empty() && peek.detected.is_none() && peek.size == 0);
    }
}
