//! The emulation: libghostty-vt on a thread of its own. See `session.rs` for the handle the app holds.
//!
//! Everything libghostty owns (`Terminal`, `RenderState`, the key and mouse encoders) lives on that thread (its types are
//! `!Send`); the rest of the app talks to it with plain-data messages ([`Input`]) and hears from it through immutable
//! [`Frame`]s. The UI thread never parses, never encodes and never blocks on the program (principle 5 of `AGENTS.md`).

use std::{
    cell::{Cell, RefCell},
    io::{Read, Write},
    rc::Rc,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, bounded, select};
use herdr_core::screen::{Color, Link, LinkKind, Rgb, Row, Run, Style};
use libghostty_vt::{
    RenderState, Terminal, TerminalOptions, focus,
    key::{self, Action, Encoder as KeyEncoder, Key, KittyKeyFlags, Mods},
    mouse::{self, Encoder as MouseEncoder, EncoderSize},
    paste,
    render::{CellIterator, CursorVisualStyle, Dirty, RowIterator},
    screen::CellWide,
    selection::{SelectLineOptions, SelectWordOptions, Selection},
    style::{RgbColor, Underline},
    terminal::{Mode, Point, PointCoordinate, ScrollViewport},
};

use super::{
    frame::{Cursor, CursorShape, Exit, Frame, RowLink, Scroll},
    keys::{Code, KeyInput},
    pty::Pty,
    session::Publisher,
    types::{Button, Colors, Config, Input, MouseKind},
};

enum PtyEvent {
    Data(Vec<u8>),
    /// The program closed its terminal (it has ended, or is about to).
    Closed,
}

/// The shortest time between two frames: a program printing as fast as it can costs the view ~120 updates a second.
const FRAME_GAP: Duration = Duration::from_millis(8);

/// What the callbacks of the terminal write to.
#[derive(Default)]
struct Shared {
    out: RefCell<Vec<u8>>,
    bells: Cell<u64>,
    title: RefCell<Option<Arc<str>>>,
    clipboard: RefCell<Option<Arc<str>>>,
}

fn rgb(c: Rgb) -> RgbColor {
    RgbColor {
        r: c.r,
        g: c.g,
        b: c.b,
    }
}

/// The life of the thread: one loop per program started.
pub(super) fn run(config: Config, rx: Receiver<Input>, publisher: Publisher) {
    let mut config = config;
    let mut revision = 0_u64;
    loop {
        match Emulator::new(&config, &publisher, &mut revision) {
            Some(mut emulator) => {
                if !emulator.serve(&rx, &mut config) {
                    return;
                }
            }
            None => return,
        }
    }
}

struct Emulator<'a> {
    term: Terminal<'static, 'a>,
    render: RenderState<'static>,
    rows_it: RowIterator<'static>,
    cells_it: CellIterator<'static>,
    keys: KeyEncoder<'static>,
    mouse: MouseEncoder<'static>,
    shared: Rc<Shared>,
    pty: Option<Pty>,
    writer: Option<std::fs::File>,
    from_pty: Receiver<PtyEvent>,
    publisher: Publisher,
    revision: &'a mut u64,
    cols: u16,
    rows: u16,
    cell: (u16, u16),
    prev_rows: Vec<Arc<Row>>,
    exit: Option<Exit>,
    dirty: bool,
    last_publish: Instant,
    /// Where a press began selecting, in viewport cells.
    anchor: Option<(u16, u16)>,
    selecting: bool,
    pressed: Option<Button>,
}

