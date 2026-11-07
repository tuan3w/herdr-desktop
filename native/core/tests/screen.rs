//! What a person sees of a pane: rows, colours, links and readable contrast.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use herdr_core::screen::{
    Color, Link, LinkKind, Rgb, Row, Screen, Style, contrast_ratio, detect_links, indexed_cube_rgb,
    indexed_rgb, looks_like_slash_command, min_contrast_fg,
};

fn fixture(name: &str) -> String {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        "screens",
        name,
    ]
    .iter()
    .collect();
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn runs(row: &Row) -> Vec<(&str, Style)> {
    row.runs
        .iter()
        .map(|r| (r.text.as_str(), r.style))
        .collect()
}

fn style(f: impl FnOnce(&mut Style)) -> Style {
    let mut s = Style::default();
    f(&mut s);
    s
}

/// The style of the first run of a one-run row parsed from `ansi`.
fn first_style(ansi: &str) -> Style {
    Screen::parse(ansi, None).rows[0].runs[0].style
}

fn texts(screen: &Screen) -> Vec<String> {
    screen.text_rows()
}

// -- parsing a captured screen ---------------------------------------------------------------

#[test]
fn a_captured_screen_reads_back_as_the_plain_text_capture() {
    let ansi = Screen::parse(&fixture("agent.ansi"), None);
    let text = Screen::parse_text(&fixture("agent.txt"), None);
    assert_eq!(ansi.rows.len(), 19);
    assert_eq!(text.rows.len(), 19);
    for (index, (a, t)) in ansi.rows.iter().zip(&text.rows).enumerate() {
        // The ANSI rows keep coloured padding (a status bar), which the text capture trims.
        assert_eq!(a.text().trim_end(), t.text(), "row {index}");
    }
}

#[test]
fn the_pane_width_survives_trimmed_padding() {
    let screen = Screen::parse(&fixture("agent.ansi"), None);
    assert_eq!(screen.cols, 60);
    assert!(screen.rows.iter().all(|row| row.columns() <= 60));
    // A row that is only padding is empty, not 60 blanks.
    assert!(screen.rows[2].runs.is_empty());
}

#[test]
fn a_24_bit_colour_row_keeps_its_rgb_and_bold() {
    let screen = Screen::parse(&fixture("agent.ansi"), None);
    let title = &screen.rows[0];
    assert_eq!(title.text(), "Demo agent  v0.1");
    assert_eq!(title.runs.len(), 1);
    assert_eq!(
        title.runs[0].style,
        style(|s| {
            s.bold = true;
            s.fg = Some(Color::Rgb(120, 200, 255));
        })
    );
}

#[test]
fn a_background_bar_keeps_its_padding_but_plain_blanks_go() {
    let screen = Screen::parse(&fixture("agent.ansi"), None);
    let bar = &screen.rows[9];
    assert_eq!(bar.columns(), 60);
    assert_eq!(bar.runs.len(), 1);
    assert_eq!(bar.runs[0].style.bg, Some(Color::Rgb(40, 44, 60)));
    assert_eq!(screen.rows[1].text(), "Working directory: ~/scratch/demo");
}

#[test]
fn style_changes_split_runs_and_equal_neighbours_merge() {
    let screen = Screen::parse("a \x1b[1;31mbold-red\x1b[0m tail   \r\n", None);
    let red = style(|s| {
        s.bold = true;
        s.fg = Some(Color::Indexed(1));
    });
    assert_eq!(
        runs(&screen.rows[0]),
        [
            ("a ", Style::default()),
            ("bold-red", red),
            (" tail", Style::default())
        ]
    );

    // The same style set twice in a row is one run.
    let merged = Screen::parse("\x1b[32ma\x1b[32mb\x1b[0m", None);
    assert_eq!(merged.rows[0].runs.len(), 1);
    assert_eq!(merged.rows[0].text(), "ab");
}

