# Changelog

What changed for the person using Herdr Desktop, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `docs/RELEASING.md` (0.1.x, patch bumps). The section of a version is its release notes: write it for the person, not for the commit log.

## [Unreleased]

- **A pane tab is a read-only view, not a pretend terminal.** The key row (Esc, arrows, Ctrl+C), the typing mode (`Ctrl+Shift+K`) with its hint bar, the slash list and quick phrases above the message box, and the `Wrap lines`, `Fit width` and `Actual size` options are gone: with a full keyboard they were clutter, and the typing mode took Escape and Ctrl+K from you. The tab is named `<agent> (view)` and its header says `Read-only view`. You still answer a question with the buttons, `Stop` the agent, send a line with the message box, follow links, find and copy; the pane's columns always fill the width. Chat tabs keep their slash commands.

- **One-command install.** `curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh` installs the newest release on Linux x86_64 or macOS Apple silicon after checking `SHA256SUMS` (`--version X` for another, `--uninstall` to remove). The macOS path is untested on a real Mac.

- **Switch between agents and projects from the keyboard.** `Ctrl+Tab` goes to the agent you were in before this one and `Ctrl+Shift+Tab` to the previous project; tap again to come back. `Ctrl+E` opens the Switcher, a short list of the agents and projects you visited last with the one to go back to highlighted (`Ctrl+E` again moves down, `Enter` opens, `Escape` leaves everything as it was); its rows stay where they are while it is open. `Ctrl+[` and `Ctrl+]` go back and forward through the places you went to, `Ctrl+Shift+[` and `Ctrl+Shift+]` step through the projects. What you visited is remembered between runs (agent and project ids and times only, never what a pane showed).
- **Each project keeps its own tabs.** Opening an agent of another project, `Ctrl+Shift+[`/`]`, `Ctrl+Tab` and the Switcher swap the whole workspace: the tabs, the tab you were in, the message you had not sent and where a chat was scrolled come back as you left them (unsent messages are kept in memory only, never written down). A project with no tab open shows its own card; the board and anything left there is Home (`Ctrl+1`). The saved layout of earlier versions is split by project on first start.

## [0.1.0-alpha.2] - 2026-11-07

Second alpha: the chat reads code properly, macOS builds are signed with our own certificate, and the source is formatted and linted.

- **macOS: one signature for every release.** The app is signed with the project's own certificate instead of a new ad hoc signature per build, so the keychain and permissions macOS remembers survive updates. It is still not notarized: the first launch needs `xattr -dr com.apple.quarantine "Herdr Desktop.app"` or `Open Anyway`.
- **Code reads like code.** Fenced code in an agent's answer, a command and its output, an edit and the permission dock's command are drawn by one renderer: highlighted in 25 languages (more through TextMate grammars), the language in the corner, `Copy code` on hover or focus, a fold past 16 lines (`Show all N lines`), wrap and line-number switches, and edits as diffs with the changed words marked and a `+`/`−` column. An answer still being written shows its open block as it stands. `Ctrl+Shift+C` copies the code of the last answer (or of the block under the pointer), `Ctrl+Shift+Y` the whole answer; Settings > Look has wrap, line numbers, tabs and spaces, and side-by-side diffs. The file viewer draws code the same way and finds text with `Ctrl+F`.

## [0.1.0-alpha.1] - 2026-11-07