impl<'a> Emulator<'a> {
    fn new(config: &Config, publisher: &Publisher, revision: &'a mut u64) -> Option<Emulator<'a>> {
        let shared = Rc::new(Shared::default());
        let launch = &config.launch;
        let mut term = Terminal::new(TerminalOptions {
            cols: launch.cols.max(1),
            rows: launch.rows.max(1),
            max_scrollback: config.scrollback_bytes,
        })
        .ok()?;
        {
            let out = shared.clone();
            term.on_pty_write(move |_, data| out.out.borrow_mut().extend_from_slice(data))
                .ok()?;
            let bells = shared.clone();
            term.on_bell(move |_| bells.bells.set(bells.bells.get() + 1))
                .ok()?;
            let title = shared.clone();
            term.on_title_changed(move |t| {
                if let Ok(text) = t.title() {
                    *title.title.borrow_mut() = Some(Arc::from(text));
                }
            })
            .ok()?;
            let clip = shared.clone();
            term.on_clipboard_write(move |_, write| {
                // The view decides what a program may put on the clipboard; a request to *read* never gets here.
                let mut text = String::new();
                for part in write.contents() {
                    if part.mime.starts_with("text/") {
                        text.push_str(part.data);
                    }
                }
                *clip.clipboard.borrow_mut() = Some(Arc::from(text));
                Ok(())
            })
            .ok()?;
        }
        apply_colors(&mut term, &config.colors);

        let (to_emulator, from_pty) = bounded::<PtyEvent>(32);
        let (pty, writer, exit) = match Pty::spawn(launch) {
            Ok(pty) => {
                let mut reader = pty.file().ok();
                let writer = pty.file().ok();
                if let Some(mut reader) = reader.take() {
                    thread::Builder::new()
                        .name("terminal-read".into())
                        .spawn(move || {
                            let mut buf = vec![0u8; 64 * 1024];
                            loop {
                                match reader.read(&mut buf) {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        if to_emulator
                                            .send(PtyEvent::Data(buf[..n].to_vec()))
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                }
                            }
                            let _ = to_emulator.send(PtyEvent::Closed);
                        })
                        .ok()?;
                }
                (Some(pty), writer, None)
            }
            Err(e) => {
                // Nothing to run: say it in the terminal itself, with the status the shell would give.
                term.vt_write(format!("Could not start the program: {e}\r\n").as_bytes());
                (None, None, Some(Exit::Code(127)))
            }
        };
        let mut emulator = Emulator {
            term,
            render: RenderState::new().ok()?,
            rows_it: RowIterator::new().ok()?,
            cells_it: CellIterator::new().ok()?,
            keys: KeyEncoder::new().ok()?,
            mouse: MouseEncoder::new().ok()?,
            shared,
            pty,
            writer,
            from_pty,
            publisher: publisher.clone(),
            revision,
            cols: launch.cols.max(1),
            rows: launch.rows.max(1),
            cell: launch.cell,
            prev_rows: Vec::new(),
            exit,
            dirty: true,
            last_publish: Instant::now() - FRAME_GAP,
            anchor: None,
            selecting: false,
            pressed: None,
        };
        emulator.set_mouse_size();
        Some(emulator)
    }

    fn set_mouse_size(&mut self) {
        let (cw, ch) = (u32::from(self.cell.0.max(1)), u32::from(self.cell.1.max(1)));
        self.mouse.set_size(EncoderSize {
            screen_width: cw * u32::from(self.cols),
            screen_height: ch * u32::from(self.rows),
            cell_width: cw,
            cell_height: ch,
            padding_top: 0,
            padding_bottom: 0,
            padding_right: 0,
            padding_left: 0,
        });
    }

    /// Runs until the person restarts (true) or the app drops the session (false).
    fn serve(&mut self, rx: &Receiver<Input>, config: &mut Config) -> bool {
        let mut closed_at: Option<Instant> = None;
        loop {
            // Everything the program printed meanwhile, in one go (bounded: input must not starve).
            let mut batch = 0;
            while batch < 64 {
                match self.from_pty.try_recv() {
                    Ok(PtyEvent::Data(data)) => {
                        self.term.vt_write(&data);
                        self.dirty = true;
                        batch += 1;
                    }
                    Ok(PtyEvent::Closed) => {
                        closed_at.get_or_insert_with(Instant::now);
                        break;
                    }
                    Err(_) => break,
                }
            }
            self.flush_out();
            if let Some(at) = closed_at
                && self.exit.is_none()
                && let Some(pty) = self.pty.as_mut()
            {
                let status = pty.try_wait();
                match status {
                    Some(status) => {
                        self.exit = Some(status);
                        self.dirty = true;
                    }
                    // The terminal closed but the program has not: give it a moment, then stop waiting.
                    None if at.elapsed() > Duration::from_secs(2) => {
                        self.exit = Some(Exit::Code(0));
                        self.dirty = true;
                    }
                    None => {}
                }
            }
            if self.dirty && self.last_publish.elapsed() >= FRAME_GAP {
                self.publish();
            }
            let wait = if self.dirty {
                FRAME_GAP.saturating_sub(self.last_publish.elapsed())
            } else if closed_at.is_some() && self.exit.is_none() {
                Duration::from_millis(50)
            } else {
                Duration::from_secs(3600)
            };
            select! {
                recv(rx) -> message => match message {
                    Ok(Input::Restart) => {
                        if let Some(pty) = &self.pty { pty.hang_up(); }
                        return true;
                    }
                    Ok(Input::Colors(colors)) => {
                        config.colors = colors;
                        apply_colors(&mut self.term, &colors);
                        self.prev_rows.clear();
                        self.dirty = true;
                    }
                    Ok(input) => self.input(input),
                    Err(_) => {
                        if let Some(pty) = &self.pty { pty.hang_up(); }
                        return false;
                    }
                },
                recv(self.from_pty) -> event => match event {
                    Ok(PtyEvent::Data(data)) => {
                        self.term.vt_write(&data);
                        self.dirty = true;
                    }
                    Ok(PtyEvent::Closed) => { closed_at.get_or_insert_with(Instant::now); }
                    Err(_) => {}
                },
                default(wait) => {}
            }
        }
    }

    fn flush_out(&mut self) {
        let out = std::mem::take(&mut *self.shared.out.borrow_mut());
        if out.is_empty() {
            return;
        }
        if let Some(writer) = self.writer.as_mut() {
            let _ = writer.write_all(&out);
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.exit.is_some() {
            return;
        }
        if let Some(writer) = self.writer.as_mut() {
            let _ = writer.write_all(bytes);
        }
    }

    fn cell_at(&self, x: f32, y: f32) -> (u16, u16) {
        let (cw, ch) = (f32::from(self.cell.0.max(1)), f32::from(self.cell.1.max(1)));
        let col = (x / cw)
            .floor()
            .clamp(0.0, f32::from(self.cols.saturating_sub(1)));
        let row = (y / ch)
            .floor()
            .clamp(0.0, f32::from(self.rows.saturating_sub(1)));
        (col as u16, row as u16)
    }

    /// Typing and pasting go to the end of the screen, where the program's prompt is, and end a selection.
    fn typed(&mut self) {
        if self.selecting || self.anchor.is_some() {
            let _ = self.term.set_selection(None);
            self.selecting = false;
            self.anchor = None;
        }
        if let Ok(bar) = self.term.scrollbar()
            && bar.offset + bar.len < bar.total
        {
            self.term.scroll_viewport(ScrollViewport::Bottom);
        }
        self.dirty = true;
    }

    fn input(&mut self, input: Input) {
        match input {
            Input::Key(key) => {
                self.typed();
                self.send_key(key, Action::Press, None);
            }
            Input::Text(text) => {
                self.typed();
                let all = self
                    .term
                    .kitty_keyboard_flags()
                    .map(|f| f.contains(KittyKeyFlags::REPORT_ALL))
                    .unwrap_or(false);
                if all {
                    for c in text.chars() {
                        self.send_text_key(c);
                    }
                } else {
                    self.write(text.as_bytes());
                }
            }
            Input::Paste(text) => {
                self.typed();
                let bracketed = self.term.mode(Mode::BRACKETED_PASTE).unwrap_or(false);
                let mut data = text.into_bytes();
                let mut buf = vec![0u8; data.len() + 16];
                let n = match paste::encode(&mut data, bracketed, &mut buf) {
                    Ok(n) => n,
                    Err(libghostty_vt::Error::OutOfSpace { required }) => {
                        buf.resize(required, 0);
                        paste::encode(&mut data, bracketed, &mut buf).unwrap_or(0)
                    }
                    Err(_) => 0,
                };
                self.write(&buf[..n]);
            }
            Input::Resize { cols, rows, cell } => {
                let (cols, rows) = (cols.max(1), rows.max(1));
                if (cols, rows, cell) != (self.cols, self.rows, self.cell) {
                    self.cols = cols;
                    self.rows = rows;
                    self.cell = cell;
                    let _ = self
                        .term
                        .resize(cols, rows, u32::from(cell.0), u32::from(cell.1));
                    if let Some(pty) = &self.pty {
                        let _ = pty.resize(cols, rows, cell);
                    }
                    self.set_mouse_size();
                    self.dirty = true;
                }
            }
            Input::Focus(gained) => {
                if self.term.mode(Mode::FOCUS_EVENT).unwrap_or(false) {
                    let mut buf = [0u8; 8];
                    let event = if gained {
                        focus::Event::Gained
                    } else {
                        focus::Event::Lost
                    };
                    if let Ok(n) = event.encode(&mut buf) {
                        self.write(&buf[..n]);
                    }
                }
            }
            Input::Mouse {
                kind,
                x,
                y,
                clicks,
                shift,
                ctrl,
                alt,
            } => self.mouse_input(kind, x, y, clicks, shift, ctrl, alt),
            Input::Wheel { ticks, x, y, shift } => self.wheel(ticks, x, y, shift),
            Input::ScrollTo(row) => {
                self.term.scroll_viewport(ScrollViewport::Row(row));
                self.dirty = true;
            }
            Input::ScrollEnd => {
                self.term.scroll_viewport(ScrollViewport::Bottom);
                self.dirty = true;
            }
            Input::SelectAll => {
                if let Ok(Some(all)) = self.term.select_all() {
                    let _ = self.term.set_selection(Some(&all));
                    self.selecting = true;
                    self.dirty = true;
                }
            }
            Input::ClearSelection => {
                let _ = self.term.set_selection(None);
                self.selecting = false;
                self.anchor = None;
                self.dirty = true;
            }
            Input::Copy(reply) => {
                let _ = reply.send(self.selected_text());
            }
            Input::Colors(_) | Input::Restart => {}
        }
        self.flush_out();
    }

    fn selected_text(&mut self) -> Option<String> {
        use libghostty_vt::selection::FormatOptions;
        let bytes = self
            .term
            .format_selection_alloc(None, FormatOptions::new().with_trim(true))
            .ok()??;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (!text.is_empty()).then_some(text)
    }

    fn send_key(&mut self, input: KeyInput, action: Action, text: Option<&str>) {
        let Some(key) = ghostty_key(input.code) else {
            return;
        };
        let mut mods = Mods::empty();
        for (held, bit) in [
            (input.mods.shift, Mods::SHIFT),
            (input.mods.ctrl, Mods::CTRL),
            (input.mods.alt, Mods::ALT),
            (input.mods.sup, Mods::SUPER),
        ] {
            if held {
                mods |= bit;
            }
        }
        let Ok(mut event) = key::Event::new() else {
            return;
        };
        event.set_action(action).set_key(key).set_mods(mods);
        // The character the key types, for the encoder to put after an ESC (Alt) or to report (kitty).
        let typed = match (text, input.code) {
            (Some(t), _) => Some(t.to_owned()),
            (None, Code::Char(c)) if !input.mods.ctrl => Some(
                if input.mods.shift {
                    c.to_ascii_uppercase()
                } else {
                    c
                }
                .to_string(),
            ),
            _ => None,
        };
        if let Code::Char(c) = input.code {
            event.set_unshifted_codepoint(c);
        }
        if let Some(t) = typed {
            event.set_utf8(Some(t));
        }
        let mut bytes = Vec::new();
        if self
            .keys
            .set_options_from_terminal(&self.term)
            .encode_to_vec(&event, &mut bytes)
            .is_ok()
        {
            self.write(&bytes);
        }
    }

    fn send_text_key(&mut self, c: char) {
        let Ok(mut event) = key::Event::new() else {
            return;
        };
        event
            .set_action(Action::Press)
            .set_key(Key::Unidentified)
            .set_mods(Mods::empty())
            .set_utf8(Some(c.to_string()));
        let mut bytes = Vec::new();
        if self
            .keys
            .set_options_from_terminal(&self.term)
            .encode_to_vec(&event, &mut bytes)
            .is_ok()
        {
            self.write(&bytes);
        }
    }

    fn tracking(&self) -> bool {
        self.term.is_mouse_tracking().unwrap_or(false)
    }

    fn report_mouse(
        &mut self,
        action: mouse::Action,
        button: Option<mouse::Button>,
        x: f32,
        y: f32,
        mods: Mods,
    ) {
        let Ok(mut event) = mouse::Event::new() else {
            return;
        };
        event
            .set_action(action)
            .set_button(button)
            .set_mods(mods)
            .set_position(mouse::Position { x, y });
        let mut bytes = Vec::new();
        if self
            .mouse
            .set_options_from_terminal(&self.term)
            .encode_to_vec(&event, &mut bytes)
            .is_ok()
        {
            self.write(&bytes);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn mouse_input(
        &mut self,
        kind: MouseKind,
        x: f32,
        y: f32,
        clicks: u32,
        shift: bool,
        ctrl: bool,
        alt: bool,
    ) {
        let mut mods = Mods::empty();
        for (held, bit) in [(shift, Mods::SHIFT), (ctrl, Mods::CTRL), (alt, Mods::ALT)] {
            if held {
                mods |= bit;
            }
        }
        let tracked = self.tracking() && !shift;
        let ghost = |b: Button| match b {
            Button::Left => mouse::Button::Left,
            Button::Right => mouse::Button::Right,
            Button::Middle => mouse::Button::Middle,
        };
        match kind {
            MouseKind::Press(button) => {
                if tracked {
                    self.pressed = Some(button);
                    self.report_mouse(mouse::Action::Press, Some(ghost(button)), x, y, mods);
                } else if button == Button::Left {
                    self.begin_selection(x, y, clicks);
                }
            }
            MouseKind::Release(button) => {
                if tracked || self.pressed == Some(button) {
                    self.pressed = None;
                    if self.tracking() {
                        self.report_mouse(mouse::Action::Release, Some(ghost(button)), x, y, mods);
                    }
                } else if button == Button::Left {
                    self.selecting = self.selecting || self.anchor.is_some();
                    self.anchor = None;
                }
            }
            MouseKind::Motion(button) => {
                if tracked {
                    self.report_mouse(mouse::Action::Motion, button.map(ghost), x, y, mods);
                } else if button == Some(Button::Left) && self.anchor.is_some() {
                    self.drag_selection(x, y);
                }
            }
        }
    }

    fn point(&self, col: u16, row: u16) -> Point {
        Point::Viewport(PointCoordinate {
            x: col,
            y: u32::from(row),
        })
    }

    fn begin_selection(&mut self, x: f32, y: f32, clicks: u32) {
        let (col, row) = self.cell_at(x, y);
        let _ = self.term.set_selection(None);
        self.selecting = false;
        self.anchor = Some((col, row));
        if clicks >= 2 {
            let Ok(grid) = self.term.grid_ref(self.point(col, row)) else {
                return;
            };
            let found = if clicks == 2 {
                self.term.select_word(SelectWordOptions::new(grid))
            } else {
                self.term.select_line(SelectLineOptions::new(grid))
            };
            if let Ok(Some(selection)) = found {
                let _ = self.term.set_selection(Some(&selection));
                self.selecting = true;
            }
        }
        self.dirty = true;
    }

    fn drag_selection(&mut self, x: f32, y: f32) {
        let Some((acol, arow)) = self.anchor else {
            return;
        };
        let (col, row) = self.cell_at(x, y);
        if (col, row) == (acol, arow) && !self.selecting {
            return;
        }
        let (Ok(start), Ok(end)) = (
            self.term.grid_ref(self.point(acol, arow)),
            self.term.grid_ref(self.point(col, row)),
        ) else {
            return;
        };
        let selection = Selection::new(start, end, false);
        if self.term.set_selection(Some(&selection)).is_ok() {
            self.selecting = true;
            self.dirty = true;
        }
    }

    fn wheel(&mut self, ticks: i32, x: f32, y: f32, shift: bool) {
        if ticks == 0 {
            return;
        }
        let up = ticks > 0;
        if self.tracking() && !shift {
            let button = if up {
                mouse::Button::Four
            } else {
                mouse::Button::Five
            };
            for _ in 0..ticks.unsigned_abs().min(20) {
                self.report_mouse(mouse::Action::Press, Some(button), x, y, Mods::empty());
            }
            return;
        }
        let alt_screen = self.term.mode(Mode::ALT_SCREEN_SAVE).unwrap_or(false)
            || self.term.mode(Mode::ALT_SCREEN).unwrap_or(false)
            || self.term.mode(Mode::ALT_SCREEN_LEGACY).unwrap_or(false);
        if alt_screen {
            // The alternate screen has no history: the wheel moves the program's own cursor, as xterm's alternate scroll does.
            let code = if up { Code::Up } else { Code::Down };
            for _ in 0..ticks.unsigned_abs().min(20) * 3 {
                self.send_key(
                    KeyInput {
                        code,
                        mods: Default::default(),
                    },
                    Action::Press,
                    None,
                );
            }
            return;
        }
        // Three rows a tick, as terminals do.
        self.term
            .scroll_viewport(ScrollViewport::Delta(-(ticks as isize) * 3));
        self.dirty = true;
    }

    /// Reads the viewport into a frame and publishes it.
    fn publish(&mut self) {
        self.last_publish = Instant::now();
        self.dirty = false;
        let Some(frame) = self.build_frame() else {
            return;
        };
        self.publisher.publish(frame);
    }

    fn build_frame(&mut self) -> Option<Frame> {
        let snapshot = self.render.update(&self.term).ok()?;
        let full = matches!(snapshot.dirty().ok()?, Dirty::Full)
            || self.prev_rows.len() != usize::from(self.rows);
        let cols = snapshot.cols().ok()?;
        let mut rows: Vec<Arc<Row>> = Vec::with_capacity(usize::from(self.rows));
        let mut pending: Vec<(u16, u16, u16)> = Vec::new();
        let mut text = String::with_capacity(16);
        let mut row_it = self.rows_it.update(&snapshot).ok()?;
        let mut index: u16 = 0;
        while let Some(row) = row_it.next() {
            let dirty = full
                || row.dirty().unwrap_or(true)
                || self.prev_rows.get(usize::from(index)).is_none();
            let raw = row.raw_row().ok();
            let has_link = raw.and_then(|r| r.has_hyperlink().ok()).unwrap_or(false);
            if dirty || has_link {
                let mut runs: Vec<Run> = Vec::new();
                let mut cell_it = self.cells_it.update(row).ok()?;
                let mut col: u16 = 0;
                let mut row_links: Vec<(u16, u16)> = Vec::new();
                while let Some(cell) = cell_it.next() {
                    let raw = cell.raw_cell().ok()?;
                    let wide = raw.wide().unwrap_or(CellWide::Narrow);
                    if matches!(wide, CellWide::SpacerTail | CellWide::SpacerHead) {
                        col += 1;
                        continue;
                    }
                    let n = cell.graphemes_len().unwrap_or(0);
                    text.clear();
                    if n == 0 {
                        text.push(' ');
                    } else {
                        let _ = cell.graphemes_utf8(&mut text);
                        if text.is_empty() {
                            text.push(' ');
                        }
                    }
                    let styled = cell.has_styling().unwrap_or(false);
                    let st = if styled { cell.style().ok() } else { None };
                    let selected = cell.is_selected().unwrap_or(false);
                    let mut style = Style {
                        fg: cell
                            .fg_color()
                            .ok()
                            .flatten()
                            .map(|c| Color::Rgb(c.r, c.g, c.b)),
                        bg: cell
                            .bg_color()
                            .ok()
                            .flatten()
                            .map(|c| Color::Rgb(c.r, c.g, c.b)),
                        ..Style::default()
                    };
                    if let Some(st) = st {
                        style.bold = st.bold;
                        style.dim = st.faint;
                        style.italic = st.italic;
                        style.underline = st.underline != Underline::None;
                        style.strike = st.strikethrough;
                        style.inverse = st.inverse;
                        style.hidden = st.invisible;
                    }
                    if selected {
                        style.inverse = !style.inverse;
                    }
                    if has_link && raw.has_hyperlink().unwrap_or(false) {
                        match row_links.last_mut() {
                            Some((_, end)) if *end == col => {
                                *end = col + if wide == CellWide::Wide { 2 } else { 1 }
                            }
                            _ => row_links
                                .push((col, col + if wide == CellWide::Wide { 2 } else { 1 })),
                        }
                    }
                    match runs.last_mut() {
                        Some(last) if last.style == style => last.text.push_str(&text),
                        _ => runs.push(Run {
                            text: text.clone(),
                            style,
                        }),
                    }
                    col += if wide == CellWide::Wide { 2 } else { 1 };
                }
                // Trailing blanks in the default style are padding, not text.
                while let Some(last) = runs.last_mut() {
                    if last.style.paints_blanks() {
                        break;
                    }
                    let trimmed = last.text.trim_end_matches(' ').len();
                    if trimmed == 0 {
                        runs.pop();
                    } else {
                        last.text.truncate(trimmed);
                        break;
                    }
                }
                let _ = row.set_dirty(false);
                let new = Row::new(runs);
                let shared_row = match self.prev_rows.get(usize::from(index)) {
                    Some(prev) if prev.hash == new.hash && **prev == new => prev.clone(),
                    _ => Arc::new(new),
                };
                rows.push(shared_row);
                pending.extend(
                    row_links
                        .into_iter()
                        .map(|(start, end)| (index, start, end)),
                );
            } else {
                rows.push(self.prev_rows[usize::from(index)].clone());
            }
            index += 1;
        }
        let cursor = if snapshot.cursor_visible().unwrap_or(false) {
            snapshot.cursor_viewport().ok().flatten().map(|v| Cursor {
                col: v.x,
                row: v.y,
                shape: match snapshot
                    .cursor_visual_style()
                    .unwrap_or(CursorVisualStyle::Block)
                {
                    CursorVisualStyle::Bar => CursorShape::Bar,
                    CursorVisualStyle::Underline => CursorShape::Underline,
                    _ => CursorShape::Block,
                },
                blink: snapshot.cursor_blinking().unwrap_or(false),
            })
        } else {
            None
        };
        let _ = snapshot.set_dirty(Dirty::Clean);
        let mut links: Vec<RowLink> = Vec::new();
        for (index, start, end) in pending {
            if let Some(uri) = self.link_at(index, start) {
                links.push(RowLink {
                    row: index,
                    link: Link {
                        text: uri.clone(),
                        row: usize::from(index),
                        start_col: start,
                        end_col: end,
                        kind: LinkKind::Url,
                        target: uri,
                        line: None,
                        col: None,
                    },
                });
            }
        }
        self.prev_rows = rows.clone();
        let bar = self.term.scrollbar().ok()?;
        *self.revision += 1;
        let title: Arc<str> = self
            .shared
            .title
            .borrow()
            .clone()
            .unwrap_or_else(|| Arc::from(""));
        let clipboard = self.shared.clipboard.borrow_mut().take();
        let alt_screen = self.term.mode(Mode::ALT_SCREEN_SAVE).unwrap_or(false)
            || self.term.mode(Mode::ALT_SCREEN).unwrap_or(false)
            || self.term.mode(Mode::ALT_SCREEN_LEGACY).unwrap_or(false);
        Some(Frame {
            rev: *self.revision,
            cols,
            rows,
            links,
            cursor,
            scroll: Scroll {
                total: bar.total as usize,
                offset: bar.offset as usize,
                len: bar.len as usize,
            },
            title,
            bells: self.shared.bells.get(),
            mouse_tracking: self.tracking(),
            alt_screen,
            selection: self.selecting,
            exit: self.exit,
            clipboard,
        })
    }

    /// The target of the hyperlink at a cell of the viewport.
    fn link_at(&self, row: u16, col: u16) -> Option<String> {
        let grid = self.term.grid_ref(self.point(col, row)).ok()?;
        let mut buf = vec![0u8; 2048];
        let n = grid.hyperlink_uri(&mut buf).ok()?;
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n.min(buf.len())]).into_owned())
    }
}

impl Drop for Emulator<'_> {
    fn drop(&mut self) {
        if let Some(pty) = &self.pty {
            pty.hang_up();
        }
    }
}