#[test]
fn every_sgr_attribute_turns_on_and_off() {
    let screen = Screen::parse(
        "\x1b[1ma\x1b[2mb\x1b[3mc\x1b[4md\x1b[7me\x1b[8mf\x1b[9mg\x1b[22mh\x1b[23mi\x1b[24mj\x1b[27mk\x1b[28ml\x1b[29mm",
        None,
    );
    let flags = |s: &Style| {
        (
            s.bold,
            s.dim,
            s.italic,
            s.underline,
            s.inverse,
            s.hidden,
            s.strike,
        )
    };
    let got: Vec<_> = screen.rows[0]
        .runs
        .iter()
        .map(|r| (r.text.as_str(), flags(&r.style)))
        .collect();
    assert_eq!(
        got,
        [
            ("a", (true, false, false, false, false, false, false)),
            ("b", (true, true, false, false, false, false, false)),
            ("c", (true, true, true, false, false, false, false)),
            ("d", (true, true, true, true, false, false, false)),
            ("e", (true, true, true, true, true, false, false)),
            ("f", (true, true, true, true, true, true, false)),
            ("g", (true, true, true, true, true, true, true)),
            ("h", (false, false, true, true, true, true, true)),
            ("i", (false, false, false, true, true, true, true)),
            ("j", (false, false, false, false, true, true, true)),
            ("k", (false, false, false, false, false, true, true)),
            ("l", (false, false, false, false, false, false, true)),
            ("m", (false, false, false, false, false, false, false)),
        ]
    );
}

#[test]
fn palette_colours_resolve_to_the_right_index_in_every_form() {
    let fg = |code: &str| first_style(&format!("\x1b[{code}mx")).fg;
    let bg = |code: &str| first_style(&format!("\x1b[{code}mx")).bg;
    assert_eq!(fg("30"), Some(Color::Indexed(0)));
    assert_eq!(fg("37"), Some(Color::Indexed(7)));
    assert_eq!(fg("90"), Some(Color::Indexed(8)));
    assert_eq!(fg("97"), Some(Color::Indexed(15)));
    assert_eq!(bg("40"), Some(Color::Indexed(0)));
    assert_eq!(bg("47"), Some(Color::Indexed(7)));
    assert_eq!(bg("100"), Some(Color::Indexed(8)));
    assert_eq!(bg("107"), Some(Color::Indexed(15)));
    assert_eq!(fg("38;5;200"), Some(Color::Indexed(200)));
    assert_eq!(bg("48;5;17"), Some(Color::Indexed(17)));
    assert_eq!(fg("38;2;1;2;3"), Some(Color::Rgb(1, 2, 3)));
    assert_eq!(bg("48;2;4;5;6"), Some(Color::Rgb(4, 5, 6)));
    // Colon form, with and without the colour-space slot.
    assert_eq!(fg("38:5:99"), Some(Color::Indexed(99)));
    assert_eq!(fg("38:2:7:8:9"), Some(Color::Rgb(7, 8, 9)));
    assert_eq!(fg("38:2::7:8:9"), Some(Color::Rgb(7, 8, 9)));
    assert_eq!(fg("31;39"), None);
    assert_eq!(bg("41;49"), None);
}

#[test]
fn a_bad_or_incomplete_colour_changes_nothing_and_swallows_only_its_arguments() {
    // Out of range.
    assert_eq!(
        first_style("\x1b[31m\x1b[38;2;300;0;0mx").fg,
        Some(Color::Indexed(1))
    );
    assert_eq!(
        first_style("\x1b[31m\x1b[38;5;256mx").fg,
        Some(Color::Indexed(1))
    );
    // Truncated arguments leave the colour alone and do not turn `1` into bold.
    assert_eq!(first_style("\x1b[38;2;1mx"), Style::default());
    // The arguments of 38;5 are not read as attributes: `1` here is the palette index.
    let s = first_style("\x1b[38;5;1mx");
    assert_eq!((s.fg, s.bold), (Some(Color::Indexed(1)), false));
    // What follows a complete colour still applies.
    let s = first_style("\x1b[38;2;1;2;3;1mx");
    assert_eq!((s.fg, s.bold), (Some(Color::Rgb(1, 2, 3)), true));
}

