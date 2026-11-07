//! `Terminal`: a program on a pty drawn natively, the keyboard and mouse sent back to it.
//!
//! The drawing follows `PaneScreen` (rows as shared `Arc`s rebound only when they change, per-row background boxes behind
//! text spans, colours from the `term-*` tokens with the contrast rule). What differs: the emulation is a session on its
//! own thread (`session.rs`), the viewport is exactly the rows that fit (libghostty scrolls its own history), a cursor and
//! a selection are drawn, and the view takes the keyboard.
//!
//! **Keyboard.** nsh 0.4.0 has no raw key event. Text arrives in a hidden input (so layouts, dead keys and input methods
//! compose it); every other key is a view-bound keystroke (`keys::bound`), bound only while the terminal has the focus, and a
//! view's binding wins over the app's of the same keystroke: so the program gets what a terminal can encode and the app's
//! own shortcut fires for the rest (`keys::app_owns`).
//!
//! **Wheel and scrollbar.** The only wheel events nsh 0.4.0 gives a view are a scroll view's. A scroll view under the rows,
//! as tall as the history, *is* the scrollbar and the wheel; its offset is the viewport's. While a program tracks the mouse
//! (or the alternate screen is up) the scroll view is a sensor instead: it sits in the middle of a tall box and every scroll
//! away from the middle is a wheel report, then it is put back.

use std::{cell::RefCell, rc::Rc, sync::Arc, time::Duration};

use herdr_core::screen::{Link, LinkKind, Row, detect_links};
use nsh_base::{button, input, theme};
use nsh_core::{
    EllipsizeMode,
    element::measure_text,
    keymap::{Keystroke, Modifiers},
    prelude::*,
};

use super::{
    frame::{CursorShape, Exit, Frame, with_block_cursor},
    keys::{self, KeyInput},
    session::Session,
    types::{Button, Colors, Config, Input, Launch, MouseKind},
};
use crate::pane_screen::{
    adaptive, fill_box, font_css, font_family,
    ink::Ink,
    palette,
    segments::{Segment, fills, segments},
    token_color,
};

/// What a pressed link opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum TerminalLinkKind {
    /// An `http://` or `https://` address (an OSC 8 link may hold other schemes: the app decides).
    Url,
    /// A file path.
    Path,
}

/// A terminal on a pty.
#[derive(Clone, Copy, PartialEq, Props)]
pub struct TerminalProps {
    /// What to run, by `/bin/sh -c`; empty runs `$SHELL` (else `/bin/sh`).
    pub command: Prop<SharedString>,
    /// The folder to start in; empty is the app's own.
    pub cwd: Prop<SharedString>,
    /// What screen readers say the terminal is (`Terminal, <label>`).
    pub label: Prop<SharedString>,
    /// The font family (default the theme's `font-mono`, else the system's monospaced font).
    pub font_family: Prop<Option<SharedString>>,
    /// The font size in points (default 13).
    #[prop(default = 13.0)]
    pub font_size: Prop<f32>,
    /// The WCAG contrast every foreground reaches against its background: 1 leaves the colours as the program sent them
    /// (default 4.5).
    #[prop(default = 4.5)]
    pub min_contrast: Prop<f32>,
    /// Lets a program that asks for a blinking cursor have one. Off by default: a blink is motion with no meaning, and an
    /// app at rest draws no frames. Never blinks while the system asks for reduced motion.
    #[prop(default)]
    pub cursor_blink: Prop<bool>,
    /// The history kept, in bytes of the emulator's page memory (about 2.5 KiB a row: the default is some 6,000 rows).
    #[prop(default = 16_000_000)]
    pub scrollback: Prop<u32>,
    /// Lets a program put text on the clipboard (OSC 52). Off by default: a program must not rewrite what you copied.
    #[prop(default)]
    pub allow_clipboard_write: Prop<bool>,
}

/// The events of a [`Terminal`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TerminalEvent {
    /// The program set the window title (OSC 0 and 2).
    Title(SharedString),
    /// The program rang the bell: the view has already flashed.
    Bell,
    /// The program ended; `Restart` or `restart()` runs it again.
    Exited {
        /// What happened, in words.
        words: SharedString,
        /// Its status; absent when a signal ended it.
        code: Option<i32>,
    },
    /// A link was pressed with Control (Command on a Mac) held.
    Link {
        /// What it opens.
        kind: TerminalLinkKind,
        /// The address or path.
        target: SharedString,
    },
    /// The cells that fit the view changed.
    Cells {
        /// Columns.
        cols: u32,
        /// Rows.
        rows: u32,
    },
    /// The view took or lost the keyboard.
    Focus {
        /// Whether keys now go to the program.
        focused: bool,
    },
    /// A program asked for text to be put on the clipboard (OSC 52). Done only when `allowClipboardWrite` is set.
    Clipboard(SharedString),
}

