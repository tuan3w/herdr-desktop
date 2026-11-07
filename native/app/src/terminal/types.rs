//! The plain data a terminal session is started from and spoken to with: no libghostty, no pty, so the view compiles (and
//! says so) in a build without the `terminal` feature.

use std::path::PathBuf;

use crossbeam_channel::Sender;
use herdr_core::screen::Rgb;

use super::keys::KeyInput;

/// What to run and how big its terminal is.
#[derive(Clone, Debug)]
pub struct Launch {
    /// The program and its arguments.
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    /// Pixel size of the cell, for programs that ask (`CSI 16 t`, images).
    pub cell: (u16, u16),
}

/// The colours the program's palette indices resolve to: the app's theme, so a program that asks for "red" gets the red the
/// rest of the app is tuned to (`term-*` tokens, contrast rules and all).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colors {
    pub fg: Rgb,
    pub bg: Rgb,
    /// The 16 ANSI colours, normal then bright.
    pub ansi: [Rgb; 16],
}

/// What a session starts from.
#[derive(Clone, Debug)]
pub struct Config {
    pub launch: Launch,
    /// Scrollback, in bytes of libghostty's page memory (about 2.5 KiB per styled 200-column row: 25 MB is ~10,000 rows).
    pub scrollback_bytes: usize,
    pub colors: Colors,
}

/// A mouse button the view can report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// Mouse activity, in pixels inside the terminal view.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MouseKind {
    Press(Button),
    Release(Button),
    Motion(Option<Button>),
}

/// What the rest of the app can ask of a session.
pub enum Input {
    /// A key the view bound (the program is sent its encoding).
    Key(KeyInput),
    /// Text the person typed or an input method committed.
    Text(String),
    Paste(String),
    Resize {
        cols: u16,
        rows: u16,
        cell: (u16, u16),
    },
    Focus(bool),
    /// Mouse activity: reported to the program when it asked for it, else it selects. `x` and `y` are pixels in the view,
    /// `shift` forces selection even while the program tracks the mouse.
    Mouse {
        kind: MouseKind,
        x: f32,
        y: f32,
        clicks: u32,
        shift: bool,
        ctrl: bool,
        alt: bool,
    },
    /// The wheel: `ticks` > 0 up. Scrolls the history, or is reported (or sent as arrows on the alternate screen).
    Wheel {
        ticks: i32,
        x: f32,
        y: f32,
        shift: bool,
    },
    ScrollTo(usize),
    ScrollEnd,
    SelectAll,
    ClearSelection,
    /// The selected text, answered once.
    Copy(Sender<Option<String>>),
    Colors(Colors),
    /// Starts the program again (after it ended).
    Restart,
}
