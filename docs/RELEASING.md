# Releasing

## The versioning rule

- **Stable releases** are `0.1.x` and move by patch only, unless the owner says otherwise.
- **Alphas, betas and release candidates** are `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` and `X.Y.Z-rc.N` (semver pre-releases of the stable version they lead to). The first alpha is `0.1.0-alpha.1`; the next ones are `0.1.0-alpha.2`, ..., and the first stable release is `0.1.0`. They are published as GitHub **pre-releases**.
- The tag is `v` plus the version. `nsh.json` `version` and the `version` of `native/core/Cargo.toml` and `native/app/Cargo.toml` are one string, exactly the tag without its `v`: `release.yml` refuses a tag when any of them differs, or when the tag is not `vX.Y.Z` or `vX.Y.Z-(alpha|beta|rc).N`.

Why a pre-release string is allowed in `nsh.json`: `nsh package` takes `version` as an opaque string (`crates/nsh-cli/src/package.rs` copies it into `app.json` and, on macOS, `CFBundleShortVersionString`; nothing parses it), and `nsh check` and Cargo accept it. The release workflow's dry run builds both packages with it.

The in-app update check (`lib/updates.ts`) reads the latest **non-pre-release** and compares `x.y.z`; a pre-release build never parses, so an alpha is not told about a newer alpha or about the stable release. That is deliberate for now: alpha testers update by hand.

## Steps

1. Everything for the release is merged and CI is green on `main` for both jobs (`.github/workflows/ci.yml`: `linux` runs `make verify` under Xvfb, `macos` runs `make verify-mac`).
2. Dry run: `gh workflow run release.yml -f tag=vX.Y.Z` builds, verifies and packages both systems and keeps the files as workflow artifacts without publishing. Download them with `gh run download <id>` and look at them.
3. Move the three versions together: `nsh.json` `version` (and `build` when the package must be distinguishable from the last one), then the two `Cargo.toml` files. Run `cargo check --manifest-path native/core/Cargo.toml` and the same for `native/app` so both `Cargo.lock` files follow.
4. In `CHANGELOG.md` rename `## [Unreleased]` content into `## [X.Y.Z] - YYYY-MM-DD` and keep a fresh empty `## [Unreleased]` above it. The section is the release notes, so it says what works, what does not and how to install. `release.yml` fails when the version has no section.
5. Commit: `chore(release): X.Y.Z, <headline>`.
6. Tag and push (the remote is `https://github.com/tuan3w/herdr-desktop.git`):

   ```sh
   git tag -a vX.Y.Z -m "Herdr Desktop X.Y.Z"
   git push origin main vX.Y.Z
   ```

   The tag starts `release.yml`: `prepare` checks the tag against the three versions and extracts the changelog section; `build` runs on `ubuntu-24.04` and `macos-15` (verify, package, name the archive); `publish` creates the GitHub release (with `--prerelease` for a `-` version) with the two archives, `SHA256SUMS` and those notes.
7. Open the release page and read the notes once.

Never move or delete a published tag; fix forward with the next version.

## What a release holds

| File | Built on | For |
|---|---|---|
| `Herdr-Desktop-<version>-linux-x86_64.tar.gz` | `ubuntu-24.04` | Linux with GTK 4.14+, glibc 2.39+ |
| `Herdr-Desktop-<version>-macos-arm64.zip` | `macos-15` | Apple silicon Macs, containing `Herdr Desktop.app` (made with `ditto -c -k --keepParent`, which keeps permissions and the signature) |
| `SHA256SUMS` | | `sha256sum -c SHA256SUMS --ignore-missing` |

**No Intel Mac build.** nsh 0.4.0 publishes its macOS CLI and runtime for arm64 only (`nsh-macos-arm64.tar.gz` is the one macOS asset of its v0.4.0 release), so there is nothing to package an x86_64 app with, whatever the runner (`macos-15-intel` exists and starts).

## Installing a release

Linux:

```sh
tar -xzf Herdr-Desktop-X.Y.Z-linux-x86_64.tar.gz          # unpacks "Herdr Desktop/"
PACKAGE=Herdr-Desktop-X.Y.Z-linux-x86_64.tar.gz local/install.sh
local/install.sh --uninstall
```

The package needs GTK 4.14 or newer, Pango and WebKitGTK 6.0 at run time (Ubuntu 24.04 and later: `libgtk-4-1`, `libwebkitgtk-6.0-4`; GNOME desktops have them), and glibc 2.39 or newer: nsh's Linux runner is built on Ubuntu 24.04. It needs `herdr` on the machines you supervise, and `ssh` for remote ones.

macOS (`docs/MACOS.md` has the details):

```sh
unzip Herdr-Desktop-X.Y.Z-macos-arm64.zip
xattr -dr com.apple.quarantine "Herdr Desktop.app"
```

## The packages

`make package` runs `nsh package . --target <linux|macos> -o .scratch/dist` for the system it runs on.

- **Linux:** a directory `Herdr Desktop/` with the executable `HerdrDesktop`, `nsh/` (the bundle, assets, `app.json`, `capabilities.json`), `dev.herdrmobile.herdr_desktop.desktop` and `.png` (the icon, `icon.png` named in `nsh.json`), and the same as `Herdr Desktop.tar.gz`. `icon.svg` is the vector source of the icon; `local/install.sh` also installs it as the scalable icon.
- **macOS:** `Herdr Desktop.app`, signed ad hoc by nsh.

The app's declared reach is `nsh.json` `capabilities`: the clipboard, `openUrl` for `https`, `http` and `mailto`, one network rule (GET `https://api.github.com/repos/tuan3w/herdr-desktop/releases/latest`, for the update check) and a web view for `127.0.0.1`. Rust code (ssh, sockets, files) runs with the process's own permissions and needs no capability. Adding a capability is a change to the app's audit surface: say why in the commit.

## When something fails

- **Tag does not match**: delete the tag locally and on the remote only if no release was created from it, fix the versions, tag again. If a release exists, bump the version instead.
- **`make verify` fails only in CI**: download the `diagnostics-linux` artifact of the run (AT-SPI tree dumps and screenshots) before guessing.
- **A macOS runner does not start** (`The configuration 'macos-14-arm64-us-default' is not supported`): the label is gone for this repository; a probe run on 2026-11-07 showed `macos-15`, `macos-26` and `macos-latest` start. Change `runs-on` in `ci.yml` and `release.yml` together.
