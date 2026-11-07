//! Re-flowing rows to a column count: the "Wrap lines" view over `recent_unwrapped` output, where
//! one row is one logical line however long it is.
//!
//! Breaks fall between grapheme clusters at display-width boundaries; each piece keeps the style
//! of its run, so a coloured span that crosses a break is coloured on both rows. Rows are styled
//! [`Row`]s (not text) so colour survives the re-flow.

use std::collections::HashMap;
use std::sync::Arc;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::{Row, Run, Screen};

/// Splits one row into rows of at most `cols` cells. A wide character that does not fit at the
/// end of a row starts the next one, so such a row is one cell short; one that cannot fit anywhere
/// (`cols` is 1) sits alone on a row. A zero-width cluster stays with what is before it.
///
/// A row that fits comes back as the very same `Arc`, and an empty row is one empty row, so a
/// blank line still takes a row. `cols` of 0 is treated as 1.
pub fn wrap_row(row: &Arc<Row>, cols: u16) -> Vec<Arc<Row>> {
    let cols = usize::from(cols.max(1));
    if row.columns() <= cols {
        return vec![Arc::clone(row)];
    }
    let mut rows = Vec::new();
    let mut runs: Vec<Run> = Vec::new();
    let mut used = 0;
    for run in &row.runs {
        let mut piece_start = 0;
        for (at, cluster) in run.text.grapheme_indices(true) {
            let width = cluster.width();
            if width > 0 && used > 0 && used + width > cols {
                if at > piece_start {
                    runs.push(piece(run, piece_start, at));
                }
                rows.push(Arc::new(Row::new(std::mem::take(&mut runs))));
                used = 0;
                piece_start = at;
            }
            used += width;
        }
        if run.text.len() > piece_start {
            runs.push(piece(run, piece_start, run.text.len()));
        }
    }
    if !runs.is_empty() {
        rows.push(Arc::new(Row::new(runs)));
    }
    rows
}

fn piece(run: &Run, start: usize, end: usize) -> Run {
    Run {
        text: run.text[start..end].to_owned(),
        style: run.style,
    }
}

/// Re-flows every row of `screen` to `cols` columns; the result's `cols` is `cols`.
///
/// Rows that fit are the input's `Arc`s. A row that had to be split is looked up among the rows
/// of `prev` (the previous result for the same pane) first, so re-flowing an unchanged
/// `recent_unwrapped` read hands back the same rows instead of new ones that the view would
/// rebind.
pub fn wrap_screen(screen: &Screen, cols: u16, prev: Option<&Screen>) -> Screen {
    let cols = cols.max(1);
    let mut known: Option<HashMap<u64, &Arc<Row>>> = None;
    let mut rows = Vec::with_capacity(screen.rows.len());
    for row in &screen.rows {
        for piece in wrap_row(row, cols) {
            if Arc::ptr_eq(&piece, row) {
                rows.push(piece);
                continue;
            }
            // The same position first: a screen often holds identical rows (a wrapped rule of
            // dashes), and each should keep the identity it had.
            if let Some(old) = prev
                .and_then(|p| p.rows.get(rows.len()))
                .filter(|old| ***old == *piece)
            {
                rows.push(Arc::clone(old));
                continue;
            }
            let known = known.get_or_insert_with(|| {
                prev.map(|p| p.rows.iter().map(|r| (r.hash, r)).collect())
                    .unwrap_or_default()
            });
            match known.get(&piece.hash) {
                Some(old) if ***old == *piece => rows.push(Arc::clone(old)),
                _ => rows.push(piece),
            }
        }
    }
    Screen { cols, rows }
}
