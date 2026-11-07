//! Readable text colours: WCAG contrast, OKLCH lightness correction, and the xterm palette.
//!
//! Agents print text for dark terminals (dim greys, saturated blues) that is unreadable on a
//! light theme. [`min_contrast_fg`] moves a foreground along the lightness axis only, so hue and
//! (as far as the sRGB gamut allows) chroma survive and `red` still reads as red.

/// An 8-bit sRGB colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb {
    /// Red.
    pub r: u8,
    /// Green.
    pub g: u8,
    /// Blue.
    pub b: u8,
}

impl Rgb {
    /// The colour with these channels.
    pub const fn new(r: u8, g: u8, b: u8) -> Rgb {
        Rgb { r, g, b }
    }

    /// WCAG 2.x relative luminance, 0 (black) to 1 (white).
    pub fn luminance(self) -> f64 {
        0.2126 * channel_to_linear(self.r)
            + 0.7152 * channel_to_linear(self.g)
            + 0.0722 * channel_to_linear(self.b)
    }
}

/// The WCAG 2.x contrast ratio of two colours, 1 (identical) to 21 (black on white).
pub fn contrast_ratio(a: Rgb, b: Rgb) -> f32 {
    ratio_of(a.luminance(), b.luminance()) as f32
}

fn ratio_of(a: f64, b: f64) -> f64 {
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

fn channel_to_linear(c: u8) -> f64 {
    let c = f64::from(c) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_channel(c: f64) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let encoded = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round() as u8
}

/// Oklab lightness, chroma and hue (radians) of an sRGB colour.
fn to_oklch(c: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (
        channel_to_linear(c.r),
        channel_to_linear(c.g),
        channel_to_linear(c.b),
    );
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let lightness = 0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s;
    let a = 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s;
    let b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s;
    (lightness, a.hypot(b), b.atan2(a))
}

/// Linear sRGB of an OKLCH colour; channels may fall outside 0..=1 (outside the gamut).
fn oklch_to_linear(lightness: f64, chroma: f64, hue: f64) -> [f64; 3] {
    let (a, b) = (chroma * hue.cos(), chroma * hue.sin());
    let l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s = (lightness - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
    [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s,
    ]
}

fn in_gamut(linear: [f64; 3]) -> bool {
    linear.iter().all(|c| (-1e-4..=1.0 + 1e-4).contains(c))
}

/// The colour at `lightness` with `hue` and as much of `chroma` as fits in sRGB. Chroma is only
/// reduced when the full value is out of gamut, which is what keeps a corrected blue blue.
fn at_lightness(lightness: f64, chroma: f64, hue: f64) -> Rgb {
    let mut linear = oklch_to_linear(lightness, chroma, hue);
    if !in_gamut(linear) {
        let (mut lo, mut hi) = (0.0, chroma);
        for _ in 0..12 {
            let mid = (lo + hi) / 2.0;
            if in_gamut(oklch_to_linear(lightness, mid, hue)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        linear = oklch_to_linear(lightness, lo, hue);
    }
    Rgb::new(
        linear_to_channel(linear[0]),
        linear_to_channel(linear[1]),
        linear_to_channel(linear[2]),
    )
}

/// The nearest lightness change from `lightness` towards `extreme` (0 black, 1 white) that reaches
/// `ratio` against `bg`, or `None` when even the extreme does not.
fn search(
    lightness: f64,
    chroma: f64,
    hue: f64,
    extreme: f64,
    bg: Rgb,
    ratio: f64,
) -> Option<(f64, Rgb)> {
    let end = at_lightness(extreme, 0.0, hue);
    if ratio_of(end.luminance(), bg.luminance()) < ratio {
        return None;
    }
    // Invariant: `hi` passes. Contrast is monotonic in lightness up to the small non-monotonicity
    // that chroma reduction adds, which the final check on `hi` itself makes harmless.
    let (mut lo, mut hi, mut best) = (lightness, extreme, end);
    for _ in 0..16 {
        let mid = (lo + hi) / 2.0;
        let candidate = at_lightness(mid, chroma, hue);
        if ratio_of(candidate.luminance(), bg.luminance()) >= ratio {
            hi = mid;
            best = candidate;
        } else {
            lo = mid;
        }
    }
    Some(((hi - lightness).abs(), best))
}

/// `fg` moved along OKLCH lightness until its WCAG contrast against `bg` is at least `ratio`;
/// `fg` itself when it already is, or when `ratio <= 1` (correction off). Hue is kept and chroma
/// is reduced only when the sRGB gamut forces it. When no lightness reaches `ratio` (a mid-grey
/// background and `ratio` 7), the better of black and white is returned.
pub fn min_contrast_fg(fg: Rgb, bg: Rgb, ratio: f32) -> Rgb {
    let ratio = f64::from(ratio);
    if ratio <= 1.0 || ratio_of(fg.luminance(), bg.luminance()) >= ratio {
        return fg;
    }
    let (lightness, chroma, hue) = to_oklch(fg);
    let lighter = search(lightness, chroma, hue, 1.0, bg, ratio);
    let darker = search(lightness, chroma, hue, 0.0, bg, ratio);
    match (lighter, darker) {
        (Some(l), Some(d)) => {
            if l.0 <= d.0 {
                l.1
            } else {
                d.1
            }
        }
        (Some(only), None) | (None, Some(only)) => only.1,
        (None, None) => {
            let (white, black) = (Rgb::new(255, 255, 255), Rgb::new(0, 0, 0));
            if ratio_of(white.luminance(), bg.luminance())
                >= ratio_of(black.luminance(), bg.luminance())
            {
                white
            } else {
                black
            }
        }
    }
}

/// The 6x6x6 colour cube (16..=231) and the 24 greys (232..=255) of the xterm 256-colour palette.
/// `None` below 16: those entries are the user's theme, not a fixed table.
pub fn indexed_cube_rgb(n: u8) -> Option<Rgb> {
    match n {
        0..=15 => None,
        16..=231 => {
            let c = n - 16;
            let level = |l: u8| if l == 0 { 0 } else { 55 + l * 40 };
            Some(Rgb::new(level(c / 36), level(c / 6 % 6), level(c % 6)))
        }
        232..=255 => {
            let grey = 8 + (n - 232) * 10;
            Some(Rgb::new(grey, grey, grey))
        }
    }
}

/// The xterm default palette for any index: the 16 system colours as xterm ships them, then
/// [`indexed_cube_rgb`]. Used where no theme supplies the first 16.
pub fn indexed_rgb(n: u8) -> Rgb {
    const SYSTEM: [(u8, u8, u8); 16] = [
        (0x00, 0x00, 0x00),
        (0xcd, 0x00, 0x00),
        (0x00, 0xcd, 0x00),
        (0xcd, 0xcd, 0x00),
        (0x00, 0x00, 0xee),
        (0xcd, 0x00, 0xcd),
        (0x00, 0xcd, 0xcd),
        (0xe5, 0xe5, 0xe5),
        (0x7f, 0x7f, 0x7f),
        (0xff, 0x00, 0x00),
        (0x00, 0xff, 0x00),
        (0xff, 0xff, 0x00),
        (0x5c, 0x5c, 0xff),
        (0xff, 0x00, 0xff),
        (0x00, 0xff, 0xff),
        (0xff, 0xff, 0xff),
    ];
    indexed_cube_rgb(n).unwrap_or_else(|| {
        let (r, g, b) = SYSTEM[usize::from(n)];
        Rgb::new(r, g, b)
    })
}