/// The methods of a [`Terminal`]'s ref.
pub struct TerminalApi {
    focus: Rc<dyn Fn()>,
    restart: Rc<dyn Fn()>,
    text: Rc<dyn Fn() -> String>,
    selection: Rc<dyn Fn() -> Option<String>>,
    send: Rc<dyn Fn(String)>,
    paste: Rc<dyn Fn(String)>,
}

#[methods]
impl TerminalApi {
    /// Gives the terminal the keyboard.
    pub fn focus(&self) {
        (self.focus)();
    }

    /// Runs the program again after it ended.
    pub fn restart(&self) {
        (self.restart)();
    }

    /// What the viewport shows, as plain text, rows separated by newlines. What a test reads.
    pub fn text(&self) -> String {
        (self.text)()
    }

    /// The selected text, if anything is selected.
    pub fn selection(&self) -> Option<String> {
        (self.selection)()
    }

    /// Types `text` as if the person had (what an input method would commit).
    pub fn send(&self, text: String) {
        (self.send)(text);
    }

    /// Pastes `text`: bracketed when the program asked for it.
    pub fn paste(&self, text: String) {
        (self.paste)(text);
    }
}

#[derive(Clone)]
struct FrameRef(Arc<Frame>);

impl PartialEq for FrameRef {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// A session compared by identity.
#[derive(Clone)]
struct SessionRef(Rc<Session>);

impl PartialEq for SessionRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone)]
struct RowRef(Option<Arc<Row>>);

impl PartialEq for RowRef {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

#[derive(Clone)]
struct InkRef(Rc<Ink>);

impl PartialEq for InkRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// A row's pieces and links, made once per row and kept until the row changes.
struct Drawn {
    segments: Vec<Segment>,
}

#[derive(Clone)]
struct DrawnRef(Rc<Drawn>);

impl PartialEq for DrawnRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// How tall the box is that a scroll view needs around its middle to be a wheel sensor (points).
const SENSOR_SPAN: f32 = 4000.0;

/// What the cursor looks like to the view.
#[derive(Clone, Copy, PartialEq)]
struct CursorView {
    col: u16,
    row: u16,
    shape: CursorShape,
    blink: bool,
}

fn shell() -> Vec<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_owned());
    vec![shell]
}

fn to_colors(p: &crate::pane_screen::ink::Palette) -> Colors {
    Colors {
        fg: p.fg,
        bg: p.bg,
        ansi: p.ansi,
    }
}

/// The links of a row: OSC 8 first, then the plain addresses and paths that do not overlap one.
fn row_links(row: &Row, osc8: &[Link]) -> Vec<Link> {
    let mut links: Vec<Link> = osc8.to_vec();
    for found in detect_links(&row.text()) {
        if !links
            .iter()
            .any(|l| l.start_col < found.end_col && found.start_col < l.end_col)
        {
            links.push(found);
        }
    }
    links.sort_by_key(|l| l.start_col);
    links
}