#[test]
fn an_empty_or_zero_sgr_resets_everything() {
    let after =
        |reset: &str| Screen::parse(&format!("\x1b[1;31;44mx{reset}y"), None).rows[0].runs[1].style;
    assert_eq!(after("\x1b[m"), Style::default());
    assert_eq!(after("\x1b[0m"), Style::default());
    assert_eq!(after("\x1b[;m"), Style::default());
    // A reset in the middle of a list does not drop what follows it.
    let s = Screen::parse("\x1b[1;0;3mx", None).rows[0].runs[0].style;
    assert_eq!((s.bold, s.italic), (false, true));
}

#[test]
fn underline_off_in_colon_form_is_honoured() {
    let s = first_style("\x1b[4mx\x1b[4:0my");
    assert!(s.underline);
    let screen = Screen::parse("\x1b[4mx\x1b[4:0my", None);
    assert!(!screen.rows[0].runs[1].style.underline);
    assert!(first_style("\x1b[4:3mx").underline);
}

#[test]
fn style_carries_from_row_to_row_like_in_a_terminal() {
    let screen = Screen::parse("\x1b[31mred\r\nstill red\r\n\x1b[0mplain", None);
    let red = Some(Color::Indexed(1));
    assert_eq!(screen.rows[0].runs[0].style.fg, red);
    assert_eq!(screen.rows[1].runs[0].style.fg, red);
    assert_eq!(screen.rows[2].runs[0].style.fg, None);
}

// -- row structure ---------------------------------------------------------------------------

#[test]
fn row_breaks_blank_rows_and_the_final_line_feed() {
    assert_eq!(texts(&Screen::parse("a\r\nb", None)), ["a", "b"]);
    assert_eq!(texts(&Screen::parse("a\nb", None)), ["a", "b"]);
    // A trailing line feed ends the last row; it does not start another.
    assert_eq!(texts(&Screen::parse("a\r\nb\r\n", None)), ["a", "b"]);
    // Blank rows in the middle (and a blank row that is terminated) are rows.
    assert_eq!(
        texts(&Screen::parse("a\r\n\r\nb\r\n\r\n", None)),
        ["a", "", "b", ""]
    );
    // A tail that only holds escape sequences is not a row.
    assert_eq!(texts(&Screen::parse("a\r\n\x1b[0m", None)), ["a"]);
    // A tail of padding is (herdr pads every row, including the last).
    assert_eq!(texts(&Screen::parse("a\r\n    ", None)), ["a", ""]);
    assert!(Screen::parse("", None).rows.is_empty());
}

#[test]
fn a_carriage_return_redraw_keeps_only_the_last_text() {
    assert_eq!(texts(&Screen::parse("10%\r50%\r100%", None)), ["100%"]);
    // CR before LF is a line ending, not a redraw.
    assert_eq!(
        texts(&Screen::parse("done\r\nnext\r\n", None)),
        ["done", "next"]
    );
}

#[test]
fn tabs_are_one_blank_and_other_controls_are_not_text() {
    assert_eq!(
        texts(&Screen::parse("a\tb\x07\x08c\x7fd\u{85}e", None)),
        ["a bcde"]
    );
}

#[test]
fn wide_characters_and_marks_take_their_display_width() {
    let screen = Screen::parse("日本語 e\u{301}\r\nabc", None);
    assert_eq!(screen.rows[0].columns(), 6 + 1 + 1);
    // Padding counts towards the pane width even when it is trimmed.
    let padded = Screen::parse("日本語   \r\nab", None);
    assert_eq!(padded.cols, 9);
    assert_eq!(padded.rows[0].text(), "日本語");
}

