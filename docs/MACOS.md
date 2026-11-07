# macOS

Herdr Desktop builds and packages for Apple silicon Macs (macOS 14 or newer: nsh's AppKit backend needs `NSView` display links). **Nobody has run it on a Mac yet**: CI builds it, runs the headless tests and signs the package, and that is all that is verified (see "Unverified").

## Installing

```sh
unzip Herdr-Desktop-<version>-macos-arm64.zip           # contains "Herdr Desktop.app"
xattr -dr com.apple.quarantine "Herdr Desktop.app"      # then drag it to Applications
```

`nsh package --target macos` signs the app **ad hoc** (no Apple developer account, no notarization). A copy downloaded with a browser carries the quarantine flag and Gatekeeper refuses it ("cannot be opened because the developer cannot be verified", or "is damaged"). Three ways through, any one is enough:

1. `xattr -dr com.apple.quarantine "Herdr Desktop.app"` before the first start (works on every version).
2. Open it once, then System Settings > Privacy & Security > `Open Anyway` (macOS 15 and later: right-click > Open no longer bypasses Gatekeeper there).
3. On macOS 14: right-click the app > `Open` > `Open`.

An ad hoc signature is identified by the hash of the code, so it changes with every build. Anything that trusts the app by signature (a keychain item, a firewall rule) asks again after an update. Herdr Desktop stores no secrets in the keychain, and ssh keys stay with ssh and its agent.

## What differs from Linux

| Area | On macOS | Where |
|---|---|---|
| Window and widgets | nsh's AppKit backend (`NSView`, CoreText), not GTK | nsh |
| Shortcuts | `mod` is `Cmd` (`lib/shortcuts.ts` labels it `⌘`) | `lib/shortcuts.ts` |
| Notifications | title and body through `osascript`; no buttons, no click-back, no withdrawal; listed under Script Editor in System Settings > Notifications | `native/app/src/notify/applescript.rs`, `docs/ALERTS.md` |
| Developer panel RSS, threads, open files | `proc_pidinfo` (Linux: `/proc/self`) | `native/app/src/metrics.rs` |
| ssh control sockets | `/tmp/herdr-desktop-<uid>`: a unix socket path may be 103 bytes there | `native/core/src/ssh/command.rs` `control_dir_for` |
| Data directory | `~/Library/Application Support/dev.herdrmobile.herdr_desktop` (`dirs::data_dir()`) | `native/core/src/store.rs` |
| herdr's socket | `HERDR_SOCKET_PATH`, else `~/.config/herdr/herdr.sock` as on Linux | `native/core/src/link/local.rs` |
| Accessibility gate | none: `make a11y` reads Linux's AT-SPI bus; VoiceOver is not exercised | `docs/ACCESSIBILITY.md` |
| Perf and CPU scripts, screenshots | Linux only (`/proc`, Xvfb) | `scripts/perf.mjs`, `scripts/cpu.mjs`, `make shots` |
| Crash guard (`preload_guard`) | Linux only (an `LD_PRELOAD` allocator that breaks GTK) | `native/app/src/preload_guard.rs` |

`make verify-mac` is `make verify` without `a11y`. CI runs it on `macos-15`, then packages and checks that the `.app` has its executable, an `Info.plist` and a valid ad hoc signature (`codesign --verify --deep --strict`).

## Unverified

Everything that needs a real macOS window or a Mac user:

- **Notifications**: that `display notification` from the app's `osascript` child is shown and what the person must allow; the Script Editor attribution and click behaviour are from how `osascript` is documented to behave, not from a run.
- **Web pages** (`WebView`): nsh maps it to `WKWebView`; the tunnel (`ssh -O forward`) is the same code as on Linux, the view was never opened on a Mac.
- **`Window.setFrame`** and window sizing and position: the app opens at desktop size; how AppKit places and restores it was not observed.
- **Keychain and the ssh agent**: ssh is the system's `/usr/bin/ssh` and its agent (launchd's `SSH_AUTH_SOCK`, keys added with `ssh-add --apple-use-keychain`). The app starts `ssh` with `BatchMode=yes`, so a key that needs a passphrase the agent does not hold fails as `AuthFailed` rather than asking. A GUI app started from Finder does not read your shell's environment: a custom `SSH_AUTH_SOCK` or `HERDR_SOCKET_PATH` set only in `~/.zshrc` is not seen.
- **python3**: the relay and the keeper are python3 scripts run on the machine being watched, and on this Mac when it is the machine. macOS ships `/usr/bin/python3` as a stub that asks to install the Xcode command line tools; until they are installed, local sessions fail with exit 78 (`python3 missing`).
- **VoiceOver, `Cmd` shortcuts and keyboard focus** in the AppKit backend: only the kit's headless tests ran.
- **herdr itself on a Mac**: whether it keeps its socket at `~/.config/herdr/herdr.sock`.
- **Apple silicon only**: no Intel build exists (nsh 0.4.0 has no x86_64 macOS runtime).
