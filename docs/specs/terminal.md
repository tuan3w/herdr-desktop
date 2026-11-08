# A real terminal in herdr-desktop: decision, numbers, prototype

Status: **decided, phase 1 built (mouse, selection, copy and paste, fonts, option-as-meta), built in by default, not reachable from the UI yet** (phase 2: the tab, `Show terminal`, hint line, palette, remote machines). The pane tab is a read-only view (`design/pane.md`); this is what replaces the phone's key row and typing mode when the owner wants it.

## The model

herdr's public API has no cursor, no mouse and no byte stream for a pane, and its private client socket is off limits (`AGENTS.md`). A terminal with full interaction is therefore **a pty running the official `herdr` client** inside our own terminal widget: the same thing as running herdr in any terminal emulator.

- Local: `herdr` (the default session) or `herdr --session NAME`; `herdr session attach NAME`.
- Remote: `herdr --remote <ssh-target> [--session NAME]` (read from `herdr --help`), or `ssh -t host herdr`.
- Plain shells: `$SHELL` on a pty, the same widget.
- Pointing the client at a pane before it attaches: `herdr workspace focus`, `herdr tab focus` and the API's `pane.focus`-style calls exist; `herdr pane focus` moves to a *neighbouring* pane, not to an id (read from `herdr pane --help`; not run). Several clients on one session, and whether the owner's other terminal stays usable: **not tested** (this run was forbidden to attach to the owner's session and the scratch session was not reached, see Unverified).

The widget needs an emulator and an encoder for keys and mouse. Our own `Terminal` component (`native/app/src/terminal`) holds one. nsh `main`'s `Terminal` is not in 0.4.0 and ours stays 0.4.0.

## Candidates, measured on this box

Release bench of the library alone (`.scratch/term-bench`, not committed): 20 MB streams in 64 KiB chunks into a 200x50 grid, three runs, medians. `yes` is 3-byte lines, `cat` is coloured 100-column source lines with truecolour SGR, wide characters and an OSC 8 link.

| | libghostty-vt 0.2.2 (Rust crate) | alacritty_terminal 0.26 | wezterm-term |
|---|---|---|---|
| Builds here | yes, needs **zig 0.15.2** (51 MB download, 380 MB unpacked) | yes, plain cargo | not measured: not on crates.io, git-only inside the wezterm workspace |
| Cold build | 2 min 09 s (the crate `git clone`s ghostty at a pinned commit, then `zig build`); 412 MB of build output (source 156, zig cache 233, install 24) | about 9 s with the rest cached, small | - |
| Rebuild with the library installed | 14 s: `libghostty-vt-sys` feature `pkg-config` finds `libghostty-vt-static.pc`, no zig | - | - |
| Library size | `libghostty-vt.a` 15.6 MB with debug info; a bench binary using both libraries is 2.7 MB | in the same binary | - |
| Parse, `yes` | 49 MB/s (10 MB history), 65 MB/s with almost none | 128-136 MB/s | - |
| Parse, `cat` | 32 MB/s | 135-144 MB/s | - |
| Parse, 100-col plain lines through the whole session | 152 MB/s, 16 frames published for 20 MB | - | - |
| Empty 200x50 terminal | 55 KiB | 511 KiB | - |
| 10,000 rows of history, 200 columns | 17-24 MB (`max_scrollback` is **bytes**, the docs say lines: 10 MB kept 4,000-5,400 rows, 30 MB kept 12,500-17,000) | 51-53 MB (fixed cells) | - |
| Threads | none created | none | - |
| License | MIT; crates MIT OR Apache-2.0 | Apache-2.0 | MIT |

libghostty-vt is built with `LIBGHOSTTY_VT_SYS_CPU=baseline`: the SIMD paths are not tuned, and `native` was not measured (a shipped binary cannot use it). It parses 2-4x slower than alacritty's parser on raw bytes and 4-9x smaller per idle terminal; both are far above what a terminal's PTY produces (the session test costs one frame per 8 ms at most). Throughput is not the deciding number.

What each gives beyond the grid (read from the crates):

| | libghostty-vt | alacritty_terminal |
|---|---|---|
| Key encoder | yes: legacy, application cursor and keypad, Alt as ESC prefix, **kitty keyboard protocol**, modifyOtherKeys (Ghostty keeps Ctrl+letter as its control byte in this mode: measured) | none (it lives in the alacritty binary) |
| Mouse encoder | yes: X10, normal, button, any; UTF-8, SGR, urxvt, SGR pixels | none |
| Paste, focus events | yes (`paste::encode`, bracketed only when asked; `focus::Event`) | none |
| Selection | yes: cells, word, line, rectangle, `format` as text; selection is part of the render state | its own `Selection` type |
| Scrollback and reflow | yes, reflow on resize | yes |
| Wide characters, emoji, grapheme clusters | yes, mode 2027 | partial (combining marks) |
| OSC 8 links, OSC 52 | yes; OSC 52 *reads* are never forwarded, writes arrive in a callback | yes |
| Title, bell, cwd, colour queries, device attributes | callbacks and `on_pty_write` replies | events |
| Kitty graphics | yes (default feature), not drawn by the prototype | no |
| Render state with per-row dirty flags | yes | damage tracking |

**Decision: libghostty-vt**, because it is the only candidate that also encodes keys and the mouse (kitty keyboard, modifyOtherKeys, mouse reporting, bracketed paste are the hard half of a terminal), because herdr itself is built on it (the owner's agents are drawn by the same engine they run in), and because it is small per terminal. Costs, in the order they will bite:

1. **zig in the build.** zig 0.15.2 for crate 0.2.2 (it pins ghostty `a887df4`, 1.3.2-dev, *before* the 1.0 tag `vt-1.0.0` of 2026-11-06, which needs zig 0.17.x). The first build downloads ghostty from GitHub. Offline and release builds want the 1.0 source and deps tarballs (`release.files.ghostty.org/libghostty-vt/1.0.0/`) with `GHOSTTY_SOURCE_DIR`, or an installed library found by pkg-config. The crate's API is "not yet stable" until a release tracks 1.0: pin a git revision.
2. CI and the three release builds (Linux x86_64, macOS arm64, signed) each need zig or a prebuilt static library per target.
3. `max_scrollback` is bytes.
4. Types are `!Send`: the emulator lives on one thread (done: `emulator.rs`).

Fallback if zig is refused: `alacritty_terminal` for the grid plus our own key and mouse encoders (several hundred lines, no kitty keyboard), behind the same `Session` handle. Not built: libghostty-vt built, so the trait the assignment asked for in that case was not needed; `session.rs` is the seam and `emulator.rs` the only file that names libghostty.

## What was built (`native/app/src/terminal`, cargo feature `terminal`, on by default)

- `pty.rs`: `openpt` on `rustix`, the child in its own session with the pty as controlling terminal, `TERM=xterm-256color`, `COLORTERM=truecolor`, every `HERDR_*` variable removed, hangs up on its own process group only.
- `emulator.rs`: libghostty on a thread; messages in (`types::Input`), immutable `Frame`s out (`frame.rs`), rows shared between frames, at most one frame per 8 ms, none while idle; the theme's 16 colours as the program's palette.
- `session.rs`: the handle. Without the feature a session is one frame saying so. There is no runtime switch any more; instead a terminal starts **only with an explicit `command`** (an empty one prints `Could not start the program` and runs nothing: the caller passes `$SHELL` when it wants a shell).
- `keys.rs`: the keyboard rule (below). `view.rs`: the `Terminal` component, registered always so TSX types do not depend on the feature.
- Tests: `tests/terminal.rs` runs real programs on a real pty (20 tests, all pass); `src/terminal/tests.rs` mounts the view headlessly with a real program.

Verified by those tests: colours from the theme palette and truecolour; keys as a terminal encodes them (`ctrl+k`, `escape`, `alt+x`, arrows, `ctrl+left`, `shift+tab`, `f5`, `ctrl+space`); typed UTF-8; application cursor keys; kitty keyboard (disambiguate); modifyOtherKeys; bracketed paste only when asked; focus events only when asked; mouse reports (SGR) and wheel reports when the program tracks the mouse; selection by drag, double click selects the word, copy; scrollback by wheel and to an absolute row; resize reaches the program (`stty size`) and reflows; title, bell, OSC 8 link with its columns; wide characters, emoji and combining marks; cursor shape and position; exit code, `Restart`, a program that cannot start; an idle terminal publishes nothing; the child has no `HERDR_*`; 20 MB through the session.

## The key problem: app shortcuts against keys a program needs

nsh 0.4.0 has no raw key event, only keymap bindings, and `Keymap::find` takes **the newest binding of a keystroke**, a view's bindings being newer than the app's (`element/keys.rs`, `core/components.rs`). So a focused terminal binds what it takes and the app's shortcut fires for everything it did not bind. Text never goes through bindings: a hidden input receives it (layouts, dead keys and input methods compose there).

The rule (`keys::app_owns`, `keys::bound`), on Windows and Linux where `mod` is Ctrl:

- **The program gets every key a terminal can encode:** all named keys and F1-F24 with Shift, Ctrl and Alt (not Ctrl+Shift), `Ctrl+<letter>` and `Ctrl+[ ] \ / space`, `Alt+<printable>` and `Alt+Shift+<letter>`. So Ctrl+K, E, J, N, W, P, F, B, Z and Ctrl+/ are the shell's and the editor's, F1 is the program's help.
- **The app keeps** every chord with Ctrl *and* Shift (a terminal cannot tell it from the plain chord), `Ctrl+Tab`, `Ctrl+,`, `Ctrl+<digit>`, every Command chord on a Mac. `Ctrl+Shift+<digit>` (tabs) is therefore always the way out. **Open conflict (2026-11-08):** the palette is now `Ctrl+P`, which a terminal program owns (shell: previous command), and `Ctrl+Shift+P` is the file search, so inside a terminal tab the palette has no key. It needs a Ctrl+Shift chord of its own for a focused terminal (to choose with the owner).
- Not bound at all: `Ctrl+Alt+<char>` (AltGr types characters on many layouts), plain and Shift text, anything the host reserves (Ctrl+Q, F11: skipped at bind time).
- Copy and paste: `Ctrl+C` copies only while text is selected, else it is the interrupt; `Ctrl+Shift+C` and `Ctrl+Shift+V`, `Shift+Insert` (Command+C and V on a Mac) always. `Shift+PageUp/PageDown/Home/End` scroll the history.
- A focus ring (2 px `ring` token) is drawn while the program has the keyboard; unfocused, the cursor is an outline. The embedding screen must show a persistent line, for example `Keys go to the program. <the chosen Ctrl+Shift chord>: palette`, announced once on entry. **Not built yet**: the hint line and any dock integration.

`keys.rs` tests pin the rule (reserved set, text never bound, Apple variant). **Checked against real GTK key events: no** (see Unverified).

## What works in the prototype, what does not

Works (headless and pty tests above): everything in the verified list. Drawn: rows with per-row cell backgrounds, bold, italic, underline, strike, inverse, dim, hidden, contrast correction (`minContrast`), block cursor inverted into its row, bar and underline cursors, outline when unfocused, selection as inverse, bell as a 160 ms flash (no sound), exit bar with `Restart`, OSC 8 and plain links underlined and opened with Ctrl (Command) held, `title`, no blink unless `cursorBlink` and not `reduce_motion()`.

## Phase 1 (2026-11-08): mouse, selection, fonts, keys

Measured on macOS 26 arm64 with a build from `cargo test --features terminal`: libghostty-vt cold build 71 s (the library; the app crate after it 9 to 17 s), 31 pty tests in `native/app/tests/terminal.rs` and 16 view tests in `native/app/src/terminal/tests.rs`, all passing.

**What nsh 0.4.0 gives a view, read from `crates/nsh-platform-macos/src/input.rs` and `nsh-platform-linux/src/input.rs`** (the limits, exactly):

| Input | What reaches the view | Consequence |
|---|---|---|
| Left press, release | `onPressDown` / `onPressUp` with position, modifiers, `clicks` (1, 2, 3). Press events carry **no button** | Only the left button is a press |
| Right press | **Only** `onContextMenu` (position, modifiers). No press, no release, no drag. Control-click on a Mac is the same | A right click is one event: the view sends a press and a release of button 2 to a program that tracks the mouse, else opens the menu. A program never sees a right *drag* or a held right button |
| Middle press | **Nothing on either platform** (macOS ignores `OtherMouseDown` but the back button; GTK only passes primary and secondary). `onMouseMove` carries `pressedButton` only while a drag the backend recorded | **Middle-click paste and middle-button reports are impossible** until nsh reports the button |
| Move | `onMouseMove` with `pressedButton` (left) while dragging, and `onMouseLeave` | Drag selection and button-motion reports work. Whether moves keep coming **outside the view while the button is down** was not verified (headless cannot say; macOS delivers `LeftMouseDragged` window-wide but the view only hears moves it is hovered by): if not, autoscroll starts only when the pointer is still over the view or its release arrives outside |
| Wheel | **No wheel event for a view**; only a scroll view's `onScroll` offset (issues #969, #1185) | The view keeps a scroll view under the rows as a sensor (module docs of `view.rs`): in history mode its offset is the viewport row; while the program tracks the mouse or the alternate screen is up it is held in the middle of a tall box and each step away is converted to ticks of three rows, the remainder kept so a trackpad's small steps accumulate, a jump of more than 12 ticks in one event (the sensor settling after a resize or switch) is dropped, and the view is re-centred. Wheel position for reports is the last known pointer position. Modifiers on the wheel are **not** known (Shift+wheel cannot force the history while a program tracks the mouse; Shift+PageUp and the scroll bar still can) |
| Key release | none | kitty "report event types" cannot work; keys are sent on press and repeat |
| Cursor | `.cursor(Cursor)` is a static style | the view re-creates the scroll content box when the look changes: pointing hand over a link, arrow while the program tracks the mouse, I-beam otherwise |

**Behaviours done (all with pty tests of the bytes unless marked "view test" or "unverified in a window"):** press, drag, release select by cell; double click selects a word, triple click a line; Shift-click extends from the anchor (Shift also forces selection while a program tracks the mouse); the anchor and the selection are in screen (history-inclusive) coordinates, so output scrolling the screen leaves the selection on its text; a drag past the top or bottom edge scrolls (a 40 ms timer, 1 to 6 rows by distance) and keeps extending until release; Cmd+C copies when something is selected (Ctrl+C stays the interrupt; Ctrl+Shift+C and Shift+Insert on Linux), Cmd+V and Ctrl+Shift+V paste (bracketed only when the program asked: test; line ends become `\r`), Cmd+A / Ctrl+Shift+A select all, Cmd+K / Ctrl+Shift+K clear the scrollback; right click: menu Copy, Paste, Select all, Clear scrollback through nsh's native `popup_menu_at` (view test: `a_right_click_is_the_menu_unless_the_program_tracks_the_mouse`; a native menu, not the kit's `ActionMenu`: phase 2 may swap it); mouse reports in X10 and SGR with button, drag (+32), shift, alt, ctrl, wheel (64/65) and right and middle encodings (pty tests); the wheel scrolls three lines a notch, on the alternate screen it sends three arrow keys a notch **only while DECSET 1007 is on** (off: nothing, as other terminals), `clear` forgets history (ED 3); Shift+PageUp, PageDown, Home, End scroll the history; links are underlined only under the pointer, open with Cmd (Ctrl) held (`onLink`); the pointer look follows (unverified in a window).

**Fonts.** Default `fontSize` is 12 and a row is `round(size x 1.25)` whole points (`row_height`: 13, 14, 15, 16, 18, 20 for 10 to 16 pt, tested); the cell width is the measured advance of the font family, which is the theme's `font-mono` (IBM Plex Mono, registered from `fonts/` by `nsh.json` for the app; a lab entry under `components/` does not find `fonts/` and falls back to the system monospace: check the face in a render of the real app, not the lab). Box drawing joins in the emulator grid (test `a_bordered_box_stays_in_contiguous_rows...`); the visual join at 1.25 is from the prototype's render and was **not** re-rendered here (see Not verified). Settings: `terminalFontSize` (10 to 16, default 12) and `terminalOptionAsMeta` (default on) in `lib/settings.ts`, rows under Look; `paneFontSize` (9 to 24, default 13) stays for the read-only pane view (`PaneScreen`, still used by chats' `Show terminal` and the board) until phase 2 deletes that view. Cursor blink stays off unless the `cursorBlink` prop is set, and never under reduced motion.

**Keys.** Option as Meta is the prop `optionAsMeta` (default true): libghostty's `macos_option_as_alt` is set after every `set_options_from_terminal` (which resets it). On a Mac Command chords stay the app's except copy, paste, select all and clear; Ctrl+letter and Alt+char go to the program (`keys::app_owns`, unchanged). Dead keys and input methods still commit through the hidden input.

**Not verified / not built** (kept honest):

- **No render was made** and no idle fps or CPU measured: the disk fell under 1 GiB (see the task report) and a macOS host build was not safe. `components/terminal-lab.tsx` and the scenarios `terminal-tui`, `terminal-vim`, `terminal-ls` (`.shots/scenarios.ts`, programs under `.scratch/term/`) exist and type-check; run them with `make shots-mac` or `scripts/nsh-test-mac.sh`, and the idle figure with `--fps`. The last idle check is only the pty one: no frame is published while nothing changes. A cursor blink or bell flash holds frames only for 160 ms (`flash`) and blink is off by default.
- Autoscroll outside the view and the pointer look: unverified in a window.
- IME composition is not drawn; screen readers are not told of new output; selection by keyboard is absent; OSC 52 writes need `allowClipboardWrite`; kitty graphics are decoded and ignored.
- Not reachable from the UI: no tab, palette entry, hint line or `Show terminal` (phase 2), and no remote machine.
- zig 0.15.2 on macOS 26 needs the `xcrun` wrapper (`docs/DEVELOPMENT.md` "Building the terminal"); CI workflows got a zig step that has not run.

## How to try it

```sh
export PATH=<zig 0.15.2>:$PATH                    # or PKG_CONFIG_PATH=<dir with libghostty-vt-static.pc>
cargo test --manifest-path native/app/Cargo.toml --features terminal
```

nsh builds the crate with its default features, which include `terminal`: no switch is needed. A `Terminal` in TSX takes `command` (required; pass `$SHELL` for a shell, `herdr --session herdr-desktop-scratch` for a scratch herdr), `cwd`, `label`, `fontSize` (default 12), `optionAsMeta`, `minContrast`, `cursorBlink`, `scrollback`, `allowClipboardWrite`; events `onTitle`, `onBell`, `onExited`, `onLink`, `onCells`, `onFocus`, `onClipboard`; methods `focus`, `restart`, `text`, `selection`, `send`, `paste`.

## Effort to a proper terminal

1. A GTK pass under Xvfb with XTEST (`libXtst` and `libX11` are present; no `xdotool`, so ctypes): `cat -v` key echoes for the whole bound set, `htop` and `vim` (installed) with colours and mouse, the scratch herdr session, idle CPU, a 20 MB frame cost. About a day, and it will find the wheel and press-bubbling questions.
2. The dock tab: key `terminal:<id>`, the persistent hint line, title from `onTitle` into the tab, `Restart`, palette entries, closing hangs up the program (no `Show terminal` until then). A day, in `workspace.tsx`, `lib/dock.ts` and the palette, which other work is editing.
3. Remote machines: `herdr --remote` or `ssh -t` as the `command`; ControlMaster reuse; the injection rules of `AGENTS.md` for anything composed into a command line. A day.
4. Accessibility: announce output politely (reuse `PaneScreen`'s gate), a keyboard way to select, IME preedit. Two days.
5. Build: zig in CI and release, or prebuilt static libraries per target, pinned libghostty-rs revision tracking `vt-1.0.0`; NOTICE entries (MIT for ghostty, plus the licences of simdutf, Highway, Wuffs and the Unicode tables, all permissive, all compatible with GPL-3.0-or-later). Two days plus the macOS signing job.
6. Polish: autoscroll, blink and cursor settings, link tooltips, kitty graphics, right-click menu, focus handling between splits.

## Open questions for the owner

- Is zig in every build acceptable, or should the app ship a prebuilt libghostty per platform?
- Should the terminal replace the read-only view for terminal agents, or sit beside it (`Show terminal` being the existing button that opens the *view*, which is now misnamed)?
- Ctrl+P and Ctrl+E becoming the program's inside a terminal tab: which Ctrl+Shift chord opens the palette from there?
- When the owner's own terminal and ours attach to one herdr session, which one is the "primary" (herdr sizes panes to the smallest client): untested.
- Should a program be allowed to write the clipboard (OSC 52) by default?
