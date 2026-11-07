# herdr-desktop

A native desktop client for [herdr](https://herdr.dev), the terminal multiplexer for coding agents. It is the desktop counterpart of `herdr-mobile`: one window shows every agent on every machine, says the moment one needs you, lets you answer safely, and lets you look away.

Built with [nsh](https://github.com/longbridge/nsh) (Rust + TSX, native widgets: GTK 4 on Linux, AppKit on macOS; no web view for the UI). Linux first; macOS (Apple silicon) builds are new and untried on a real Mac ([docs/MACOS.md](docs/MACOS.md)). License: GPL-3.0-or-later.

## What it does

- **Board.** Agents grouped by project (a repository with its worktrees, or a folder), chat sessions and terminal agents together, each row and project header showing its state (needs you, working, to review) and an inbox of what waits for an answer over them; one count is shared by the status line, the window title and notifications.
- **Answer.** Permission prompts of terminal agents become buttons showing the exact command. Risky answers are two-step. Nothing is sent when the question changed.
- **Watch and steer.** A live read-only view of each pane, a message box, a Stop button, links; chat sessions have slash commands.
- **Many machines.** This computer plus any machine reachable with `ssh` (your `~/.ssh/config`, agent and ProxyJump are honoured; no password prompts).
- **Agent sessions.** ACP agents (for example `omp acp`) started from the app, with a chat transcript, a permission dock and replay after a restart.
- **Accessible.** Screen-reader roles and labels on every control, keyboard everywhere, contrast-tested themes, reduced motion.

Feature-by-feature status against the phone app is in [docs/PARITY.md](docs/PARITY.md).

## A look

<p><img src="docs/screenshots/home.png" alt="Home: projects, a Needs you inbox" width="440"> <img src="docs/screenshots/chat.png" alt="Chat with highlighted code, light" width="440"> <img src="docs/screenshots/chat-dark.png" alt="Chat with highlighted code, dark" width="440"></p>

Illustrations from scripted data, not a gallery: they date. `make shots` takes current ones into `.scratch/shots/` (not committed).

## Install

**macOS, Apple silicon** (Intel Macs have no build: nsh 0.4.0 has no Intel runtime). One command:

```sh
curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh
```

It takes the newest release (pre-releases included), refuses to install when the download does not match `SHA256SUMS`, replaces the previous install, verifies the signature and clears the quarantine flag, so the app opens first time (it is signed with the project's own certificate, not notarized by Apple). It installs `~/Applications/Herdr Desktop.app` and never uses `sudo`.

```sh
curl -fsSL .../scripts/install.sh | sh -s -- --version 0.1.0-alpha.3   # a specific release
curl -fsSL .../scripts/install.sh | sh -s -- --edge                    # the newest build of main (may break)
curl -fsSL .../scripts/install.sh | sh -s -- --uninstall               # remove it (your data stays)
```

`APP_DIR=DIR` chooses another place. Prefer to read it first: [scripts/install.sh](scripts/install.sh). The archives, `SHA256SUMS` and the notes of each release are on the [Releases page](https://github.com/tuan3w/herdr-desktop/releases); `edge` there is the build of the latest `main`, replaced after every push that builds.

**Linux is paused.** New releases hold the macOS zip only: the owner is focusing on macOS, so no Linux package is built or tested on every change. On Linux the installer says `no Linux build in this release`; build from source (below). Linux x86_64 archives exist for `0.1.0-alpha.1` to `alpha.3` and the installer still installs them with `--version`. The Linux code, `make` targets and CI jobs are kept working and run by hand: [docs/RELEASING.md](docs/RELEASING.md), "Linux (paused)".

## Status

Alpha: `0.1.0-alpha.3` is the current test release ([CHANGELOG.md](CHANGELOG.md) says what works and what does not). macOS (Apple silicon) is the platform of the releases and of CI: every push to `main` builds and signs the app and lints the code; the slow tests run nightly. Nobody has run it on a real Mac yet, and Linux builds are paused. `docs/PARITY.md` is the ledger of what is done.

## Build

Needs Linux with GTK 4.14+, `libgtk-4-dev`, `clang`, `pkg-config`, and [nsh](https://nsh.dev) 0.4.0:

```sh
NSH_VERSION=v0.4.0 sh -c "$(curl -fsSL https://nsh.dev/install.sh)"
make        # check, test, core, docs, a11y
make run    # dev window
make package            # .scratch/dist/Herdr Desktop.tar.gz
local/install.sh        # install it for your user (--uninstall removes it)
```

On a Mac (Xcode command line tools, clang) the same commands work with `make verify-mac` in place of `make` (no AT-SPI audit) and `make package` producing `Herdr Desktop.app`. Releases are cut as in [docs/RELEASING.md](docs/RELEASING.md).

[AGENTS.md](AGENTS.md) is how to work here, [DESIGN.md](DESIGN.md) the design system, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how the pieces fit.
