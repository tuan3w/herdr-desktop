//! The font size, cell size and content width a pane is drawn at: its columns fill the view's width.

/// The smallest font a pane shrinks to (points); a pane that needs less scrolls sideways.
pub const FLOOR: f32 = 9.0;

/// Text never grows past this multiple of the base size: a 20 column pane in a wide window reads at a comfortable size
/// instead of filling the screen.
pub const CEILING: f32 = 2.0;

/// Row height as a multiple of the font size.
const LINE_RATIO: f32 = 1.4;

/// The measurements a pane is drawn with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    /// Font size in points.
    pub font_size: f32,
    /// Width of one cell.
    pub cell_width: f32,
    /// Height of one row.
    pub line_height: f32,
    /// Width of a row: the pane's columns in cells.
    pub content_width: f32,
    /// Whether a row is wider than the view, so the view scrolls sideways.
    pub scrolls: bool,
}

/// Measures a pane of `cols` columns in a view `width` points wide (0 while unknown). `base` is the font size the app
/// asked for and `cell_ratio` the width of a cell per point of font size (the platform measures it: monospaced text
/// scales linearly).
pub fn plan(base: f32, width: f32, cols: u16, cell_ratio: f32) -> Plan {
    let cols = f32::from(cols.max(1));
    let ratio = cell_ratio.max(f32::EPSILON);
    let font_size = if width > 0.0 {
        (width / (cols * ratio)).clamp(FLOOR.min(base), base * CEILING)
    } else {
        base
    };
    let cell_width = font_size * ratio;
    let content_width = cell_width * cols;
    Plan {
        font_size,
        cell_width,
        line_height: (font_size * LINE_RATIO).round().max(1.0),
        content_width,
        scrolls: width > 0.0 && content_width > width + 0.5,
    }
}

/// How many columns of `cell_width` fit in `width` (at least 1): what `onCells` reports.
pub fn columns_that_fit(width: f32, cell_width: f32) -> u16 {
    if width <= 0.0 || cell_width <= 0.0 {
        return 1;
    }
    (width / cell_width).floor().clamp(1.0, f32::from(u16::MAX)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A typical monospace: a cell is 0.6 em wide.
    const RATIO: f32 = 0.6;

    #[test]
    fn fit_scales_the_font_so_the_columns_fill_the_view() {
        let plan = plan(13.0, 960.0, 100, RATIO);
        assert!((plan.content_width - 960.0).abs() < 0.01, "{plan:?}");
        assert!((plan.font_size - 16.0).abs() < 0.01);
        assert!(!plan.scrolls);
    }

    #[test]
    fn fit_shrinks_to_a_floor_then_scrolls_sideways() {
        let wide = plan(13.0, 400.0, 160, RATIO);
        assert_eq!(wide.font_size, FLOOR, "never below the floor");
        assert!(wide.scrolls);
        assert!(wide.content_width > 400.0);
        let fits = plan(13.0, 900.0, 160, RATIO);
        assert!(fits.font_size > FLOOR && !fits.scrolls, "{fits:?}");
    }

    #[test]
    fn fit_does_not_blow_up_a_narrow_pane() {
        let narrow = plan(13.0, 1600.0, 20, RATIO);
        assert_eq!(narrow.font_size, 13.0 * CEILING);
        assert!(!narrow.scrolls);
    }

    #[test]
    fn a_base_size_under_the_floor_is_the_apps_choice() {
        let tiny = plan(8.0, 100.0, 200, RATIO);
        assert_eq!(tiny.font_size, 8.0);
    }

    #[test]
    fn nothing_is_known_before_the_first_layout() {
        let plan = plan(13.0, 0.0, 80, RATIO);
        assert_eq!(plan.font_size, 13.0);
        assert!(!plan.scrolls);
        assert_eq!(columns_that_fit(0.0, 7.8), 1);
    }

    #[test]
    fn rows_are_taller_than_the_font_and_never_zero() {
        assert_eq!(plan(10.0, 0.0, 10, RATIO).line_height, 14.0);
        assert!(plan(0.1, 0.0, 10, RATIO).line_height >= 1.0);
    }
}