/// A program on a pty.
#[component(methods = TerminalApi)]
pub fn Terminal(props: TerminalProps, cx: Scope<TerminalEvent>) -> impl IntoElement {
    let (width, height) = (signal(0.0_f32), signal(0.0_f32));
    let frame = signal(FrameRef(Arc::new(Frame::default())));
    let focused = signal(false);
    let flash = signal(false);
    let blink_on = signal(true);
    let pointer = signal((0.0_f32, 0.0_f32));
    let session: Signal<Option<SessionRef>> = signal(None);
    let sink = element_ref();
    let scroll_ref = element_ref();
    // Where the scroll view was last put by the view itself: its next event at that offset is ours, not the person's.
    let placed = signal(f32::NAN);
    let sink_value = signal(String::new());
    let held: Rc<RefCell<(String, Option<String>)>> = Rc::new(RefCell::new((String::new(), None)));

    // The font: its cell width per point of size is measured once per family (monospaced text scales linearly).
    let family = move || font_family(props.font_family.get());
    let cell_ratio = computed(move || {
        let css = font_css(&family(), 100.0);
        measure_text(&css, "0000000000").0 / 10.0 / 100.0
    });
    let cell_width = computed(move || props.font_size.get() * cell_ratio.get());
    let line_height = computed(move || (props.font_size.get() * 1.4).round().max(1.0));
    let cols = computed(move || {
        (width.get() / cell_width.get().max(1.0))
            .floor()
            .clamp(1.0, 500.0) as u16
    });
    let rows = computed(move || {
        (height.get() / line_height.get().max(1.0))
            .floor()
            .clamp(1.0, 300.0) as u16
    });
    let cell_px = move || {
        (
            cell_width.get().round().max(1.0) as u16,
            line_height.get() as u16,
        )
    };

    let pal = computed(palette);
    let ink = computed(move || InkRef(Rc::new(Ink::new(pal.get(), props.min_contrast.get()))));

    // Start the program once the view knows its size, then follow the size.
    effect(move || {
        let (w, h) = (width.get(), height.get());
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let (c, r, cell) = (cols.get(), rows.get(), cell_px());
        let existing = session.get_untracked();
        match existing {
            Some(SessionRef(s)) => {
                s.send(Input::Resize {
                    cols: c,
                    rows: r,
                    cell,
                });
                cx.emit(TerminalEvent::Cells {
                    cols: u32::from(c),
                    rows: u32::from(r),
                });
            }
            None => {
                let command = props.command.get_untracked();
                let cwd = props.cwd.get_untracked();
                let argv = if command.is_empty() {
                    shell()
                } else {
                    vec!["/bin/sh".to_owned(), "-c".to_owned(), command.to_string()]
                };
                let started = Rc::new(Session::start(Config {
                    launch: Launch {
                        argv,
                        cwd: (!cwd.is_empty()).then(|| cwd.to_string().into()),
                        cols: c,
                        rows: r,
                        cell,
                    },
                    scrollback_bytes: props.scrollback.get_untracked() as usize,
                    colors: to_colors(&pal.get_untracked()),
                }));
                let wake = started.frames();
                let watching = started.clone();
                session.set(Some(SessionRef(started)));
                frame.set(FrameRef(watching.frame()));
                spawn(async move {
                    let (mut title, mut bells, mut exited) =
                        (Arc::<str>::from(""), 0_u64, None::<Exit>);
                    while wake.recv().await.is_ok() {
                        let next = watching.frame();
                        if next.title != title {
                            title = next.title.clone();
                            cx.emit(TerminalEvent::Title(title.to_string().into()));
                        }
                        if next.bells > bells {
                            bells = next.bells;
                            flash.set(true);
                            set_timeout(Duration::from_millis(160), move || flash.set(false));
                            cx.emit(TerminalEvent::Bell);
                        }
                        if next.exit != exited {
                            exited = next.exit;
                            if let Some(exit) = exited {
                                cx.emit(TerminalEvent::Exited {
                                    words: exit.words().into(),
                                    code: match exit {
                                        Exit::Code(code) => Some(code),
                                        Exit::Signal(_) => None,
                                    },
                                });
                            }
                        }
                        if let Some(text) = &next.clipboard {
                            if props.allow_clipboard_write.get_untracked() {
                                set_clipboard(text.to_string());
                            }
                            cx.emit(TerminalEvent::Clipboard(text.to_string().into()));
                        }
                        frame.set(FrameRef(next));
                    }
                });
            }
        }
    });

    // The theme changed: the program's palette follows it.
    effect(move || {
        let colors = to_colors(&pal.get());
        if let Some(SessionRef(s)) = session.get_untracked() {
            s.send(Input::Colors(colors));
        }
    });

    // Focus in and out: reported to programs that asked for it, and to the app.
    effect(move || {
        let on = focused.get();
        if let Some(SessionRef(s)) = session.get_untracked() {
            s.send(Input::Focus(on));
        }
        cx.emit(TerminalEvent::Focus { focused: on });
    });

    // A blinking cursor only while focused, asked for by the program, allowed by the app and by reduced motion.
    let blinking = computed(move || {
        props.cursor_blink.get()
            && !reduce_motion()
            && focused.get()
            && frame.with(|f| f.0.cursor.is_some_and(|c| c.blink))
    });
    effect(move || {
        blink_on.set(true);
        if !blinking.get() {
            return;
        }
        let tick = set_interval(Duration::from_millis(530), move || {
            blink_on.update(|on| *on = !*on)
        });
        cleanup(move || drop(tick));
    });

    let send = move |input: Input| {
        if let Some(SessionRef(s)) = session.get_untracked() {
            s.send(input);
        }
    };
    let apple = apple_keys();
    let key = move |k: KeyInput| send(Input::Key(k));

    // The keys the program takes, while the view has the keyboard. Each is bound once per focus; the ones the host keeps for
    // itself (Ctrl+Q, F11) cannot be bound and are skipped.
    effect(move || {
        if !focused.get() {
            return;
        }
        let os = os();
        let options = KeyOptions {
            when: nsh_core::keymap::When::Always,
            repeat: true,
        };
        for stroke in keys::bound(apple) {
            let Some(parsed) = keys::parse(&stroke, apple) else {
                continue;
            };
            match Keystroke::parse_with(&stroke, apple) {
                Ok(k) if k.reserved(os).is_none() => {}
                _ => continue,
            }
            on_key_with(&stroke, options, move |_| key(parsed));
        }
        // Copy and paste, the terminal's way. Ctrl+C copies only while something is selected, else it is the program's
        // interrupt; Ctrl+Shift+C and Ctrl+Shift+V (Command+C and V on a Mac) always are copy and paste.
        let copy = move || {
            if let Some(SessionRef(s)) = session.get_untracked()
                && let Some(text) = s.selection()
            {
                set_clipboard(text);
                s.send(Input::ClearSelection);
                return true;
            }
            false
        };
        let paste = move || {
            spawn(async move {
                let text = clipboard_string().await;
                if !text.is_empty() {
                    send(Input::Paste(text));
                }
            });
        };
        let page = move |up: bool| {
            let f = frame.get_untracked().0;
            let rows = f.scroll.len.max(1);
            let to = if up {
                f.scroll.offset.saturating_sub(rows.saturating_sub(1))
            } else {
                f.scroll.offset + rows.saturating_sub(1)
            };
            send(Input::ScrollTo(to));
        };
        if apple {
            on_key_with("mod+c", options, move |_| {
                copy();
            });
            on_key_with("mod+v", options, move |_| paste());
        } else {
            on_key_with("ctrl+c", options, move |_| {
                if !copy() {
                    key(KeyInput {
                        code: keys::Code::Char('c'),
                        mods: keys::Mods {
                            ctrl: true,
                            ..Default::default()
                        },
                    });
                }
            });
            on_key_with("ctrl+shift+c", options, move |_| {
                copy();
            });
            on_key_with("ctrl+shift+v", options, move |_| paste());
            on_key_with("shift+insert", options, move |_| paste());
        }
        on_key_with("shift+pageup", options, move |_| page(true));
        on_key_with("shift+pagedown", options, move |_| page(false));
        on_key_with("shift+home", options, move |_| send(Input::ScrollTo(0)));
        on_key_with("shift+end", options, move |_| send(Input::ScrollEnd));
    });

    // Text typed or committed by an input method: the hidden input reports it; the platform reports the text it held with
    // what was typed before it emptied the value, so what is new is what follows what was held.
    let typed = {
        let held = held.clone();
        move |text: &str| {
            let new = {
                let mut held = held.borrow_mut();
                let base = match held.1.take() {
                    Some(old) if text != old && text.starts_with(old.as_str()) => old,
                    Some(_) => String::new(),
                    None => std::mem::take(&mut held.0),
                };
                let new = text.strip_prefix(base.as_str()).unwrap_or(text).to_owned();
                if !text.is_empty() {
                    held.1 = Some(text.to_owned());
                }
                new
            };
            if !new.is_empty() {
                send(Input::Text(new));
            }
            if !text.is_empty() {
                sink_value.set(String::new());
            }
        }
    };

    // The scroll view: the history's scrollbar and wheel, or a wheel sensor (see the module docs).
    let sensing = computed(move || frame.with(|f| f.0.mouse_tracking || f.0.alt_screen));
    let content_height = computed(move || {
        let lh = line_height.get();
        if sensing.get() {
            height.get() + SENSOR_SPAN
        } else {
            let total = frame
                .with(|f| f.0.scroll.total)
                .max(usize::from(rows.get()));
            total as f32 * lh
        }
    });
    // Put the scroll view where the viewport is (or in the middle of the sensor) whenever either moves.
    effect(move || {
        let lh = line_height.get();
        let target = if sensing.get() {
            SENSOR_SPAN / 2.0
        } else {
            frame.with(|f| f.0.scroll.offset) as f32 * lh
        };
        let _ = content_height.get();
        placed.set(target);
        scroll_ref.scroll_to_offset(Points(target), false);
    });
    let scrolled = move |offset: f32| {
        let lh = line_height.get_untracked().max(1.0);
        let mine = placed.get_untracked();
        if mine.is_finite() && (offset - mine).abs() < 0.5 {
            return;
        }
        if sensing.get_untracked() {
            // Away from the middle: wheel ticks, then back to the middle. A tick is three rows of travel.
            let ticks = ((SENSOR_SPAN / 2.0 - offset) / (lh * 3.0)).round() as i32;
            if ticks != 0 {
                let (x, y) = pointer.get_untracked();
                send(Input::Wheel {
                    ticks,
                    x,
                    y,
                    shift: false,
                });
            }
            placed.set(SENSOR_SPAN / 2.0);
            scroll_ref.scroll_to_offset(Points(SENSOR_SPAN / 2.0), false);
        } else {
            let row = (offset / lh).round().max(0.0) as usize;
            if row != frame.with_untracked(|f| f.0.scroll.offset) {
                send(Input::ScrollTo(row));
            }
        }
    };

    let modifiers = move |m: Modifiers| (m.shift, m.ctrl || (apple && m.cmd), m.alt);
    let link_at = move |x: f32, y: f32| -> Option<Link> {
        let (cw, lh) = (
            cell_width.get_untracked().max(1.0),
            line_height.get_untracked().max(1.0),
        );
        let (col, row) = (
            (x / cw).floor().max(0.0) as u16,
            (y / lh).floor().max(0.0) as usize,
        );
        let f = frame.get_untracked().0;
        let r = f.rows.get(row)?;
        let osc8: Vec<Link> = f
            .links
            .iter()
            .filter(|l| usize::from(l.row) == row)
            .map(|l| l.link.clone())
            .collect();
        row_links(r, &osc8)
            .into_iter()
            .find(|l| l.start_col <= col && col < l.end_col)
    };
    let press_down = {
        move |e: &PressEvent| {
            sink.focus();
            pointer.set((e.position.x.0, e.position.y.0));
            let (shift, ctrl, alt) = modifiers(e.modifiers);
            if ctrl
                && !alt
                && let Some(link) = link_at(e.position.x.0, e.position.y.0)
            {
                cx.emit(TerminalEvent::Link {
                    kind: match link.kind {
                        LinkKind::Url => TerminalLinkKind::Url,
                        LinkKind::Path => TerminalLinkKind::Path,
                    },
                    target: link.target.clone().into(),
                });
                return;
            }
            send(Input::Mouse {
                kind: MouseKind::Press(Button::Left),
                x: e.position.x.0,
                y: e.position.y.0,
                clicks: e.clicks,
                shift,
                ctrl,
                alt,
            });
        }
    };
    let press_up = move |e: &PressEvent| {
        let (shift, ctrl, alt) = modifiers(e.modifiers);
        send(Input::Mouse {
            kind: MouseKind::Release(Button::Left),
            x: e.position.x.0,
            y: e.position.y.0,
            clicks: e.clicks,
            shift,
            ctrl,
            alt,
        });
    };
    let moved = move |e: &MouseEvent| {
        pointer.set((e.position.x.0, e.position.y.0));
        let (shift, ctrl, alt) = modifiers(e.modifiers);
        let button = e.pressed_button.map(|b| match b {
            MouseButton::Right => Button::Right,
            MouseButton::Middle => Button::Middle,
            _ => Button::Left,
        });
        // A bare hover is only worth telling a program that tracks every motion; a drag is worth telling everyone.
        if button.is_none() && !frame.with_untracked(|f| f.0.mouse_tracking) {
            return;
        }
        send(Input::Mouse {
            kind: MouseKind::Motion(button),
            x: e.position.x.0,
            y: e.position.y.0,
            clicks: 1,
            shift,
            ctrl,
            alt,
        });
    };

    cx.methods(TerminalApi {
        focus: Rc::new(move || sink.focus()),
        restart: Rc::new(move || send(Input::Restart)),
        text: Rc::new(move || frame.get_untracked().0.text()),
        selection: Rc::new(move || session.get_untracked().and_then(|s| s.0.selection())),
        send: Rc::new(move |text| send(Input::Text(text))),
        paste: Rc::new(move |text| send(Input::Paste(text))),
    });

    let row_count = computed(move || frame.with(|f| f.0.rows.len()));
    let body = dynamic(move || {
        let n = row_count.get();
        let rows: Vec<AnyElement> = (0..n)
            .map(|i| {
                terminal_row(frame, focused, blink_on, ink, cell_width, line_height, i)
                    .into_element()
            })
            .collect();
        view()
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .pointer_events(PointerEvents::None)
            .children(rows)
    });

    let cursor = computed(move || {
        frame.with(|f| {
            f.0.cursor.map(|c| CursorView {
                col: c.col,
                row: c.row,
                shape: c.shape,
                blink: c.blink,
            })
        })
    });
    let cursor_overlay = move || {
        let c = cursor.get()?;
        let (cw, lh) = (cell_width.get(), line_height.get());
        let focused = focused.get();
        if focused && c.shape == CursorShape::Block {
            // Drawn into the row itself: the cell is inverted.
            return None;
        }
        if focused && !blink_on.get() {
            return None;
        }
        let (x, y) = (cw * f32::from(c.col), lh * f32::from(c.row));
        let overlay = view().absolute().pointer_events(PointerEvents::None);
        Some(if !focused {
            // Not the keyboard's: an outline, so it is clear where the program is without claiming the keys.
            overlay
                .left(Length::from(Points(x)))
                .top(Length::from(Points(y)))
                .w(Length::from(Points(cw)))
                .h(Length::from(Points(lh)))
                .border_1()
                .border_color(move || token_color("term-fg", || theme().foreground))
                .into_element()
        } else if c.shape == CursorShape::Bar {
            overlay
                .left(Length::from(Points(x)))
                .top(Length::from(Points(y)))
                .w(px(2.0))
                .h(Length::from(Points(lh)))
                .bg(move || token_color("term-fg", || theme().foreground))
                .into_element()
        } else {
            overlay
                .left(Length::from(Points(x)))
                .top(Length::from(Points(y + lh - 2.0)))
                .w(Length::from(Points(cw)))
                .h(px(2.0))
                .bg(move || token_color("term-fg", || theme().foreground))
                .into_element()
        })
    };

    let exit_bar = move || {
        let exit = frame.with(|f| f.0.exit)?;
        Some(
            view()
                .role(AccessibilityRole::Alert)
                .label(SharedString::from(exit.words()))
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .flex_row()
                .items_center()
                .gap_3()
                .px_3()
                .py_2()
                .border_t(px(1.0))
                .border_t_color(move || theme().border)
                .bg(move || theme().popover)
                .child(
                    text(exit.words())
                        .flex_1()
                        .text_color(move || theme().popover_foreground),
                )
                .child(
                    button()
                        .accessibility_label("Restart")
                        .on_press(move || send(Input::Restart))
                        .px_3()
                        .min_h(px(28.0))
                        .items_center()
                        .justify_center()
                        .rounded_md()
                        .border_1()
                        .border_color(move || theme().border)
                        .bg(move || theme().primary)
                        .text_color(move || theme().primary_foreground)
                        .child(text("Restart").font_weight(FontWeight::SEMIBOLD)),
                )
                .into_element(),
        )
    };

    let hidden_input = input()
        .element_ref(&sink)
        .absolute()
        .left_0()
        .bottom_0()
        .w(px(1.0))
        .h(move || Length::from(Points(line_height.get())))
        .pointer_events(PointerEvents::None)
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        .opacity(0.02)
        .caret(false)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .paste_behavior(PasteBehavior::Report)
        .value(move || sink_value.get())
        .label(move || SharedString::from(format!("Terminal input, {}", props.label.get())))
        .on_change(move |text: &str| typed(text))
        .on_paste(move |p: &PasteEvent| {
            let text = p.text.replace("\r\n", "\r").replace('\n', "\r");
            send(Input::Paste(text));
        })
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false));

    view()
        .role(AccessibilityRole::Group)
        .label(move || SharedString::from(format!("Terminal, {}", props.label.get())))
        .flex_1()
        .min_h(px(0.0))
        .min_w(px(0.0))
        .overflow_hidden()
        .bg(move || token_color("term-bg", || theme().background))
        .font_family(move || font_family(props.font_family.get()))
        .text_size(move || Length::from(Points(props.font_size.get())))
        .text_color(move || token_color("term-fg", || theme().foreground))
        .on_layout(move |b: &Bounds<Points>| {
            width.set(b.size.width.0);
            height.set(b.size.height.0);
        })
        .on_press_down(press_down)
        .on_press_up(press_up)
        .on_mouse_move(moved)
        .child(
            scroll()
                .element_ref(&scroll_ref)
                .size_full()
                .on_scroll(move |e: &ScrollEvent| scrolled(e.offset.y.0))
                .child(
                    view()
                        .h(move || Length::from(Points(content_height.get())))
                        .w_full(),
                ),
        )
        .child(body)
        .child(dynamic(cursor_overlay))
        .child(when(
            move || flash.get(),
            || {
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .pointer_events(PointerEvents::None)
                    .bg(move || token_color("term-fg", || theme().foreground))
                    .opacity(0.18_f32)
            },
        ))
        .child(when(
            move || focused.get(),
            || {
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .pointer_events(PointerEvents::None)
                    .border_2()
                    .border_color(move || token_color("ring", || theme().primary))
            },
        ))
        .child(dynamic(exit_bar))
        .child(hidden_input)
}