fn apply_colors(term: &mut Terminal<'_, '_>, colors: &Colors) {
    let _ = term.set_default_fg_color(Some(rgb(colors.fg)));
    let _ = term.set_default_bg_color(Some(rgb(colors.bg)));
    let _ = term.set_default_cursor_color(Some(rgb(colors.fg)));
    if let Ok(mut palette) = term.default_color_palette() {
        for (slot, color) in colors.ansi.iter().enumerate() {
            palette.0[slot] = rgb(*color);
        }
        let _ = term.set_default_color_palette(Some(palette));
    }
}

fn ghostty_key(code: Code) -> Option<Key> {
    Some(match code {
        Code::Char(c) => match c {
            'a'..='z' => [
                Key::A,
                Key::B,
                Key::C,
                Key::D,
                Key::E,
                Key::F,
                Key::G,
                Key::H,
                Key::I,
                Key::J,
                Key::K,
                Key::L,
                Key::M,
                Key::N,
                Key::O,
                Key::P,
                Key::Q,
                Key::R,
                Key::S,
                Key::T,
                Key::U,
                Key::V,
                Key::W,
                Key::X,
                Key::Y,
                Key::Z,
            ][(c as u8 - b'a') as usize],
            '0' => Key::Digit0,
            '1' => Key::Digit1,
            '2' => Key::Digit2,
            '3' => Key::Digit3,
            '4' => Key::Digit4,
            '5' => Key::Digit5,
            '6' => Key::Digit6,
            '7' => Key::Digit7,
            '8' => Key::Digit8,
            '9' => Key::Digit9,
            ' ' => Key::Space,
            '[' => Key::BracketLeft,
            ']' => Key::BracketRight,
            '\\' => Key::Backslash,
            '/' => Key::Slash,
            ';' => Key::Semicolon,
            '\'' => Key::Quote,
            ',' => Key::Comma,
            '.' => Key::Period,
            '-' => Key::Minus,
            '=' => Key::Equal,
            '`' => Key::Backquote,
            _ => return None,
        },
        Code::Enter => Key::Enter,
        Code::Escape => Key::Escape,
        Code::Tab => Key::Tab,
        Code::Backspace => Key::Backspace,
        Code::Delete => Key::Delete,
        Code::Insert => Key::Insert,
        Code::Up => Key::ArrowUp,
        Code::Down => Key::ArrowDown,
        Code::Left => Key::ArrowLeft,
        Code::Right => Key::ArrowRight,
        Code::Home => Key::Home,
        Code::End => Key::End,
        Code::PageUp => Key::PageUp,
        Code::PageDown => Key::PageDown,
        Code::F(n) if (1..=24).contains(&n) => {
            Key::try_from(Key::F1 as u32 + u32::from(n) - 1).ok()?
        }
        Code::F(_) => return None,
    })
}
