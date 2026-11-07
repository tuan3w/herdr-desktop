//! What a file is as sound or picture, before anything plays: its kind by name, and, when the system cannot
//! play it, which codec it holds (so the error row can say `H.265` instead of "a plug-in is missing").
//!
//! The codec is read from the file's own headers through [`Files::read`], a few ranged reads, so it costs the
//! same on this computer and over ssh and never loads a file whole.

use super::{EntryKind, FileError, FileErrorKind, Files, validate_path};

/// Sound or moving picture, as the player shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    /// A video (it may turn out to have no picture; the player then shows the audio layout).
    Video,
    /// Sound only.
    Audio,
}

const VIDEO: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv", "ogv"];
const AUDIO: &[&str] = &["mp3", "m4a", "ogg", "oga", "opus", "wav", "flac", "aac"];

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// Whether the name says video or audio. `ogg` is sound (the usual use); a player that finds a picture in it shows it.
pub fn media_kind(name: &str) -> Option<MediaKind> {
    let ext = extension(name)?;
    if VIDEO.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else if AUDIO.contains(&ext.as_str()) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// What the headers of a media file say it holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Codecs {
    /// The container (`MP4`, `QuickTime`, `WebM`, `Matroska`, `Ogg`), when recognised.
    pub container: Option<String>,
    /// The video codec (`H.264`, `H.265`, `AV1`, `VP9`, ...).
    pub video: Option<String>,
    /// The audio codec (`AAC`, `Opus`, `Vorbis`, ...).
    pub audio: Option<String>,
}

impl Codecs {
    /// The sentence part that names what is inside: `H.265 video`, `AAC audio`, or both joined by ` and `.
    pub fn describe(&self) -> Option<String> {
        match (&self.video, &self.audio) {
            (Some(v), Some(a)) => Some(format!("{v} video and {a} audio")),
            (Some(v), None) => Some(format!("{v} video")),
            (None, Some(a)) => Some(format!("{a} audio")),
            (None, None) => None,
        }
    }
}

/// The video codec a sample-entry type of an MP4 names.
fn mp4_video(fourcc: &[u8]) -> Option<&'static str> {
    Some(match fourcc {
        b"avc1" | b"avc3" => "H.264",
        b"hvc1" | b"hev1" | b"dvh1" | b"dvhe" => "H.265",
        b"av01" => "AV1",
        b"vp08" => "VP8",
        b"vp09" => "VP9",
        b"mp4v" => "MPEG-4",
        b"apch" | b"apcn" | b"apcs" | b"apco" | b"ap4h" | b"ap4x" => "ProRes",
        b"jpeg" | b"mjpa" | b"mjpb" => "Motion JPEG",
        _ => return None,
    })
}

fn mp4_audio(fourcc: &[u8]) -> Option<&'static str> {
    Some(match fourcc {
        b"mp4a" => "AAC",
        b"alac" => "ALAC",
        b"ac-3" => "AC-3",
        b"ec-3" => "E-AC-3",
        b"Opus" => "Opus",
        b"fLaC" => "FLAC",
        b".mp3" => "MP3",
        b"sowt" | b"twos" | b"lpcm" | b"in24" | b"in32" | b"fl32" => "PCM",
        _ => return None,
    })
}

/// The boxes of `data`, one level: `(type, body)`.
fn boxes(data: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= data.len() {
        let size =
            u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize;
        let kind = &data[at + 4..at + 8];
        let (head, size) = match size {
            0 => (8, data.len() - at),
            1 if at + 16 <= data.len() => {
                let big = u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap_or([0; 8]));
                (16, usize::try_from(big).unwrap_or(usize::MAX))
            }
            n => (8, n),
        };
        if size < head || at.saturating_add(size) > data.len() {
            break;
        }
        out.push((kind, &data[at + head..at + size]));
        at += size;
    }
    out
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data)
        .into_iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, body)| body)
}

/// The codecs of the tracks inside a `moov` box.
fn moov_codecs(moov: &[u8]) -> Codecs {
    let mut codecs = Codecs::default();
    for (kind, trak) in boxes(moov) {
        if kind != b"trak" {
            continue;
        }
        let Some(mdia) = child(trak, b"mdia") else {
            continue;
        };
        // `hdlr` is version/flags (4), predefined (4), then the handler type.
        let handler = child(mdia, b"hdlr").and_then(|h| h.get(8..12));
        let stsd = child(mdia, b"minf")
            .and_then(|m| child(m, b"stbl"))
            .and_then(|s| child(s, b"stsd"));
        // `stsd` is version/flags (4), the entry count (4), then entries: size (4), type (4).
        let entry = stsd.and_then(|s| s.get(12..16));
        match (handler, entry) {
            (Some(b"vide"), Some(e)) if codecs.video.is_none() => {
                codecs.video = Some(mp4_video(e).map_or_else(
                    || String::from_utf8_lossy(e).trim().to_owned(),
                    str::to_owned,
                ));
            }
            (Some(b"soun"), Some(e)) if codecs.audio.is_none() => {
                codecs.audio = Some(mp4_audio(e).map_or_else(
                    || String::from_utf8_lossy(e).trim().to_owned(),
                    str::to_owned,
                ));
            }
            _ => {}
        }
    }
    codecs
}