#[test]
fn plain_text_rows_have_one_default_run() {
    let screen = Screen::parse_text("one  \ntwo\n\nlast\n", None);
    assert_eq!(texts(&screen), ["one", "two", "", "last"]);
    assert!(
        screen
            .rows
            .iter()
            .all(|row| row.runs.iter().all(|r| r.style == Style::default()))
    );
    // Whatever a text capture contains, escape bytes never reach a row.
    assert_eq!(texts(&Screen::parse_text("a\x1b[31mb\n", None)), ["a[31mb"]);
}

// -- escape sequences that are not styling ---------------------------------------------------

#[test]
fn other_escape_sequences_vanish_without_leaking_text() {
    let cases = [
        "ab\x1b[2J\x1b[Hcd",
        "ab\x1b[?25lcd",
        "ab\x1b[?1049hcd",
        "ab\x1b[>4;2mcd",
        "ab\x1b[1 qcd",
        "ab\x1b]0;window title\x07cd",
        "ab\x1b]8;;https://example.com\x1b\\cd",
        "ab\x1bPq#0;2;0;0;0\x1b\\cd",
        "ab\x1b_Gi=1;payload\x1b\\cd",
        "ab\x1b(Bcd",
        "ab\x1b7cd",
        "ab\x1b=cd",
    ];
    for case in cases {
        assert_eq!(texts(&Screen::parse(case, None)), ["abcd"], "{case:?}");
        assert_eq!(first_style(case), Style::default(), "{case:?}");
    }
}

#[test]
fn truncated_and_malformed_sequences_do_not_leak_or_swallow_rows() {
    // Cut off in the middle of a sequence.
    assert_eq!(texts(&Screen::parse("ab\x1b[38;2;1", None)), ["ab"]);
    assert_eq!(texts(&Screen::parse("ab\x1b[", None)), ["ab"]);
    assert_eq!(texts(&Screen::parse("ab\x1b", None)), ["ab"]);
    // An unterminated OSC or DCS ends with its row; the next row is intact.
    assert_eq!(
        texts(&Screen::parse("ab\x1b]0;never ends\r\ncd\r\nef", None)),
        ["ab", "cd", "ef"]
    );
    assert_eq!(
        texts(&Screen::parse("ab\x1bP1;2|never ends\r\ncd", None)),
        ["ab", "cd"]
    );
    // An escape followed by text keeps the text.
    assert_eq!(texts(&Screen::parse("a\x1b\x1b[1mb", None)), ["ab"]);
    // Far too many parameters are ignored as a whole, never a panic.
    let many = format!("a\x1b[{}mb", vec!["1"; 200].join(";"));
    assert_eq!(texts(&Screen::parse(&many, None)), ["ab"]);
}

#[test]
fn arbitrary_noise_never_panics_and_never_leaves_control_characters_in_rows() {
    let pieces = [
        "a",
        "日",
        "e\u{301}",
        "\x1b",
        "[",
        "]",
        "P",
        "m",
        ";",
        ":",
        "38",
        "2",
        "5",
        "1",
        "0",
        "255",
        "\r",
        "\n",
        "\t",
        "\x07",
        "\x18",
        "\x1b[",
        "\x1b]",
        "\u{9b}",
        "?",
        " ",
        "\u{85}",
        "\u{1f680}",
        "\\",
    ];
    let mut seed = 0x2545_f491_4f6c_dd1d_u64;
    for _ in 0..3000 {
        let mut text = String::new();
        for _ in 0..(seed % 30) + 1 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            text.push_str(pieces[(seed >> 33) as usize % pieces.len()]);
        }
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let screen = Screen::parse(&text, None);
        for row in &screen.rows {
            assert!(row.text().chars().all(|c| !c.is_control()), "{text:?}");
            assert!(
                row.runs.windows(2).all(|w| w[0].style != w[1].style),
                "{text:?}"
            );
        }
    }
}

// -- identity between reads ------------------------------------------------------------------