/// Row `i` of the viewport: the cells' backgrounds, then the text, the cursor block inverted into it.
fn terminal_row(
    frame: Signal<FrameRef>,
    focused: Signal<bool>,
    blink_on: Signal<bool>,
    ink: Memo<InkRef>,
    cell_width: Memo<f32>,
    line_height: Memo<f32>,
    i: usize,
) -> impl IntoElement {
    let row = computed(move || RowRef(frame.with(|f| f.0.rows.get(i).cloned())));
    let block = computed(move || {
        frame.with(|f| {
            f.0.cursor
                .filter(|c| usize::from(c.row) == i && c.shape == CursorShape::Block)
                .map(|c| c.col)
        })
    });
    let links = computed(move || {
        frame.with(|f| {
            f.0.links
                .iter()
                .filter(|l| usize::from(l.row) == i)
                .map(|l| l.link.clone())
                .collect::<Vec<_>>()
        })
    });
    let drawn = computed(move || {
        let mut row = row.get().0;
        if let (Some(col), true, true) = (block.get(), focused.get(), blink_on.get()) {
            row = Some(Arc::new(with_block_cursor(
                row.as_deref().unwrap_or(&Row::new(vec![])),
                col,
            )));
        }
        let osc8 = links.get();
        let found = row
            .as_ref()
            .map(|r| row_links(r, &osc8))
            .unwrap_or_default();
        let segments = row
            .as_ref()
            .map(|r| segments(r, &found))
            .unwrap_or_default();
        DrawnRef(Rc::new(Drawn { segments }))
    });
    let backgrounds = dynamic(move || {
        let (drawn, ink, cw) = (drawn.get().0, ink.get().0, cell_width.get());
        let boxes: Vec<AnyElement> = fills(&drawn.segments, |style| ink.resolve(style).bg)
            .into_iter()
            .map(|fill| fill_box(fill, cw))
            .collect();
        view()
            .absolute()
            .top_0()
            .bottom_0()
            .left_0()
            .right_0()
            .pointer_events(PointerEvents::None)
            .children(boxes)
    });
    let line = dynamic(move || {
        let (drawn, ink) = (drawn.get().0, ink.get().0);
        let spans: Vec<AnyElement> = drawn
            .segments
            .iter()
            .map(|segment| span(segment, &ink.resolve(&segment.style)))
            .collect();
        text("")
            .number_of_lines(1u32)
            .text_overflow(EllipsizeMode::Clip)
            .children(spans)
    });
    view()
        .h(move || Length::from(Points(line_height.get())))
        .justify_center()
        .child(backgrounds)
        .child(line)
}

/// One styled piece of a row; a link is underlined (it opens with Control held, never on a plain press: that is the
/// program's or the selection's).
fn span(segment: &Segment, colors: &crate::pane_screen::ink::Resolved) -> AnyElement {
    let style = &segment.style;
    let mut piece = text(segment.text.clone()).text_color(adaptive(colors.fg));
    if style.bold {
        piece = piece.font_weight(FontWeight::BOLD);
    }
    if style.italic {
        piece = piece.italic();
    }
    if style.underline || segment.link.is_some() {
        piece = piece.underline();
    }
    if style.strike {
        piece = piece.line_through();
    }
    if colors.hidden {
        piece = piece.opacity(0.0);
    }
    piece.into_element()
}
