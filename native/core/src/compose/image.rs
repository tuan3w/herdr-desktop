//! Pictures for a message: decode what the clipboard, a drop or the file dialog gave, turn it upright, scale it,
//! encode it again (which drops every byte of metadata: GPS, camera, the author's name) and keep it under a size.
//!
//! The result is a file in the app's own folder (`<data dir>/composer`), so what a chip holds is a path and a small
//! thumbnail, never the picture's bytes: ten 5 MB pictures in a box cost the window a few kilobytes. Nothing here
//! runs on the UI thread; callers use a worker.

use std::fmt::Write as _;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};

/// The longest side a picture is scaled to unless the person asked for the original: Claude's vision scales anything
/// longer down to about 1568 px before reading it, so more pixels only cost bandwidth (often over ssh) and tokens.
pub const LONG_EDGE: u32 = 1568;

/// What a scaled picture aims to weigh at most: a screenshot that would be heavier as a PNG goes as a JPEG, then at a
/// lower quality, then smaller (owner, 2026-11-08: "must compress, since it can cause lots of bandwidth").
pub const TARGET_BYTES: usize = 1024 * 1024;

/// JPEG qualities tried in turn: 85 keeps the text of a screenshot readable; 75 is the floor before pixels go.
const QUALITIES: [u8; 2] = [85, 75];

/// The most bytes one picture may be after encoding: the cap `attach::MAX_PICTURE_BYTES` sends as a picture.
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

/// The most bytes of a picture read at all (a clipboard image is limited to 48 MB by nsh).
pub const MAX_SOURCE: usize = 48 * 1024 * 1024;

/// The most pictures one message carries.
pub const MAX_PICTURES: usize = 10;

/// The shortest long side a picture is shrunk to while it is over [`MAX_BYTES`]: below it the picture is unreadable.
const MIN_EDGE: u32 = 640;

/// The side of a thumbnail in pixels: 56 points at twice the density.
pub const THUMB: u32 = 112;

/// The longest side a decoded picture may have; a bigger header is refused before any pixel is allocated.
const MAX_SIDE: u32 = 20_000;

/// How far a picture is scaled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// The long side is at most this many pixels.
    Long(u32),
    /// As it is (still shrunk when it would not fit [`MAX_BYTES`]).
    Original,
}

/// A prepared picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    /// Where the encoded picture is kept.
    pub path: PathBuf,
    /// `image/png` or `image/jpeg`.
    pub mime: &'static str,
    /// Pixels, after scaling.
    pub width: u32,
    pub height: u32,
    /// Bytes of the file.
    pub bytes: u64,
    /// The picture was made smaller than it came.
    pub scaled: bool,
    /// A JPEG thumbnail of [`THUMB`] pixels, base64: what a chip shows.
    pub thumb: String,
}

/// Why a picture was not taken, in words for the person.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PictureError {
    #[error("That is not a picture this app can read (PNG, JPEG, GIF or WebP)")]
    Unreadable,
    #[error("That picture is {0} MB, more than the {1} MB this app reads")]
    TooBigToRead(usize, usize),
    #[error("That picture is over {0} MB even when it is made smaller")]
    TooBigToSend(usize),
    #[error("Cannot keep the picture: {0}")]
    Io(String),
}

/// `bytes` as a picture of the person's message: upright, scaled by `fit`, without metadata, at most [`MAX_BYTES`],
/// written to `dir` under a name made of its own hash (the same picture twice is one file).
///
/// # Errors
/// [`PictureError`] for anything that is not a readable PNG, JPEG, GIF or WebP, a picture that cannot be made small
/// enough, and a failure to write.
pub fn prepare(bytes: &[u8], dir: &Path, fit: Fit) -> Result<Picture, PictureError> {
    let mut img = decode(bytes)?;
    let (came_w, came_h) = (img.width(), img.height());

    // A photograph stays a JPEG (a PNG of it is four times the size); everything else is lossless.
    let mut jpeg = sniff(bytes) == Some(ImageFormat::Jpeg);
    if let Fit::Long(edge) = fit {
        img = shrink_to(img, edge);
    }
    // A scaled picture aims at the target; the original setting keeps every pixel it can and only respects the cap.
    let limit = match fit {
        Fit::Long(_) => TARGET_BYTES,
        Fit::Original => MAX_BYTES,
    };
    let mut quality = 0;
    let encoded = loop {
        let bytes = encode(&img, jpeg, QUALITIES[quality])?;
        if bytes.len() <= limit {
            break bytes;
        }
        // Over: a PNG without transparency is the same picture as a JPEG at a fraction of the size; then a lower
        // quality; after that the only thing left to give up is pixels.
        if !jpeg && !has_transparency(&img) {
            jpeg = true;
            continue;
        }
        if jpeg && quality + 1 < QUALITIES.len() {
            quality += 1;
            continue;
        }
        let long = img.width().max(img.height());
        if long <= MIN_EDGE {
            // As small as it may get: under the hard cap it still goes, over it is refused.
            if bytes.len() <= MAX_BYTES {
                break bytes;
            }
            return Err(PictureError::TooBigToSend(MAX_BYTES >> 20));
        }
        img = shrink_to(img, (long * 3 / 4).max(MIN_EDGE));
    };

    let (mime, ext) = if jpeg {
        ("image/jpeg", "jpg")
    } else {
        ("image/png", "png")
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    encoded.hash(&mut hasher);
    let mut name = String::with_capacity(24);
    // Writing to a String cannot fail.
    let _ = write!(name, "{:016x}.{ext}", hasher.finish());
    let path = dir.join(name);
    write_private(&path, &encoded).map_err(|e| PictureError::Io(e.to_string()))?;
    Ok(Picture {
        path,
        mime,
        width: img.width(),
        height: img.height(),
        bytes: encoded.len() as u64,
        scaled: img.width() != came_w || img.height() != came_h,
        thumb: crate::ssh::base64(&thumbnail(&img)),
    })
}

/// The picture format of `bytes` when it is one this app reads (PNG, JPEG, GIF, WebP), from its first bytes.
pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    let format = image::guess_format(bytes).ok()?;
    matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    )
    .then_some(format)
}