#[test]
fn unchanged_rows_keep_their_identity_and_a_changed_row_does_not() {
    let first = Screen::parse(&fixture("agent.ansi"), None);

    let again = Screen::parse(&fixture("agent.ansi"), Some(&first));
    assert!(
        first
            .rows
            .iter()
            .zip(&again.rows)
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );

    let edited = fixture("agent.ansi").replace("Working directory", "Working directori");
    let next = Screen::parse(&edited, Some(&first));
    for (index, (a, b)) in first.rows.iter().zip(&next.rows).enumerate() {
        assert_eq!(Arc::ptr_eq(a, b), index != 1, "row {index}");
    }
    assert_ne!(first.rows[1].hash, next.rows[1].hash);
    assert_eq!(first.rows[0].hash, next.rows[0].hash);
}

#[test]
fn a_style_only_change_is_a_change() {
    let first = Screen::parse("\x1b[31mred\r\nsame", None);
    let next = Screen::parse("\x1b[32mred\r\nsame", Some(&first));
    assert!(!Arc::ptr_eq(&first.rows[0], &next.rows[0]));
    assert_ne!(first.rows[0].hash, next.rows[0].hash);
    // The second row has the same text but is now styled by the carried-over colour.
    assert!(!Arc::ptr_eq(&first.rows[1], &next.rows[1]));
}

#[test]
fn rows_are_matched_by_position_so_a_shorter_screen_is_safe() {
    let first = Screen::parse("a\r\nb\r\nc", None);
    let shorter = Screen::parse("a\r\nb", Some(&first));
    assert_eq!(shorter.rows.len(), 2);
    let longer = Screen::parse("a\r\nb\r\nc\r\nd", Some(&first));
    assert_eq!(texts(&longer), ["a", "b", "c", "d"]);
    assert!(Arc::ptr_eq(&first.rows[2], &longer.rows[2]));
}

// -- contrast and palette --------------------------------------------------------------------

const BLACK: Rgb = Rgb::new(0, 0, 0);
const WHITE: Rgb = Rgb::new(255, 255, 255);

#[test]
fn contrast_ratio_matches_wcag() {
    assert!((contrast_ratio(BLACK, WHITE) - 21.0).abs() < 0.01);
    assert!((contrast_ratio(WHITE, BLACK) - 21.0).abs() < 0.01);
    assert!((contrast_ratio(WHITE, WHITE) - 1.0).abs() < 1e-6);
    // The WCAG reference grey: #767676 on white is 4.54:1.
    assert!((contrast_ratio(Rgb::new(0x76, 0x76, 0x76), WHITE) - 4.54).abs() < 0.01);
}

#[test]
fn the_256_colour_cube_and_greys_have_the_xterm_values() {
    assert_eq!(indexed_cube_rgb(16), Some(BLACK));
    assert_eq!(indexed_cube_rgb(17), Some(Rgb::new(0, 0, 95)));
    assert_eq!(indexed_cube_rgb(21), Some(Rgb::new(0, 0, 255)));
    assert_eq!(indexed_cube_rgb(46), Some(Rgb::new(0, 255, 0)));
    assert_eq!(indexed_cube_rgb(196), Some(Rgb::new(255, 0, 0)));
    assert_eq!(indexed_cube_rgb(231), Some(WHITE));
    assert_eq!(indexed_cube_rgb(232), Some(Rgb::new(8, 8, 8)));
    assert_eq!(indexed_cube_rgb(244), Some(Rgb::new(128, 128, 128)));
    assert_eq!(indexed_cube_rgb(255), Some(Rgb::new(238, 238, 238)));
    // The first 16 belong to the theme.
    assert_eq!(indexed_cube_rgb(15), None);
    assert_eq!(indexed_rgb(1), Rgb::new(205, 0, 0));
    assert_eq!(indexed_rgb(12), Rgb::new(92, 92, 255));
    assert_eq!(indexed_rgb(196), Rgb::new(255, 0, 0));
}

#[test]
fn a_readable_colour_is_left_alone_and_ratio_one_turns_correction_off() {
    let fg = Rgb::new(30, 30, 30);
    assert_eq!(min_contrast_fg(fg, WHITE, 4.5), fg);
    let grey = Rgb::new(200, 200, 200);
    assert_eq!(min_contrast_fg(grey, WHITE, 1.0), grey);
    assert_eq!(min_contrast_fg(grey, WHITE, 0.5), grey);
}

