# herdr-desktop

A native desktop client for [herdr](https://herdr.dev), the terminal multiplexer for coding agents. It is the desktop counterpart of `herdr-mobile`: one window shows every agent on every machine, says the moment one needs you, lets you answer safely, and lets you look away.

Built with [nsh](https://github.com/longbridge/nsh) (Rust + TSX, native GTK 4 widgets, no web view for the UI). Linux first. License: GPL-3.0-or-later.

## What it does

- **Board.** Agents grouped by what they need from you: `Needs you`, `To review`, `Working`, `Idle`, with one count shared by the status line, the window title and notifications.
- **Answer.** Permission prompts of terminal agents become buttons showing the exact command. Risky answers are two-step. Nothing is sent when the question changed.
- **Watch and steer.** A live mirror of each pane, a composer, a key row, an opt-in typing mode, links, slash commands.
- **Many machines.** This computer plus any machine reachable with `ssh` (your `~/.ssh/config`, agent and ProxyJump are honoured; no password prompts).
- **Agent sessions.** ACP agents (for example `omp acp`) started from the app, with a chat transcript, a permission dock and replay after a restart.
- **Accessible.** Screen-reader roles and labels on every control, keyboard everywhere, contrast-tested themes, reduced motion.

Feature-by-feature status against the phone app is in [docs/PARITY.md](docs/PARITY.md).

## Status

Under construction. `docs/PARITY.md` is the ledger of what is done.

## Build

Needs Linux with GTK 4.14+, `libgtk-4-dev`, `clang`, `pkg-config`, and [nsh](https://nsh.dev) 0.4.0:

```sh
NSH_VERSION=v0.4.0 sh -c "$(curl -fsSL https://nsh.dev/install.sh)"
make        # check, test, core, docs, a11y
make run    # dev window
```

[AGENTS.md](AGENTS.md) is how to work here, [DESIGN.md](DESIGN.md) the design system, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how the pieces fit.