/// A JPEG thumbnail of the picture in `bytes`, base64, for a preview; `None` for what is not a picture, is too big
/// to be worth decoding for a preview, or cannot be decoded.
pub fn thumbnail_of(bytes: &[u8]) -> Option<String> {
    if bytes.len() > PREVIEW_MAX {
        return None;
    }
    let img = decode(bytes).ok()?;
    Some(crate::ssh::base64(&thumbnail(&img)))
}

/// The most bytes of a picture decoded for a preview.
pub const PREVIEW_MAX: usize = 2 * 1024 * 1024;

/// `bytes` decoded and turned upright; refuses what is not a readable picture or is absurdly large.
fn decode(bytes: &[u8]) -> Result<DynamicImage, PictureError> {
    if bytes.len() > MAX_SOURCE {
        return Err(PictureError::TooBigToRead(
            bytes.len().div_ceil(1 << 20),
            MAX_SOURCE >> 20,
        ));
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| PictureError::Unreadable)?;
    let format = reader.format().ok_or(PictureError::Unreadable)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(PictureError::Unreadable);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(768 * 1024 * 1024);
    let mut reader = reader;
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| PictureError::Unreadable)?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder).map_err(|_| PictureError::Unreadable)?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Ok(img)
}

/// `img` scaled down so that its long side is `edge`; a picture that is smaller already is left alone.
fn shrink_to(img: DynamicImage, edge: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= edge {
        return img;
    }
    let scale = f64::from(edge) / f64::from(long);
    let nw = (f64::from(w) * scale).round().max(1.0) as u32;
    let nh = (f64::from(h) * scale).round().max(1.0) as u32;
    img.resize_exact(nw, nh, FilterType::Lanczos3)
}

fn encode(img: &DynamicImage, jpeg: bool, quality: u8) -> Result<Vec<u8>, PictureError> {
    let mut out = Vec::new();
    if jpeg {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, quality)
            .write_image(&rgb, rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .map_err(|e| PictureError::Io(e.to_string()))?;
    } else if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        PngEncoder::new(&mut out)
            .write_image(&rgba, rgba.width(), rgba.height(), ExtendedColorType::Rgba8)
            .map_err(|e| PictureError::Io(e.to_string()))?;
    } else {
        let rgb = img.to_rgb8();
        PngEncoder::new(&mut out)
            .write_image(&rgb, rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .map_err(|e| PictureError::Io(e.to_string()))?;
    }
    Ok(out)
}