#[test]
fn dim_text_is_darkened_on_light_and_lightened_on_dark() {
    let grey = Rgb::new(190, 190, 190);
    let on_light = min_contrast_fg(grey, WHITE, 4.5);
    assert!(contrast_ratio(on_light, WHITE) >= 4.5);
    assert!(on_light.r < grey.r, "{on_light:?}");

    let dark_grey = Rgb::new(50, 50, 50);
    let on_dark = min_contrast_fg(dark_grey, BLACK, 4.5);
    assert!(contrast_ratio(on_dark, BLACK) >= 4.5);
    assert!(on_dark.r > dark_grey.r, "{on_dark:?}");
}

#[test]
fn a_nearly_readable_colour_barely_moves() {
    // #757575 is 4.6:1 on white; a ratio of 4.8 needs only a small step.
    let fg = Rgb::new(0x75, 0x75, 0x75);
    let fixed = min_contrast_fg(fg, WHITE, 4.8);
    assert!(contrast_ratio(fixed, WHITE) >= 4.8);
    assert!(fg.r - fixed.r <= 8, "{fixed:?}");
}

#[test]
fn correction_keeps_the_hue() {
    // Pure blue on black is 2.4:1: it has to get lighter, and it must stay a blue.
    let blue = Rgb::new(0, 0, 255);
    let fixed = min_contrast_fg(blue, BLACK, 4.5);
    assert!(contrast_ratio(fixed, BLACK) >= 4.5);
    assert!(fixed.b > fixed.r && fixed.b > fixed.g, "{fixed:?}");
    // Dark red on black stays red.
    let red = Rgb::new(120, 0, 0);
    let fixed = min_contrast_fg(red, BLACK, 4.5);
    assert!(contrast_ratio(fixed, BLACK) >= 4.5);
    assert!(fixed.r > fixed.g && fixed.r > fixed.b, "{fixed:?}");
}

#[test]
fn the_ratio_is_met_wherever_it_can_be_and_the_best_extreme_is_used_where_it_cannot() {
    let levels = [0u8, 64, 128, 192, 255];
    let mut colours = Vec::new();
    for &r in &levels {
        for &g in &levels {
            for &b in &levels {
                colours.push(Rgb::new(r, g, b));
            }
        }
    }
    for ratio in [3.0f32, 4.5, 7.0] {
        for &bg in &colours {
            let best = contrast_ratio(WHITE, bg).max(contrast_ratio(BLACK, bg));
            for &fg in &colours {
                let fixed = min_contrast_fg(fg, bg, ratio);
                let got = contrast_ratio(fixed, bg);
                if best >= ratio {
                    assert!(
                        got >= ratio,
                        "{fg:?} on {bg:?} at {ratio}: {fixed:?} is {got}"
                    );
                } else {
                    assert!(
                        (got - best).abs() < 0.01,
                        "{fg:?} on {bg:?} at {ratio}: {fixed:?} is {got}, best {best}"
                    );
                }
            }
        }
    }
}

// -- links -----------------------------------------------------------------------------------

/// The expectations in `links.json` were produced by herdr-mobile's Dart detector (whose own
/// tests pin them), so a difference here is a difference from what the phone underlines.
#[test]
fn links_match_the_phones_detector_on_every_recorded_line() {
    let cases: serde_json::Value =
        serde_json::from_str(&fixture("links.json")).expect("links.json");
    let cases = cases.as_array().expect("array");
    assert!(cases.len() > 400);
    let number = |v: &serde_json::Value| v.as_u64().map(|n| u32::try_from(n).expect("small"));
    let mut with_links = 0;
    for case in cases {
        let input = case["input"].as_str().expect("input");
        let expected: Vec<Link> = case["links"]
            .as_array()
            .expect("links")
            .iter()
            .map(|l| Link {
                kind: if l["kind"] == "url" {
                    LinkKind::Url
                } else {
                    LinkKind::Path
                },
                text: l["text"].as_str().expect("text").to_owned(),
                target: l["target"].as_str().expect("target").to_owned(),
                line: number(&l["line"]),
                col: number(&l["column"]),
                row: 0,
                start_col: number(&l["start"])
                    .and_then(|n| u16::try_from(n).ok())
                    .expect("start"),
                end_col: number(&l["end"])
                    .and_then(|n| u16::try_from(n).ok())
                    .expect("end"),
            })
            .collect();
        assert_eq!(detect_links(input), expected, "{input:?}");
        with_links += usize::from(!expected.is_empty());
    }
    assert!(with_links > 200);
}