The first alpha of Herdr Desktop: the desktop counterpart of the Herdr phone app, for the people who run coding agents under [herdr](https://herdr.dev) and want one window for all of them. It is for trying, not for relying on: read "Known issues" first. Linux (x86_64) and macOS (Apple silicon) packages are built from the same commit by the same checks, but the author has only ever run it on Linux; **the macOS build is brand new and has never been run on a Mac by the author**, so tell us what breaks there.

### What works

- **One window for every agent.** The board groups agents by project, with what needs you (`Needs you`, `To review`) shown first and one count shared by the status line, the window title and the triage list. `Answer one by one` walks the agents that are waiting, longest first.
- **A calm home.** An agent that needs you is said once: loudly in the `Needs you` inbox, and as a small quiet shape and the words `waiting for you` everywhere else, with one orange dot per project. Twenty waiting agents are one answer in place and a sentence (`19 more waiting · docs 4 · infra 4`), not twenty alarms. Text, rows and spacing are larger (15-pt text, 56-pt agent rows, a 300-pt sidebar), and cards, messages, tabs and counts move briefly when something arrives or changes (not when you switch tabs, and never with reduced motion).
- **Answer safely.** A permission prompt from a terminal agent becomes buttons that show the exact command. A risky answer takes two presses (the first arms it for four seconds and says why), a button pressed just as the question changed is ignored, and nothing is sent when the pane no longer shows the question you saw.
- **Watch and steer a pane.** A live mirror of the terminal (fit to the width, actual size, or wrapped lines), a composer, a key row, an opt-in typing mode with a visible way out, links in the output, slash commands, and quick phrases learned on your computer.
- **Agent chats.** Agents that speak ACP (for example `omp acp`) open as native chat tabs: a transcript where a drag selects across paragraphs, lists, code blocks and tables (`Copy message` takes a whole answer), a permission dock with the same safety rules as terminal prompts, questions the agent asks, a queue for messages sent while it works, a sign-in card for agents that ask, and replay after you close and reopen the app. Chats of Claude Code, Codex and omp running in a terminal pane are read from their own logs and can be shown as a chat (`Show chat`).
- **Many machines.** This computer plus any machine you can reach with `ssh`: your `~/.ssh/config`, agent and jump hosts are used, a changed host key stops that machine, and a machine that is out never affects another.
- **Files and pages.** Browse and view files on a machine (code, Markdown, images), send a file to it, and open a page a machine serves (`localhost:5173`) through a tunnel.
- **Notifications** (off by default) when an agent needs you while the window is away, with at most three at a time and then a summary.
- **Work from the keyboard.** A command palette (`Ctrl+K`, `Cmd+K` on a Mac), jump to the next agent that needs you (`Ctrl+J`), tabs and splits you can arrange, and a list of every shortcut (`F1`).
- **Made to be heard and seen.** Every control has a name for screen readers, states are shapes and text rather than colour alone, the four themes pass contrast checks in light and dark, and reduced motion and large text are honoured.
- **A developer panel** (`Ctrl+Shift+D`) with how long it takes from a pane changing to its text being on screen, and the app's memory, threads and open files.
- **Updates.** Settings > About asks GitHub once, when Settings opens, whether a newer release exists and offers `Open release page`. It reads only `api.github.com` (the latest release of this project), sends nothing about you, installs nothing, and has a switch to turn it off.

### Known issues

- **It is an alpha.** The author's own herdr (0.9.5) on Linux is the only real setup it has been checked against; the rest ran against a scripted stand-in for herdr. Expect rough edges and report them.
- **macOS has never been run by the author.** What is checked: it builds, its Rust and TypeScript tests pass headlessly, and the package is signed and structured as a Mac app. What is not: how it looks and behaves in a real window, keyboard shortcuts with `Cmd`, window sizing and position, the web pages (`WKWebView`), VoiceOver, and whether herdr keeps its socket at `~/.config/herdr/herdr.sock` on a Mac (set `HERDR_SOCKET_PATH` if it does not).
- **macOS: notifications are plain.** They show a title and the question, with no answer buttons. A click does not open the agent (macOS opens Script Editor), and one is not withdrawn when the agent stops needing you. macOS lists them under Script Editor in System Settings > Notifications: allow them there.
- **macOS: Apple silicon only, not notarized.** There is no Intel build (the toolkit has none), and the app is signed ad hoc without an Apple developer account, so macOS refuses to open it until you say so (see "Install on macOS").
- **Linux: screen reader limits.** Announcements are polite only (the toolkit cannot send an assertive one), and there is no tray icon. The accessibility audit runs on Linux only; there is no equivalent check on macOS yet.
- **Linux: a preloaded allocator.** A shell profile that sets `LD_PRELOAD` to jemalloc 5.3.1 made GTK 4.22 crash the whole app whenever a window's widgets changed (a chat tab replaced by a terminal, a tab closed). The app now starts itself again without that preload and says so on stderr (`HERDR_DESKTOP_KEEP_PRELOAD=1` keeps it). Other preloaded allocators were not tried.
- **Remote machines need `python3` and `ssh` keys.** A machine without `python3` cannot be reached through the fast path; password logins are not supported (run `ssh <machine>` once in a terminal to trust the host and log in); the update check does not offer newer alphas or pre-releases.
- **Code in chat is not coloured yet.** The syntax highlighter is built but not wired into chat messages; code blocks show as plain monospace text.
- **Focus and screen readers are only partly checked.** Where keyboard focus lands after closing a dialog or tab, and how it reads in Orca or VoiceOver, was checked through the accessibility tree in tests, not by listening.
- **Untested corner:** sending a file to a machine by dropping it on a pane has no automated test. `docs/PARITY.md` lists every feature of the phone app and where it stands.

### Install on Linux (x86_64)

Needs GTK 4.14 or newer, Pango, WebKitGTK 6.0 (`libgtk-4-1`, `libwebkitgtk-6.0-4`) and glibc 2.39 or newer (Ubuntu 24.04 or later), plus `herdr` on the machines you watch.

```sh
tar -xzf Herdr-Desktop-0.1.0-alpha.1-linux-x86_64.tar.gz       # unpacks "Herdr Desktop/"
sha256sum -c SHA256SUMS --ignore-missing                       # optional
git clone https://github.com/tuan3w/herdr-desktop && PACKAGE="$PWD/Herdr-Desktop-0.1.0-alpha.1-linux-x86_64.tar.gz" herdr-desktop/local/install.sh
```

That installs it for your user (`~/.local/opt/herdr-desktop`, a launcher entry and an icon) and runs as `herdr-desktop`. `local/install.sh --uninstall` removes it; your data stays. Or run `Herdr Desktop/HerdrDesktop` from the unpacked folder.

### Install on macOS (Apple silicon, macOS 14 or newer)

```sh
unzip Herdr-Desktop-0.1.0-alpha.1-macos-arm64.zip     # or double-click it in Finder
xattr -dr com.apple.quarantine "Herdr Desktop.app"    # then drag the app to Applications
```

The app is signed ad hoc, not by Apple, so macOS blocks a downloaded copy the first time. Either run the `xattr` line above before opening it, or open it once and use System Settings > Privacy & Security > `Open Anyway` (on macOS 14, right-click the app and choose `Open`). Requirements for what it watches are the same as on Linux: `herdr` on the machines, `ssh` keys for remote ones.
