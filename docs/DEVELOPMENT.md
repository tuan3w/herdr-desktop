# Development

## Prerequisites

- Linux with GTK 4.14+ runtime (Ubuntu 24.04 or later).
- Build packages: `sudo apt-get install -y libgtk-4-dev libwebkitgtk-6.0-dev clang pkg-config`. nsh's Linux platform links WebKitGTK (`javascriptcoregtk-6.0`) even for apps that never open a web view, so the `-dev` package is needed from the first `--target linux` build. Headless `nsh check` and `nsh test` need neither.
- nsh 0.4.0: `NSH_VERSION=v0.4.0 sh -c "$(curl -fsSL https://nsh.dev/install.sh)"` installs `~/.nsh` and links `~/.local/bin/nsh`.
- Rust 1.99.1 (`rust-toolchain.toml`; rustup installs it on first use), bun for `scripts/*.mjs`, node for `scripts/check-docs.mjs`.
- For `make a11y` and screenshots without a display: `xvfb-run`, `dbus-run-session`, `at-spi2-core`, `python3-gi`, `gir1.2-atspi-2.0`.

## Running with a display-less session

```sh
xvfb-run -a env GSK_RENDERER=cairo nsh test components/<file>.test.tsx --target linux
```

A test step can `await app.screenshot(".scratch/x.png")`. The default renderer under NVIDIA is GSK GL (`ngl`); Xvfb needs `GSK_RENDERER=cairo`.

Under `--target linux` the test file runs apart from the app: it cannot import `herdr-desktop/native`, a test is cut after 30 s unless `test(name, body, timeout)` says otherwise, and `app.submit` types a line break into a box that sends on Return. `docs/PERFORMANCE.md` says how the `.perf/` scenarios work around that (`perf-app.tsx` drives the scripted herdr on key presses).

## Packaging

`make package` (`nsh package . --target linux -o .scratch/dist`) builds the release runner and writes `.scratch/dist/Herdr Desktop/` and `Herdr Desktop.tar.gz`; `local/install.sh` installs it (`PREFIX=<dir>` to try it without touching your home, `--uninstall` to remove it). The release build lands in `target/release`, about 2.5 GB beside the debug build: on a disk that cannot take both, point `CARGO_TARGET_DIR` at another disk for that one command and delete it after. `docs/RELEASING.md` is the release procedure and what the package needs at run time.

## Disk

The data disk had 8.7 GB free when this project started. There is one `target/` (`.cargo/config.toml`); never create another. Clean it before a campaign when free space is under 6 GB.

## Live smoke against the owner's herdr

Read-only methods only (`ping`, `session.snapshot`, `pane.read`, `agent.list`), or a scratch workspace labelled `herdr-desktop-scratch` with `focus: false`, closed afterwards. Never commit or screenshot a real pane (`AGENTS.md`).

## Tests that need more than cargo

Three kinds are `#[ignore]`d or need a tool, so a plain `make core` stays hermetic:

- **Real ssh** (`HERDR_DESKTOP_SSH_TEST=localhost`, key login to it, python3 there): `cargo test --manifest-path native/core/Cargo.toml --test ssh -- --ignored` and `cargo test --manifest-path native/app/Cargo.toml --test remote -- --ignored --nocapture`. The second talks to the owner's live herdr through the relay (read-only) and signals only the ssh children its own link exposes by PID.
- **Notifications over D-Bus** (`native/app/tests/notify_dbus.rs`) run with `make core`: they need `dbus-daemon` and python3 with `gi`, start a private bus and a stand-in service, and kill only those two processes.
- **The live board** (`native/app/tests/live.rs`, `--ignored`): counts only, no pane text.

## nsh host quirks

Seen by the sibling project ship-desk on nsh 0.3.0 (macOS), re-read against 0.4.0 for the kit here (`design/components.md`, "Host quirks on nsh 0.4.0", has the per-quirk verdict). Headless `nsh test` has no renderer: rendering facts below are unverified on 0.4.0 and Linux until a screenshot under `xvfb-run -a env GSK_RENDERER=cairo` shows otherwise.