/// The most of a `moov` box read: a movie of hours has a table of a few megabytes.
const MOOV_MAX: u64 = 24 * 1024 * 1024;

fn probe_mp4(files: &dyn Files, path: &str, size: u64, head: &[u8]) -> Result<Codecs, FileError> {
    let brand = head.get(8..12).unwrap_or_default();
    let container = if brand == b"qt  " { "QuickTime" } else { "MP4" };
    // Top-level boxes by hops: the 8 byte header of each, never the media data between them.
    let mut at = 0u64;
    let mut hops = 0;
    while at + 8 <= size && hops < 64 {
        hops += 1;
        let header = files.read(path, at, 16)?.data;
        if header.len() < 8 {
            break;
        }
        let small = u64::from(u32::from_be_bytes([
            header[0], header[1], header[2], header[3],
        ]));
        let kind = &header[4..8];
        let total = match small {
            0 => size - at,
            1 if header.len() >= 16 => {
                u64::from_be_bytes(header[8..16].try_into().unwrap_or([0; 8]))
            }
            n => n,
        };
        if total < 8 {
            break;
        }
        if kind == b"moov" {
            if total > MOOV_MAX {
                break;
            }
            let body = files.read(path, at, total as usize)?.data;
            let moov = boxes(&body)
                .into_iter()
                .find(|(k, _)| *k == b"moov")
                .map(|(_, b)| b)
                .unwrap_or_default();
            let mut codecs = moov_codecs(moov);
            codecs.container = Some(container.to_owned());
            return Ok(codecs);
        }
        at += total;
    }
    Ok(Codecs {
        container: Some(container.to_owned()),
        ..Codecs::default()
    })
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn probe_matroska(head: &[u8]) -> Codecs {
    let video = [
        (&b"V_MPEGH/ISO/HEVC"[..], "H.265"),
        (b"V_MPEG4/ISO/AVC", "H.264"),
        (b"V_AV1", "AV1"),
        (b"V_VP9", "VP9"),
        (b"V_VP8", "VP8"),
        (b"V_THEORA", "Theora"),
        (b"V_MPEG4/ISO/ASP", "MPEG-4"),
    ];
    let audio = [
        (&b"A_OPUS"[..], "Opus"),
        (b"A_VORBIS", "Vorbis"),
        (b"A_AAC", "AAC"),
        (b"A_FLAC", "FLAC"),
        (b"A_AC3", "AC-3"),
        (b"A_EAC3", "E-AC-3"),
        (b"A_MPEG/L3", "MP3"),
        (b"A_DTS", "DTS"),
    ];
    let pick = |table: &[(&[u8], &str)]| {
        table
            .iter()
            .find(|(id, _)| contains(head, id))
            .map(|(_, name)| (*name).to_owned())
    };
    let container = if contains(head, b"webm") {
        "WebM"
    } else {
        "Matroska"
    };
    Codecs {
        container: Some(container.to_owned()),
        video: pick(&video),
        audio: pick(&audio),
    }
}

fn probe_ogg(head: &[u8]) -> Codecs {
    Codecs {
        container: Some("Ogg".to_owned()),
        video: contains(head, b"\x80theora").then(|| "Theora".to_owned()),
        audio: if contains(head, b"OpusHead") {
            Some("Opus".to_owned())
        } else if contains(head, b"\x01vorbis") {
            Some("Vorbis".to_owned())
        } else if contains(head, b"\x7fFLAC") {
            Some("FLAC".to_owned())
        } else {
            None
        },
    }
}

/// What the headers of `path` say it holds: the container, the video codec and the audio codec, each only when
/// recognised. Never an error for an unrecognised file (that is an empty [`Codecs`]); a folder, a missing file and
/// an unreadable one are the usual file errors.
pub fn probe_codecs(files: &dyn Files, path: &str) -> Result<Codecs, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    if stat.kind != EntryKind::File {
        return Err(FileError::new(
            FileErrorKind::Other,
            format!("{path} is not a regular file"),
        ));
    }
    let head = files.read(path, 0, 128 * 1024)?.data;
    if head.get(4..8) == Some(b"ftyp") {
        return probe_mp4(files, path, stat.size, &head);
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Ok(probe_matroska(&head));
    }
    if head.starts_with(b"OggS") {
        return Ok(probe_ogg(&head[..head.len().min(4096)]));
    }
    Ok(Codecs::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;

    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn track(handler: &[u8; 4], entry: &[u8; 4]) -> Vec<u8> {
        let mut hdlr = vec![0; 8];
        hdlr.extend_from_slice(handler);
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(mp4_box(entry, &[0; 8]));
        let stbl = mp4_box(b"stbl", &mp4_box(b"stsd", &stsd));
        let mdia = [mp4_box(b"hdlr", &hdlr), mp4_box(b"minf", &stbl)].concat();
        mp4_box(b"trak", &mp4_box(b"mdia", &mdia))
    }

    fn movie(video: &[u8; 4], audio: &[u8; 4], moov_first: bool) -> Vec<u8> {
        let ftyp = mp4_box(b"ftyp", b"isom\0\0\0\0isomiso2");
        let moov = mp4_box(
            b"moov",
            &[track(b"vide", video), track(b"soun", audio)].concat(),
        );
        // 3 MB of media data, which the probe must hop over.
        let mdat = mp4_box(b"mdat", &vec![7u8; 3 * 1024 * 1024]);
        if moov_first {
            [ftyp, moov, mdat].concat()
        } else {
            [ftyp, mdat, moov].concat()
        }
    }

    #[test]
    fn names_decide_the_kind() {
        assert_eq!(media_kind("clip.MP4"), Some(MediaKind::Video));
        assert_eq!(media_kind("a.b.mkv"), Some(MediaKind::Video));
        assert_eq!(media_kind("song.flac"), Some(MediaKind::Audio));
        assert_eq!(media_kind("notes.txt"), None);
        assert_eq!(media_kind(".mp4"), None, "a dotfile has no extension");
    }

    #[test]
    fn an_mp4_names_its_codecs_even_when_the_movie_box_is_at_the_end() {
        for moov_first in [true, false] {
            let files = Mem::with("/v.mp4", movie(b"hvc1", b"mp4a", moov_first));
            let codecs = probe_codecs(&files, "/v.mp4").unwrap();
            assert_eq!(codecs.video.as_deref(), Some("H.265"));
            assert_eq!(codecs.audio.as_deref(), Some("AAC"));
            assert_eq!(codecs.container.as_deref(), Some("MP4"));
            assert_eq!(codecs.describe().unwrap(), "H.265 video and AAC audio");
        }
    }

    #[test]
    fn the_probe_hops_over_media_data_in_small_reads() {
        let files = Mem::with("/v.mp4", movie(b"avc1", b"mp4a", false));
        probe_codecs(&files, "/v.mp4").unwrap();
        let biggest = files.reads().into_iter().map(|(_, len)| len).max().unwrap();
        assert!(
            biggest <= 128 * 1024,
            "no read of the 3 MB of media data: {biggest}"
        );
    }

    #[test]
    fn webm_and_ogg_name_theirs() {
        let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0];
        webm.extend_from_slice(b"webm....V_VP9..A_OPUS");
        let files = Mem::with("/a.webm", webm);
        let codecs = probe_codecs(&files, "/a.webm").unwrap();
        assert_eq!(
            (codecs.video.as_deref(), codecs.audio.as_deref()),
            (Some("VP9"), Some("Opus"))
        );
        assert_eq!(codecs.container.as_deref(), Some("WebM"));

        let mut ogg = b"OggS".to_vec();
        ogg.extend_from_slice(b"\0\0\0\0\x80theora........\x01vorbis");
        let files = Mem::with("/a.ogv", ogg);
        let codecs = probe_codecs(&files, "/a.ogv").unwrap();
        assert_eq!(codecs.video.as_deref(), Some("Theora"));
        assert_eq!(codecs.audio.as_deref(), Some("Vorbis"));
    }

    #[test]
    fn a_file_that_is_not_media_has_no_codecs_and_a_truncated_one_does_not_panic() {
        let files = Mem::with("/n.mp4", b"not a movie at all".to_vec());
        assert_eq!(probe_codecs(&files, "/n.mp4").unwrap(), Codecs::default());
        let mut cut = movie(b"avc1", b"mp4a", false);
        cut.truncate(cut.len() - 40);
        let files = Mem::with("/c.mp4", cut);
        let codecs = probe_codecs(&files, "/c.mp4").unwrap();
        assert_eq!(codecs.video, None);
    }
}
