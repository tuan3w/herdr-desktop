//! Fit modes: the font size, cell size and content width a pane is drawn at.

use nsh_core::prelude::*;

/// The smallest font `PaneFit::Width` shrinks to (points); a pane that needs less scrolls sideways.
pub const FLOOR: f32 = 9.0;

/// `PaneFit::Width` never grows text past this multiple of the base size: a 20 column pane in a wide
/// window reads at a comfortable size instead of filling the screen.
pub const CEILING: f32 = 2.0;

/// Row height as a multiple of the font size.
const LINE_RATIO: f32 = 1.4;

/// How the pane's columns meet the width of the view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum PaneFit {
    /// The font scales so the pane's columns fill the width (floor 9 pt: below that the view scrolls
    /// sideways).
    #[default]
    Width,
    /// The given font size; a pane wider than the view scrolls sideways.
    Actual,
    /// The given font size and the pane's rows re-flowed to the columns that fit (the scrollback
    /// with its soft wraps joined, `recent_unwrapped`, is what is shown).
    Wrap,
}

/// The measurements a pane is drawn with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    /// Font size in points.
    pub font_size: f32,
    /// Width of one cell.
    pub cell_width: f32,
    /// Height of one row.
    pub line_height: f32,
    /// Width of a row: the pane's columns (the wrap columns for `PaneFit::Wrap`) in cells.
    pub content_width: f32,
    /// Whether a row is wider than the view, so the view scrolls sideways.
    pub scrolls: bool,
}

/// Measures a pane of `cols` columns in a view `width` points wide (0 while unknown). `base` is the
/// font size the app asked for and `cell_ratio` the width of a cell per point of font size (the
/// platform measures it: monospaced text scales linearly).
pub fn plan(fit: PaneFit, base: f32, width: f32, cols: u16, cell_ratio: f32) -> Plan {
    let cols = f32::from(cols.max(1));
    let ratio = cell_ratio.max(f32::EPSILON);
    let font_size = match fit {
        PaneFit::Width if width > 0.0 => {
            (width / (cols * ratio)).clamp(FLOOR.min(base), base * CEILING)
        }
        _ => base,
    };
    let cell_width = font_size * ratio;
    let columns = match fit {
        // The wrap columns are what fits: the rows are never wider than the view.
        PaneFit::Wrap if width > 0.0 => cols.min((width / cell_width).floor().max(1.0)),
        _ => cols,
    };
    let content_width = cell_width * columns;
    Plan {
        font_size,
        cell_width,
        line_height: (font_size * LINE_RATIO).round().max(1.0),
        content_width,
        scrolls: width > 0.0 && content_width > width + 0.5,
    }
}

/// How many columns of `cell_width` fit in `width` (at least 1): the width a `PaneFit::Wrap` pane is
/// re-flowed to.
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
    fn width_fit_scales_the_font_so_the_columns_fill_the_view() {
        let plan = plan(PaneFit::Width, 13.0, 960.0, 100, RATIO);
        assert!((plan.content_width - 960.0).abs() < 0.01, "{plan:?}");
        assert!((plan.font_size - 16.0).abs() < 0.01);
        assert!(!plan.scrolls);
    }

    #[test]
    fn width_fit_shrinks_to_a_floor_then_scrolls_sideways() {
        let wide = plan(PaneFit::Width, 13.0, 400.0, 160, RATIO);
        assert_eq!(wide.font_size, FLOOR, "never below the floor");
        assert!(wide.scrolls);
        assert!(wide.content_width > 400.0);
        let fits = plan(PaneFit::Width, 13.0, 900.0, 160, RATIO);
        assert!(fits.font_size > FLOOR && !fits.scrolls, "{fits:?}");
    }

    #[test]
    fn width_fit_does_not_blow_up_a_narrow_pane() {
        let narrow = plan(PaneFit::Width, 13.0, 1600.0, 20, RATIO);
        assert_eq!(narrow.font_size, 13.0 * CEILING);
        assert!(!narrow.scrolls);
    }

    #[test]
    fn a_base_size_under_the_floor_is_the_apps_choice() {
        let tiny = plan(PaneFit::Width, 8.0, 100.0, 200, RATIO);
        assert_eq!(tiny.font_size, 8.0);
    }

    #[test]
    fn actual_size_keeps_the_font_and_scrolls_when_wider() {
        let plan = plan(PaneFit::Actual, 13.0, 500.0, 120, RATIO);
        assert_eq!(plan.font_size, 13.0);
        assert!((plan.cell_width - 7.8).abs() < 0.001);
        assert!(plan.scrolls);
        let roomy = super::plan(PaneFit::Actual, 13.0, 1000.0, 120, RATIO);
        assert!(!roomy.scrolls);
    }

    #[test]
    fn wrap_reflows_to_the_columns_that_fit_and_never_scrolls() {
        let plan = plan(PaneFit::Wrap, 13.0, 500.0, 120, RATIO);
        assert_eq!(plan.font_size, 13.0);
        assert!(!plan.scrolls);
        assert!(plan.content_width <= 500.0, "{plan:?}");
        assert_eq!(columns_that_fit(500.0, plan.cell_width), 64);
    }

    #[test]
    fn nothing_is_known_before_the_first_layout() {
        let plan = plan(PaneFit::Width, 13.0, 0.0, 80, RATIO);
        assert_eq!(plan.font_size, 13.0);
        assert!(!plan.scrolls);
        assert_eq!(columns_that_fit(0.0, 7.8), 1);
    }

    #[test]
    fn rows_are_taller_than_the_font_and_never_zero() {
        assert_eq!(
            plan(PaneFit::Actual, 10.0, 100.0, 10, RATIO).line_height,
            14.0
        );
        assert!(plan(PaneFit::Actual, 0.1, 100.0, 10, RATIO).line_height >= 1.0);
    }
}