- `ring-*` classes draw nothing: use `FOCUS_RING` (outline). An outline is painted by its own view, so the fill of a later sibling covers it: on rows 0 to 2pt apart use the inset rings `FOCUS_RING_SIDEBAR` / `FOCUS_RING_INSET` (`-outline-offset-2`). Alpha on text colour (`text-x/60`) is an unknown class: use `opacity-*`. A box-shadow ring draws no edge: use a border.
- `ResizablePanelGroup` is the shell: its panels must be its direct children, so overlays (toast host, dialogs) sit outside it. A list of hundreds of rows or more is a `List` (virtualized: only the rows near the window exist, cells are recycled): its row reads its item as an accessor and keeps no state of its own, and a test finds a row by its `label:`. Mounting every row (`Each` over thousands) costs memory and CPU by the row; `Each` is for tens of rows and `Table` for data read by columns. `Storage` is one 5 MB quota for all keys: a write over it rejects (`lib/save.ts` turns that into a warning). `onTextLayout` reports the visible part of a cut text, which is how `Clipped` knows it cut.
- `tooltip` on `Button` draws nothing: wrap in `Tipped`. `activeStyle` transforms are ignored: drive scale with `createMotion` (`lib/motion.ts`).
- Raw `Button` as a `Popover` trigger is not toggled by the popover: toggle `open` in its `onPress`. nsh's `Menu`/`Submenu` (`nsh/base`) close a submenu when the pointer touches any other row (still true in 0.4.0 `menu.rs`), so the kit menu is built on `Overlay`. A view cannot take the focus from code (`focus()` is for inputs): menus keep the focus on the trigger and move a highlight.
- `DataTable` needs `class="flex-1"` to have a height; `renderCell` draws every cell; column widths are points.
- JSX spread reads its object once: reactive spread is a getter (see `ThemeRoot`). The theme switch relies on the internal `uiTheme` prop; `lib/theme/theme.test.ts` fails first if nsh changes it (it passes on 0.4.0).
- `Clipboard.writeText` without `"clipboard": true` in `nsh.json` only logs a warning and the app believes it copied.
- Fonts and icons must live under the app's entry directory. A loop (`Spinner`, `Skeleton`) mounts only while visible.
- Per-row actions use `group` + `group-hover:opacity-100 group-focus-within:opacity-100`; they stay pressable and named.
- **A preloaded allocator can take the GTK host down.** `LD_PRELOAD=libjemalloc.so.2` (jemalloc 5.3.1, exporting C23 `free_sized`) plus GTK 4.22 on glibc 2.43: GTK frees a `GtkActionMuxer` with `free_sized(NULL, n)`, jemalloc queues the `NULL` in its thread cache and a later `malloc` returns it. The host then aborts with `memory allocation of 5 bytes failed` or dies with `SIGSEGV` and no message (`nsh test` reports only `the host left`) whenever a native widget is destroyed: a chat tab swapped for the mirror, a closed tab. `native/app/src/preload_guard.rs` restarts the process before `main` without the preload entries that export `free_sized` (one stderr line; `HERDR_DESKTOP_KEEP_PRELOAD=1` keeps them), so never work around it in components: a `selectable` `TextView` in a recycled list cell is fine. How to get a stack when the host dies without a message: `strace -f -qq -e trace=exit_group,kill,tgkill -o /tmp/s nsh test ...` names the signal; for the stack run the host under `gdb` (`ptrace_scope` 1 forbids attaching from outside: swap `target/debug/nsh-app-*-linux-host` for a wrapper script that execs `gdb -batch -ex run -ex bt --args <the real binary> "$@"` once the build step is over). Details and the stacks: `docs/upstream/nsh-selectable-textview-in-list.md`.
- **The board shows before the engine is done, and a press resolved meanwhile is lost.** `Board, 2 need you` appears with the first `session.snapshot`; the engine then reads every agent's pane (`pane.read`, one per agent row) from its own thread, and each answer is another revision that re-pulls the board and re-renders the lists (the `board tick` of the sidebar lab goes 2, 3, sometimes 4). A press that resolves its target in between aims at a row that is replaced a moment later: the view id differs from a passing run's and the handler never runs, but only when the machine is slow enough for the reads to land after the press. `quiet(app)` in `app-seam.ts` waits for that fact (`pane.read` requests in the scripted herdr's log reach the number of agent rows), then runs the clock 300 ms; `ready()` and the lab openers use it. `pressSettled(app, selector, done)` is the one repeat-until-it-took press. Never wait for a status text the screen no longer has: `board.test.tsx` and `bulk.test.tsx` waited for `heard just now`, which the board dropped, so every `lab()` spent 5 s of manual clock and real time on a swallowed timeout (it also masked the race). `app.texts()` of a list is in the order its recycled cells were made, not screen order, and differs from run to run: read an order from `Herdr.board()`, never from `texts().indexOf`.
- The headless harness does not list a `DataTable`'s cells, does not open submenus and has no real pointer path between rows; its storage is isolated from the real app's data. `app.press` as the very first step after `open` was once seen to be lost under machine load: rerun before assuming a bug.

### Found while moving the kit to 0.4.0

- Events take one object: `onChange({ value })`, `onLayout({ bounds })`, `onExpandedChange({ expanded })`, `onSortChange({ sort })`, `keymap.bind(k, ({ keystroke }) => ...)`. A handler that treats the whole object as the value **type-checks when it only tests truthiness** (`onExpandedChange={(expanded) => expanded ? pause() : resume()}` always paused the toasts): read the declaration in `.nsh/types/nsh/*.d.ts` for every event you touch, and test the behaviour.
- Refs are per element (`ViewRef`, `InputRef`, `ListRef`, `ScrollRef`), not `YNode`: `scrollToOffset` is on `ListRef`, `setSelection` on `InputRef`.
- Hover events are `onMouseEnter` / `onMouseLeave` / `onMouseMove` (with a `MouseEvent`). `numberOfLines` is `line-clamp-*` or a `style` key, `pointerEvents` and `objectFit` are `style` keys or classes (`pointer-events-none`). `AlertDialog.show` resolves with `{ action }`.
- In `nsh/test`, `toBeNull()` is strict (an `undefined` fails it) and `app.clock` is `Clock | null` (`app.clock!` where the test opened with `clock: {}`).
- `nsh check` does not resolve asset imports (`import x from "./icons/x.svg"`): a deleted icon fails at bundle time, in `nsh test`.

## Screenshots on a Mac

`make shots-mac ARGS="<scenario> [--size 1280x800|960x700|760x640] [--theme light|dark|both]"` (or `node scripts/shots-mac.mjs ...`) opens one `.shots/scenarios.ts` scenario, or `--entry components/x-lab.tsx`, in the real AppKit window with `nsh test --target macos` and writes `.scratch/shots-mac/<name>-<width>-<theme>.png`. The picture is nsh's own `app.screenshot` of that window: no screen capture, no Screen Recording permission, no window id. Verified on Apple silicon (nsh 0.4.0): the board, the Settings dialog, the permission dock, a kit Select popup, both appearances (`app.setColorScheme`, which the app's theme follows).

