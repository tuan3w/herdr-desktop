# macOS

Herdr Desktop builds and packages for Apple silicon Macs (macOS 14 or newer: nsh's AppKit backend needs `NSView` display links). **Nobody has run it on a Mac yet**: CI builds it, runs the headless tests and signs the package, and that is all that is verified (see "Unverified").

## Installing

```sh
unzip Herdr-Desktop-<version>-macos-arm64.zip           # contains "Herdr Desktop.app"
xattr -dr com.apple.quarantine "Herdr Desktop.app"      # then drag it to Applications
```

`nsh package --target macos` signs the app ad hoc, and `scripts/sign-macos.sh` then signs it again with this project's own **self-signed** identity (`Herdr Desktop (self-signed)`, see "Signing"). Neither is an Apple Developer ID and neither is notarized, so a copy downloaded with a browser carries the quarantine flag and Gatekeeper refuses it ("cannot be opened because the developer cannot be verified", or "is damaged"). Three ways through, any one is enough:

1. `xattr -dr com.apple.quarantine "Herdr Desktop.app"` before the first start (works on every version).
2. Open it once, then System Settings > Privacy & Security > `Open Anyway` (macOS 15 and later: right-click > Open no longer bypasses Gatekeeper there).
3. On macOS 14: right-click the app > `Open` > `Open`.

Anything that trusts the app by its signature (a keychain item, a granted permission) keeps trusting it after an update, because the designated requirement is the same in every release (see "Signing"). Herdr Desktop stores no secrets in the keychain, and ssh keys stay with ssh and its agent.

## Signing

| | |
|---|---|
| Identity | a self-signed RSA 3072 certificate, `CN=Herdr Desktop (self-signed), O=herdr-desktop`, valid 10 years, `keyUsage=digitalSignature`, `extendedKeyUsage=codeSigning`, `CA:false` |
| Where the key lives | `~/.herdr-desktop-signing/` of the owner (`identity.p12`, `p12.pass`, `cert.pem`, mode 0600 in a 0700 directory) and the GitHub Actions secrets `HERDR_SIGN_P12` (base64) and `HERDR_SIGN_PASSWORD`. Never in the repository (`*.p12`, `*.pem`, `*.key` are ignored) |
| Designated requirement | `identifier "dev.herdrmobile.herdr_desktop" and certificate root = H"<hash of the certificate>"` (a self-signed certificate is its own root; CI measured exactly this form)`: it names the certificate, not the code, so it is **identical in every build signed with it** |
| Why | an ad hoc signature is the hash of the code (`cdhash`) and changes with every build, so the system asked again about anything tied to the app after each update. With one certificate it does not |
| What it does not do | Gatekeeper does not know the certificate: the first launch still needs `xattr -dr com.apple.quarantine` or `Open Anyway`. It is not notarization |

`make package` on a Mac runs `nsh package`, then `scripts/sign-macos.sh` (an own temporary keychain, `codesign --force --deep --timestamp=none --identifier dev.herdrmobile.herdr_desktop`, `codesign --verify --deep --strict`, the keychain deleted on exit). Without the secrets or the local files it keeps the ad hoc signature, says so, and exits 0, so a fork's pull request still builds. CI and the release run `scripts/check-macos-signature.sh`, which prints `codesign -dvv` and the designated requirement (also in the job summary, to compare two builds) and **fails when the identity is configured but the app is still ad hoc**; the release workflow also refuses to build without the secrets.

**Rotating the identity.** `scripts/make-signing-identity.sh --force` makes a new one, then (the script's header has the exact lines) `base64 -w0 < ~/.herdr-desktop-signing/identity.p12 | gh secret set HERDR_SIGN_P12` and `gh secret set HERDR_SIGN_PASSWORD < ~/.herdr-desktop-signing/p12.pass`. A new identity is a new app to the keychain: everyone is asked once more. Losing the local copy has the same effect (the secrets cannot be read back), so keep a backup of that directory off the machine. Rotate when the key is lost or leaked or the certificate nears its end (2036).

**Notarization, later.** It needs an Apple Developer Program membership (US$99 a year) and a **Developer ID Application** certificate; none exists. When there is one: export it as a .p12 and add secrets `APPLE_DEVELOPER_ID_P12`, `APPLE_DEVELOPER_ID_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and an app-specific password `APPLE_APP_PASSWORD`; sign with `codesign --force --deep --options runtime --timestamp --sign "Developer ID Application: <name> (<team>)"` (the hardened runtime and a secure timestamp are required); `ditto -c -k --keepParent` the app, `xcrun notarytool submit <zip> --apple-id ... --team-id ... --password ... --wait`, then `xcrun stapler staple "Herdr Desktop.app"` and zip again. Whether nsh's runner works under the hardened runtime (it loads QuickJS and bundles code) is **unverified**: it may need entitlements. The designated requirement would change once, to the Developer ID, so the keychain asks once more at that update.

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