/// Checks what must hold for any line: ordered, inside the line, and consistent with the text.
fn check_invariants(text: &str, links: &[Link]) {
    let width = unicode_width_of(text);
    let mut previous_end = 0;
    for link in links {
        assert!(link.start_col >= previous_end, "{text:?}: {links:?}");
        assert!(link.end_col > link.start_col, "{text:?}: {links:?}");
        assert!(usize::from(link.end_col) <= width, "{text:?}: {links:?}");
        assert!(link.text.contains(&link.target), "{text:?}: {links:?}");
        assert!(text.contains(&link.text), "{text:?}: {links:?}");
        previous_end = link.end_col;
    }
}

fn unicode_width_of(text: &str) -> usize {
    // Terminals count a cluster, not code points; the helper under test is the same crate the
    // detector uses, so wide and zero-width characters agree by construction. Spell the common
    // cases out so the check does not only restate the implementation.
    text.chars()
        .map(|c| match c {
            '\u{300}'..='\u{36f}' => 0,
            '\u{1100}'..='\u{115f}'
            | '\u{2e80}'..='\u{a4cf}'
            | '\u{ac00}'..='\u{d7a3}'
            | '\u{f900}'..='\u{faff}'
            | '\u{ff00}'..='\u{ff60}'
            | '\u{1f300}'..='\u{1f64f}'
            | '\u{1f680}'..='\u{1f6ff}'
            | '\u{20000}'..='\u{3fffd}' => 2,
            _ => 1,
        })
        .sum()
}

#[test]
fn link_columns_count_cells_not_characters() {
    let cases = [
        ("日本語 /tmp/x.txt", 7, 17),
        ("🚀 src/a.dart", 3, 13),
        ("𠀀 src/a.dart", 3, 13),
        ("a\u{301} src/a.dart", 2, 12),
        ("日本語/ファイル.txt", 0, 19),
        ("ba\u{301}o-ca\u{301}o.md", 0, 10),
        ("日本語 https://x.dev/a", 7, 22),
    ];
    for (input, start, end) in cases {
        let links = detect_links(input);
        assert_eq!(links.len(), 1, "{input:?}");
        assert_eq!(
            (links[0].start_col, links[0].end_col),
            (start, end),
            "{input:?}"
        );
    }
}

#[test]
fn a_position_suffix_is_displayed_but_not_part_of_the_target() {
    let link = &detect_links("src/a.dart:12:5: error")[0];
    assert_eq!(link.kind, LinkKind::Path);
    assert_eq!(
        (link.text.as_str(), link.target.as_str()),
        ("src/a.dart:12:5", "src/a.dart")
    );
    assert_eq!((link.line, link.col), (Some(12), Some(5)));

    // A traceback names the line in words and the displayed link stays the bare path.
    let link = &detect_links("File \"/x/y.py\", line 12")[0];
    assert_eq!(
        (link.text.as_str(), link.target.as_str(), link.line),
        ("/x/y.py", "/x/y.py", Some(12))
    );

    let link = &detect_links("lib/ui/a.dart")[0];
    assert_eq!((link.line, link.col), (None, None));
}

