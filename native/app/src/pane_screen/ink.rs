//! Terminal colours as drawn: the theme's palette for the first 16 slots, xterm's for the rest,
//! inverse and dim resolved, and every foreground corrected until it is legible on the cell it sits on.

use std::{cell::RefCell, collections::HashMap};

use herdr_core::screen::{Color, Rgb, Style, indexed_cube_rgb, indexed_rgb, min_contrast_fg};

/// How much of a `dim` (SGR 2) foreground remains over its background.
const DIM_STRENGTH: f32 = 0.6;

/// The colours a pane is drawn with: the pane's own ground and ink and the 16 ANSI slots, all from
/// the theme (`term-bg`, `term-fg`, `term-0` to `term-15`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    /// The pane's background, behind every cell without one of its own.
    pub bg: Rgb,
    /// The default text colour.
    pub fg: Rgb,
    /// The ANSI colours, normal then bright.
    pub ansi: [Rgb; 16],
}

impl Palette {
    /// A palette from a token lookup (`"term-3"` and so on). A token the theme does not define falls
    /// back to xterm's colour for that slot (ground and ink: `fallback_bg`, `fallback_fg`), so a theme
    /// without terminal tokens still draws a readable pane.
    pub fn from_tokens(
        lookup: impl Fn(&str) -> Option<Rgb>,
        fallback_bg: Rgb,
        fallback_fg: Rgb,
    ) -> Palette {
        Palette {
            bg: lookup("term-bg").unwrap_or(fallback_bg),
            fg: lookup("term-fg").unwrap_or(fallback_fg),
            ansi: std::array::from_fn(|n| {
                lookup(&format!("term-{n}")).unwrap_or_else(|| indexed_rgb(n as u8))
            }),
        }
    }

    /// The colour of a palette entry or 24-bit value: the first 16 are the theme's, the colour cube
    /// and greys xterm's.
    pub fn rgb(&self, color: Color) -> Rgb {
        match color {
            Color::Rgb(r, g, b) => Rgb::new(r, g, b),
            Color::Indexed(n) => indexed_cube_rgb(n).unwrap_or_else(|| self.ansi[usize::from(n)]),
        }
    }
}

/// What to draw a run with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolved {
    /// The text colour, already corrected for legibility.
    pub fg: Rgb,
    /// The cell background, `None` for the pane's own.
    pub bg: Option<Rgb>,
    /// Not drawn (SGR 8): the text stays in the row for selection and screen readers.
    pub hidden: bool,
}

/// Resolves run styles to colours for one palette and one minimum contrast, remembering the corrected
/// foreground of every (foreground, background) pair it has seen (the correction searches in OKLCH, a
/// screenful of text repeats a handful of pairs).
pub struct Ink {
    palette: Palette,
    ratio: f32,
    corrected: RefCell<HashMap<(Rgb, Rgb), Rgb>>,
}

impl Ink {
    /// An inkwell for `palette`; `ratio` is the WCAG contrast every foreground reaches against its
    /// background (4.5 by default; 1 or less leaves colours as herdr sent them).
    pub fn new(palette: Palette, ratio: f32) -> Ink {
        Ink {
            palette,
            ratio: ratio.clamp(1.0, 21.0),
            corrected: RefCell::new(HashMap::new()),
        }
    }

    /// The colours of a run in `style`. `inverse` swaps text and cell colours (the defaults being the
    /// pane's); `dim` blends the text toward the cell before it is corrected, so dim text stays as
    /// legible as the contrast setting says instead of falling under it.
    pub fn resolve(&self, style: &Style) -> Resolved {
        let fg = style.fg.map(|c| self.palette.rgb(c));
        let bg = style.bg.map(|c| self.palette.rgb(c));
        let (text, cell) = if style.inverse {
            (
                bg.unwrap_or(self.palette.bg),
                Some(fg.unwrap_or(self.palette.fg)),
            )
        } else {
            (fg.unwrap_or(self.palette.fg), bg)
        };
        let behind = cell.unwrap_or(self.palette.bg);
        let text = if style.dim {
            blend(text, behind, DIM_STRENGTH)
        } else {
            text
        };
        Resolved {
            fg: self.legible(text, behind),
            bg: cell,
            hidden: style.hidden,
        }
    }

    fn legible(&self, fg: Rgb, bg: Rgb) -> Rgb {
        if self.ratio <= 1.0 {
            return fg;
        }
        *self
            .corrected
            .borrow_mut()
            .entry((fg, bg))
            .or_insert_with(|| min_contrast_fg(fg, bg, self.ratio))
    }
}

/// `strength` of `over` on top of `under`, per channel.
fn blend(over: Rgb, under: Rgb, strength: f32) -> Rgb {
    let mix =
        |a: u8, b: u8| (f32::from(a) * strength + f32::from(b) * (1.0 - strength)).round() as u8;
    Rgb::new(
        mix(over.r, under.r),
        mix(over.g, under.g),
        mix(over.b, under.b),
    )
}

#[cfg(test)]
mod tests {
    use herdr_core::screen::contrast_ratio;

    use super::*;

    const DARK_BG: Rgb = Rgb::new(0x1a, 0x1b, 0x1c);
    const DARK_FG: Rgb = Rgb::new(0xe0, 0xe0, 0xe0);