/// Whether any pixel is not opaque: a screenshot of a window with rounded corners has an alpha channel and no
/// transparency worth keeping, a sticker has both.
fn has_transparency(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

/// A JPEG of [`THUMB`] pixels on the long side, transparency flattened onto white.
fn thumbnail(img: &DynamicImage) -> Vec<u8> {
    let small = shrink_to(img.clone(), THUMB);
    let mut rgb = image::RgbImage::new(small.width(), small.height());
    for (x, y, pixel) in small.to_rgba8().enumerate_pixels() {
        let a = u32::from(pixel.0[3]);
        let blend = |c: u8| ((u32::from(c) * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(
            x,
            y,
            image::Rgb([blend(pixel.0[0]), blend(pixel.0[1]), blend(pixel.0[2])]),
        );
    }
    let mut out = Vec::new();
    // A thumbnail that fails to encode is an empty string: the chip shows an icon instead.
    if JpegEncoder::new_with_quality(&mut out, 80)
        .write_image(&rgb, rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .is_err()
    {
        out.clear();
    }
    out
}

/// Writes `bytes` to `path` for this user only, whole or not at all.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    if path.is_file() {
        // The same bytes are already there (the name is their hash).
        return Ok(());
    }
    let part = path.with_extension("part");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&part)?;
    file.write_all(bytes)?;
    file.sync_data()?;
    std::fs::rename(&part, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn png_of(img: &DynamicImage) -> Vec<u8> {
        encode(img, false, 85).expect("png")
    }

    fn jpeg_of(img: &DynamicImage) -> Vec<u8> {
        encode(img, true, 90).expect("jpeg")
    }

    /// A picture like a window screenshot: flat panels and a few lines, which a PNG keeps small.
    fn window(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            if y % 40 == 0 {
                Rgb([200, 200, 200])
            } else if x < w / 4 {
                Rgb([245, 244, 240])
            } else {
                Rgb([255, 255, 255])
            }
        }))
    }

    fn gradient(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            Rgb([
                (x * 255 / w) as u8,
                (y * 255 / h) as u8,
                ((x ^ y) & 255) as u8,
            ])
        }))
    }

    /// A picture nothing compresses: noise from a fixed seed.
    fn noise(w: u32, h: u32) -> DynamicImage {
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
        }))
    }

    fn unbase64(text: &str) -> Vec<u8> {
        let value = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        let mut out = Vec::new();
        for chunk in text.as_bytes().chunks(4) {
            let n = chunk
                .iter()
                .take_while(|c| **c != b'=')
                .enumerate()
                .fold(0_u32, |n, (i, c)| {
                    n | (u32::from(value(*c)) << (18 - 6 * i))
                });
            let bytes = chunk.iter().take_while(|c| **c != b'=').count() * 6 / 8;
            out.extend_from_slice(&n.to_be_bytes()[1..=bytes]);
        }
        out
    }

    fn read_back(p: &Picture) -> DynamicImage {
        image::open(&p.path).expect("the written file is a picture")
    }

    #[test]
    fn a_big_screenshot_is_scaled_to_the_long_edge_and_stays_a_lossless_png() {
        let dir = tempfile::tempdir().expect("dir");
        let shot = png_of(&window(3000, 1500));
        let p = prepare(&shot, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        assert_eq!((p.width, p.height), (1568, 784), "aspect kept");
        assert_eq!(
            p.mime, "image/png",
            "light enough as a PNG, so its text stays sharp"
        );
        assert!(p.scaled);
        let back = read_back(&p);
        assert_eq!((back.width(), back.height()), (1568, 784));
        assert_eq!(p.bytes, std::fs::metadata(&p.path).expect("meta").len());
    }

    #[test]
    fn a_heavy_screenshot_goes_as_a_jpeg_under_the_target() {
        let dir = tempfile::tempdir().expect("dir");
        // Noise is the worst case: as a 1568 x 980 PNG it is several MB.
        let heavy = png_of(&noise(1568, 980));
        assert!(heavy.len() > TARGET_BYTES, "{}", heavy.len());
        let p = prepare(&heavy, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        assert_eq!(p.mime, "image/jpeg");
        assert!(p.bytes as usize <= TARGET_BYTES, "{}", p.bytes);
    }

    #[test]
    fn a_small_picture_is_kept_at_its_size_and_the_original_setting_never_scales() {
        let dir = tempfile::tempdir().expect("dir");
        let small = png_of(&gradient(300, 200));
        let p = prepare(&small, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        assert_eq!((p.width, p.height, p.scaled), (300, 200, false));
        let big = png_of(&gradient(2600, 1300));
        let original = prepare(&big, dir.path(), Fit::Original).expect("prepared");
        assert_eq!((original.width, original.height), (2600, 1300));
        assert!(!original.scaled);
    }

    #[test]
    fn a_photograph_stays_a_jpeg() {
        let dir = tempfile::tempdir().expect("dir");
        let photo = jpeg_of(&gradient(2400, 1600));
        let p = prepare(&photo, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        assert_eq!(p.mime, "image/jpeg");
        assert_eq!(p.path.extension().and_then(|e| e.to_str()), Some("jpg"));
        assert_eq!((p.width, p.height), (1568, 1045));
    }

    #[test]
    fn metadata_does_not_survive_the_encode() {
        // A JPEG that carries an APP1 (EXIF) segment with a recognisable string.
        let dir = tempfile::tempdir().expect("dir");
        let plain = jpeg_of(&gradient(64, 48));
        let secret = b"Exif\0\0SECRET-GPS-48.8584N";
        let mut with = Vec::new();
        with.extend_from_slice(&plain[..2]);
        with.extend_from_slice(&[0xFF, 0xE1]);
        with.extend_from_slice(&((secret.len() + 2) as u16).to_be_bytes());
        with.extend_from_slice(secret);
        with.extend_from_slice(&plain[2..]);
        assert!(with.windows(6).any(|w| w == b"SECRET"));
        let p = prepare(&with, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        let out = std::fs::read(&p.path).expect("read");
        assert!(!out.windows(6).any(|w| w == b"SECRET"));
        assert!(!out.windows(4).any(|w| w == b"Exif"));
    }

    #[test]
    fn a_picture_over_the_cap_is_made_small_enough_never_refused_for_its_size_alone() {
        let dir = tempfile::tempdir().expect("dir");
        // Noise does not compress: as a 1500 x 1500 PNG it is over 5 MB.
        let heavy = png_of(&noise(1500, 1500));
        assert!(heavy.len() > MAX_BYTES, "{}", heavy.len());
        let p = prepare(&heavy, dir.path(), Fit::Original).expect("prepared");
        assert!(p.bytes as usize <= MAX_BYTES, "{}", p.bytes);
        assert_eq!(
            p.mime, "image/jpeg",
            "no transparency, so a JPEG can carry it"
        );
        assert!(p.width <= 1500 && p.height <= 1500);
    }

    #[test]
    fn transparency_is_kept_and_a_picture_that_needs_it_is_shrunk_instead() {
        let dir = tempfile::tempdir().expect("dir");
        let mut sticker = RgbaImage::from_fn(1800, 1800, |x, y| {
            Rgba([(x * y) as u8, (x ^ y) as u8, (x + y) as u8, 255])
        });
        sticker.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
        let heavy = png_of(&DynamicImage::ImageRgba8(sticker));
        let p = prepare(&heavy, dir.path(), Fit::Original).expect("prepared");
        assert_eq!(
            p.mime, "image/png",
            "a JPEG would lose the transparent pixel"
        );
        assert!(p.bytes as usize <= MAX_BYTES);
    }

    #[test]
    fn what_is_not_a_picture_is_refused_with_a_reason() {
        let dir = tempfile::tempdir().expect("dir");
        for junk in [&b"not a picture at all"[..], &b""[..], b"GIF89a"] {
            assert_eq!(
                prepare(junk, dir.path(), Fit::Original),
                Err(PictureError::Unreadable)
            );
        }
        let huge = vec![0_u8; MAX_SOURCE + 1];
        assert!(matches!(
            prepare(&huge, dir.path(), Fit::Original),
            Err(PictureError::TooBigToRead(49, 48))
        ));
    }

    #[test]
    fn an_exif_rotation_is_applied_before_the_metadata_is_dropped() {
        // 40 x 20 with orientation 6 (rotate 90 clockwise) shows as 20 x 40.
        let dir = tempfile::tempdir().expect("dir");
        let plain = jpeg_of(&gradient(40, 20));
        // TIFF header (big endian) with one entry: Orientation (0x0112) = 6.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\0\x2A\0\0\0\x08");
        tiff.extend_from_slice(&[
            0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(&tiff);
        let mut with = Vec::new();
        with.extend_from_slice(&plain[..2]);
        with.extend_from_slice(&[0xFF, 0xE1]);
        with.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        with.extend_from_slice(&exif);
        with.extend_from_slice(&plain[2..]);
        let p = prepare(&with, dir.path(), Fit::Long(LONG_EDGE)).expect("prepared");
        assert_eq!((p.width, p.height), (20, 40));
    }

    #[test]
    fn the_same_picture_twice_is_one_file_and_the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let shot = png_of(&gradient(120, 80));
        let a = prepare(&shot, dir.path(), Fit::Original).expect("a");
        let b = prepare(&shot, dir.path(), Fit::Original).expect("b");
        assert_eq!(a.path, b.path);
        let mode = std::fs::metadata(&a.path)
            .expect("meta")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let folder = std::fs::metadata(dir.path())
            .expect("meta")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(folder, 0o700);
        assert_eq!(std::fs::read_dir(dir.path()).expect("dir").count(), 1);
    }

    #[test]
    fn the_thumbnail_is_a_small_jpeg_and_flattens_transparency() {
        let dir = tempfile::tempdir().expect("dir");
        let clear = DynamicImage::ImageRgba8(RgbaImage::from_pixel(400, 200, Rgba([0, 0, 0, 0])));
        let p = prepare(&png_of(&clear), dir.path(), Fit::Original).expect("prepared");
        let bytes = unbase64(&p.thumb);
        let thumb = image::load_from_memory(&bytes).expect("a jpeg");
        assert_eq!((thumb.width(), thumb.height()), (112, 56));
        let px = thumb.to_rgb8().get_pixel(10, 10).0;
        assert!(
            px.iter().all(|c| *c > 240),
            "transparent pixels are white: {px:?}"
        );
        assert!(p.thumb.len() < 6000, "{}", p.thumb.len());
    }
}
