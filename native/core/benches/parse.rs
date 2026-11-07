//! Cost of turning a `pane.read format=ansi` dump into rows: `cargo bench --bench parse`.
//!
//! The screen is synthetic: 50 rows padded to 200 columns, with coloured spans, a status bar and
//! prose, shaped like an agent TUI. Each line printed is `<name> ns_per_row=<n>`, the median of
//! several batches, so a script can read the numbers.

use std::hint::black_box;
use std::time::Instant;

use herdr_core::screen::{Rgb, Screen, detect_links, min_contrast_fg};

const ROWS: usize = 50;
const COLS: usize = 200;
const BATCHES: usize = 7;
const ITERATIONS: usize = 400;

/// A 50x200 dump with CRLF row breaks and full-width padding on every row.
fn dump(changed_row: Option<usize>) -> String {
    let mut out = String::new();
    for row in 0..ROWS {
        let body = match row % 5 {
            0 => format!(
                "\x1b[1m\x1b[38;2;120;200;255mHeading {row}\x1b[0m  \x1b[2mdim detail\x1b[0m text after"
            ),
            1 => format!(
                "  \x1b[38;5;244m{row}\x1b[0m  let value = compute({row}); // see src/main.rs:{row}"
            ),
            2 => format!("\x1b[32m+ added line {row}\x1b[0m"),
            3 => format!("\x1b[31m- removed line {row}\x1b[0m"),
            _ => format!("plain prose on row {row} with nothing special about it at all"),
        };
        let body = if changed_row == Some(row) {
            body.replace("row", "ROW")
        } else {
            body
        };
        let visible = strip_len(&body);
        out.push_str(&body);
        if row % 7 == 6 {
            out.push_str("\x1b[48;2;40;44;60m");
            out.push_str(&" ".repeat(COLS - visible));
            out.push_str("\x1b[0m");
        } else {
            out.push_str(&" ".repeat(COLS - visible));
        }
        if row + 1 < ROWS {
            out.push_str("\r\n");
        }
    }
    out
}

/// Printable characters of `s` outside escape sequences.
fn strip_len(s: &str) -> usize {
    let mut n = 0;
    let mut in_escape = false;
    for c in s.chars() {
        match (in_escape, c) {
            (false, '\x1b') => in_escape = true,
            (true, 'm') => in_escape = false,
            (false, _) => n += 1,
            _ => {}
        }
    }
    n
}

/// Median nanoseconds per row of `work`, which handles one whole screen per call.
fn per_row(mut work: impl FnMut()) -> f64 {
    for _ in 0..50 {
        work();
    }
    let mut samples: Vec<f64> = (0..BATCHES)
        .map(|_| {
            let start = Instant::now();
            for _ in 0..ITERATIONS {
                work();
            }
            start.elapsed().as_nanos() as f64 / (ITERATIONS * ROWS) as f64
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    samples[BATCHES / 2]
}

fn report(name: &str, ns: f64) {
    println!("{name:<28} ns_per_row={ns:.0}");
}

fn main() {
    let text = dump(None);
    let edited = dump(Some(20));
    let previous = Screen::parse(&text, None);

    report(
        "parse_cold",
        per_row(|| drop(black_box(Screen::parse(black_box(&text), None)))),
    );
    report(
        "parse_unchanged",
        per_row(|| drop(black_box(Screen::parse(black_box(&text), Some(&previous))))),
    );
    report(
        "parse_one_row_changed",
        per_row(|| {
            drop(black_box(Screen::parse(
                black_box(&edited),
                Some(&previous),
            )))
        }),
    );
    report(
        "links_per_screen",
        per_row(|| drop(black_box(previous.links()))),
    );
    report(
        "detect_links_one_row",
        per_row(|| {
            for _ in 0..ROWS {
                black_box(detect_links(black_box(
                    "  3  let value = compute(3); // see src/main.rs:3",
                )));
            }
        }),
    );
    report(
        "min_contrast_fg",
        per_row(|| {
            for i in 0..ROWS {
                let grey = (i * 4) as u8;
                black_box(min_contrast_fg(
                    Rgb::new(grey, grey, 200),
                    Rgb::new(250, 250, 250),
                    4.5,
                ));
            }
        }),
    );
}