    fn dark_palette() -> Palette {
        // Slot 4 is a blue that is too dark for a dark pane; every other slot is plainly legible.
        let mut ansi = [Rgb::new(0xd0, 0xd0, 0xd0); 16];
        ansi[4] = Rgb::new(0x1c, 0x2a, 0x9a);
        ansi[1] = Rgb::new(0xff, 0x60, 0x60);
        Palette {
            bg: DARK_BG,
            fg: DARK_FG,
            ansi,
        }
    }

    fn style(fg: Option<Color>, bg: Option<Color>) -> Style {
        Style {
            fg,
            bg,
            ..Style::default()
        }
    }

    #[test]
    fn the_first_sixteen_colours_come_from_the_theme_and_the_rest_from_xterm() {
        let palette = dark_palette();
        assert_eq!(palette.rgb(Color::Indexed(1)), Rgb::new(0xff, 0x60, 0x60));
        assert_eq!(palette.rgb(Color::Indexed(16)), Rgb::new(0, 0, 0));
        assert_eq!(palette.rgb(Color::Indexed(231)), Rgb::new(255, 255, 255));
        assert_eq!(palette.rgb(Color::Indexed(232)), Rgb::new(8, 8, 8));
        assert_eq!(palette.rgb(Color::Rgb(1, 2, 3)), Rgb::new(1, 2, 3));
    }

    #[test]
    fn a_theme_without_terminal_tokens_still_draws_every_slot() {
        let palette = Palette::from_tokens(|_| None, DARK_BG, DARK_FG);
        assert_eq!((palette.bg, palette.fg), (DARK_BG, DARK_FG));
        assert_eq!(palette.ansi[1], indexed_rgb(1));
        let themed = Palette::from_tokens(
            |name| (name == "term-2").then_some(Rgb::new(1, 2, 3)),
            DARK_BG,
            DARK_FG,
        );
        assert_eq!(themed.ansi[2], Rgb::new(1, 2, 3));
        assert_eq!(themed.ansi[3], indexed_rgb(3));
    }

    #[test]
    fn unreadable_text_is_lifted_to_the_contrast_the_person_asked_for() {
        let ink = Ink::new(dark_palette(), 4.5);
        let drawn = ink.resolve(&style(Some(Color::Indexed(4)), None));
        assert!(contrast_ratio(drawn.fg, DARK_BG) >= 4.5, "{drawn:?}");
        let legible = ink.resolve(&style(Some(Color::Indexed(1)), None));
        assert_eq!(
            legible.fg,
            Rgb::new(0xff, 0x60, 0x60),
            "already legible: untouched"
        );
    }

    #[test]
    fn contrast_is_measured_against_the_cell_the_text_sits_on() {
        let ink = Ink::new(dark_palette(), 4.5);
        // Light text on a light cell: legible on the pane, not on its own background.
        let on_light = ink.resolve(&style(
            Some(Color::Rgb(0xf0, 0xf0, 0xf0)),
            Some(Color::Rgb(0xee, 0xee, 0xee)),
        ));
        assert!(contrast_ratio(on_light.fg, Rgb::new(0xee, 0xee, 0xee)) >= 4.5);
        assert_eq!(on_light.bg, Some(Rgb::new(0xee, 0xee, 0xee)));
    }

    #[test]
    fn a_ratio_of_one_leaves_colours_as_sent() {
        let ink = Ink::new(dark_palette(), 1.0);
        let drawn = ink.resolve(&style(Some(Color::Indexed(4)), None));
        assert_eq!(drawn.fg, Rgb::new(0x1c, 0x2a, 0x9a));
    }

    #[test]
    fn inverse_swaps_text_and_cell_with_the_pane_colours_as_defaults() {
        let ink = Ink::new(dark_palette(), 4.5);
        let selected = Style {
            inverse: true,
            ..Style::default()
        };
        let drawn = ink.resolve(&selected);
        assert_eq!(drawn.bg, Some(DARK_FG), "the cell takes the ink colour");
        assert!(
            contrast_ratio(drawn.fg, DARK_FG) >= 4.5,
            "text takes the ground colour"
        );
        assert!(
            drawn.fg.luminance() < 0.1,
            "and reads as dark on light: {drawn:?}"
        );
    }

    #[test]
    fn dim_text_is_fainter_but_not_below_the_asked_contrast() {
        let ink = Ink::new(dark_palette(), 4.5);
        let dim = Style {
            dim: true,
            ..Style::default()
        };
        let plain = ink.resolve(&Style::default());
        let faint = ink.resolve(&dim);
        assert!(contrast_ratio(faint.fg, DARK_BG) >= 4.5);
        assert!(faint.fg.luminance() <= plain.fg.luminance());

        let off = Ink::new(dark_palette(), 1.0);
        let uncorrected = off.resolve(&dim);
        assert!(
            contrast_ratio(uncorrected.fg, DARK_BG) < contrast_ratio(plain.fg, DARK_BG),
            "with correction off dim is plainly fainter"
        );
    }

    #[test]
    fn hidden_text_is_flagged_not_dropped() {
        let ink = Ink::new(dark_palette(), 4.5);
        let hidden = Style {
            hidden: true,
            ..Style::default()
        };
        assert!(ink.resolve(&hidden).hidden);
        assert!(!ink.resolve(&Style::default()).hidden);
    }
}
