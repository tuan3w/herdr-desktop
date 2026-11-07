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

## Disk

The data disk had 8.7 GB free when this project started. There is one `target/` (`.cargo/config.toml`); never create another. Clean it before a campaign when free space is under 6 GB.

## Live smoke against the owner's herdr

Read-only methods only (`ping`, `session.snapshot`, `pane.read`, `agent.list`), or a scratch workspace labelled `herdr-desktop-scratch` with `focus: false`, closed afterwards. Never commit or screenshot a real pane (`AGENTS.md`).