Options: `--press <selector>` (after the scenario's steps), `--keys <chord>` (`meta+,` is Settings: a scenario's own `ctrl+,` does nothing on a Mac, so add `--no-steps`), `--js "<steps with app in scope>"`, `--wait ms` (before steps), `--settle ms` (after each key or press, default 1200: a dialog shot at 500 ms shows the board through it, mid fade).

What does not show: `ActionMenu` is a native `NSMenu` and `Popover` a window of its own on this host; `app.screenshot` does not include them (the Select popup is in the window and does). `app.type` into an input did not change the value in the combobox probe: set the value in a scratch edit and revert it. The Changes lab used to stay on its loading skeleton: macOS reports `lifecycle()` as `background` for this host's window (not visible to `NSApplication.occlusionState`), and the model then read nothing; it now reads once whatever the lifecycle, and polls only in the foreground. `app.press` on a list row by `label:` with a path did not select it; `--js` with `app.keyboard.press("j")` steps files. The screenshot (`cacheDisplayInRect:`) does not draw the spread ring of a box shadow nor outer shadows under an opaque fill, so the light edge of a popup is invisible in it while the real window shows it: never judge `SHADOW` from these pictures. A lab under `components/` has no `nsh.json` beside it and renders with the default theme (no `signal`, no `base` radius, Tailwind's own shadows): judge tokens and shadows from the App entry (a scenario), not a lab. `Inter` is not installed, so the system font is used and widths differ from Linux: a one-line fit seen here may not fit there.

Safety rules, each from a failure: (1) always `HERDR_DESKTOP_TEST=1` (the script sets it): an earlier `nsh test` without it read the owner's real projects and machines; use labs, probes and fixtures only, never a real pane; (2) capture only the app window through nsh, never the screen, which may show private windows; (3) the script spawns one `nsh` and on its timeout kills exactly that PID; never `pkill` or a name kill; (4) output only under the ignored `.scratch/shots-mac/`, never committed.