#[test]
fn every_box_and_block_glyph_separates_a_path_from_its_neighbours_and_ends_a_url() {
    for code in 0x2500u32..=0x259f {
        let glyph = char::from_u32(code).expect("box glyph");
        let links = detect_links(&format!("{glyph}src/a.dart{glyph}"));
        assert_eq!(links.len(), 1, "U+{code:x}");
        assert_eq!(links[0].text, "src/a.dart", "U+{code:x}");
        assert_eq!(links[0].start_col, 1, "U+{code:x}");
        let links = detect_links(&format!("https://x.dev/a{glyph}b"));
        assert_eq!(links[0].text, "https://x.dev/a", "U+{code:x}");
    }
}

#[test]
fn only_the_first_2000_units_of_a_row_are_scanned() {
    assert!(detect_links(&format!("{}lib/a.dart", "x ".repeat(1100))).is_empty());
    assert_eq!(
        detect_links(&format!("lib/a.dart {}", "y ".repeat(50_000))).len(),
        1
    );
    assert_eq!(
        detect_links(&format!("{}lib/a.dart", "x ".repeat(900)))[0].start_col,
        1800
    );
}

#[test]
fn hostile_lines_finish_and_keep_the_invariants() {
    let hostile = [
        "lorem ipsum dolor ".repeat(6000),
        "x".repeat(100_000),
        ".".repeat(100_000),
        "/".repeat(100_000),
        ":".repeat(100_000),
        "a@b:".repeat(25_000),
        "a,".repeat(50_000),
        ")".repeat(100_000),
        format!("https://{}", "(".repeat(100_000)),
        "a/b ".repeat(25_000),
        "日本語".repeat(33_000),
        "*".repeat(100_000),
        "a*/b.md ".repeat(12_500),
        "**a/b.md** ".repeat(9000),
        "<x.h>#include ".repeat(7000),
    ];
    for text in &hostile {
        let head: String = text.chars().take(2000).collect();
        check_invariants(&head, &detect_links(text));
    }
}

#[test]
fn random_lines_of_link_like_fragments_keep_the_invariants() {
    let fragments = [
        "src/", "a.dart", ":12", ":5", "(3,4)", "https://", "x.dev", "/", " ", "日本", "│", "(",
        ")", ".", ",", "\"", "*", "~/", "./", "../", "é", "\u{301}", "🚀", "@", "-", "_", "#", "=",
        "[", "]", "README", "line", "File ", ":", "\t", "\u{3000}", "lib/", "b.md", "?", "<", ">",
    ];
    let mut seed = 20_251_003u64;
    let mut next = move |bound: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize % bound
    };
    let mut linked = 0;
    for _ in 0..5000 {
        let text: String = (0..next(14) + 1)
            .map(|_| fragments[next(fragments.len())])
            .collect();
        let links = detect_links(&text);
        linked += links.len();
        check_invariants(&text, &links);
    }
    // Guards against a generator that only makes link-free lines.
    assert!(linked > 500);
}

#[test]
fn slash_commands_are_never_paths() {
    for command in ["/model", "/compact", "/resume"] {
        assert!(looks_like_slash_command(command), "{command}");
        assert!(detect_links(command).is_empty(), "{command}");
    }
    for path in ["/usr/bin/env", "/main.py", "/", "model", "/a.b", ""] {
        assert!(!looks_like_slash_command(path), "{path:?}");
    }
}

#[test]
fn a_screen_reports_each_link_with_its_row() {
    let screen = Screen::parse(&fixture("agent.ansi"), None);
    let links = screen.links();
    assert_eq!(links.iter().map(|l| l.row).collect::<Vec<_>>(), [4, 17, 17]);
    assert_eq!(links[0].target, "src/main.rs");
    let (path, url) = (&links[1], &links[2]);
    assert_eq!((path.row, path.kind), (17, LinkKind::Path));
    assert_eq!(
        (path.target.as_str(), path.line, path.col),
        ("src/main.rs", Some(42), Some(7))
    );
    assert_eq!((path.start_col, path.end_col), (5, 21));
    assert_eq!(
        (url.row, url.kind, url.target.as_str()),
        (17, LinkKind::Url, "https://example.com/docs")
    );
}
