# Releasing

Versions are `0.1.x` and move by patch only, unless the owner says otherwise. `nsh.json` `version` and the `version` of `native/core/Cargo.toml` and `native/app/Cargo.toml` are one number: `release.yml` refuses a tag when any of them differs.

## Steps

1. Everything for the release is merged and `make` is green on the machine you release from (`nsh check`, `nsh test`, `make core`, `make docs`, `make a11y`). CI runs the same on every push (`.github/workflows/ci.yml`).
2. Move the three versions together: `nsh.json` `version` (and `build` when the package must be distinguishable from the last one), then the two `Cargo.toml` files. Run `cargo check --manifest-path native/core/Cargo.toml` and the same for `native/app` so both `Cargo.lock` files follow.
3. In `CHANGELOG.md` rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh empty `## [Unreleased]` above it. The section is the release notes, so it says what changed for the person using the app. `release.yml` fails when the version has no section.
4. Commit: `chore(release): X.Y.Z, <headline>`.
5. Tag and push (the remote is `https://github.com/tuan3w/herdr-desktop.git`):

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   The tag starts `.github/workflows/release.yml`: it checks the tag against the three versions, extracts the changelog section, runs `make verify` under Xvfb, runs `make package`, and creates the GitHub release with `herdr-desktop-X.Y.Z-linux-x86_64.tar.gz`, its `.sha256` and those notes.
6. Open the release page and read the notes once. The in-app update check (Settings > About, `lib/updates.ts`) offers the release to everyone with the check on as soon as it is published and is not a draft or a pre-release.

Never move or delete a published tag; fix forward with the next patch.

## Installing a release

```sh
tar -xzf herdr-desktop-X.Y.Z-linux-x86_64.tar.gz     # unpacks "Herdr Desktop/"
sha256sum -c herdr-desktop-X.Y.Z-linux-x86_64.tar.gz.sha256
PACKAGE=herdr-desktop-X.Y.Z-linux-x86_64.tar.gz local/install.sh
local/install.sh --uninstall
```

The package needs GTK 4.14 or newer, Pango and WebKitGTK 6.0 at run time (Ubuntu 24.04 and later: `libgtk-4-1`, `libwebkitgtk-6.0-4`; GNOME desktops have them), and glibc 2.39 or newer: nsh's Linux runner is built on Ubuntu 24.04. It needs `herdr` on the machines you supervise, and `ssh` for remote ones.

## The package

`make package` runs `nsh package . --target linux -o .scratch/dist`. The result is a directory `Herdr Desktop/` with the executable `HerdrDesktop`, `nsh/` (the bundle, assets, `app.json`, `capabilities.json`), `dev.herdrmobile.herdr_desktop.desktop` and `.png` (the icon, `icon.png` named in `nsh.json`), and the same as `Herdr Desktop.tar.gz`. `icon.svg` is the vector source of the icon; `local/install.sh` also installs it as the scalable icon.

The app's declared reach is `nsh.json` `capabilities`: the clipboard, `openUrl` for `https`, `http` and `mailto`, and one network rule (GET `https://api.github.com/repos/tuan3w/herdr-desktop/releases/latest`, for the update check). Rust code (ssh, sockets, files) runs with the process's own permissions and needs no capability. Adding a capability is a change to the app's audit surface: say why in the commit.

## When something fails

- **Tag does not match**: delete the tag locally and on the remote only if no release was created from it, fix the versions, tag again. If a release exists, bump the patch instead.
- **`make verify` fails only in CI**: download the `diagnostics` artifact of the run (AT-SPI tree dumps and screenshots) before guessing.
- **The GitHub-hosted run has never been exercised from this machine**: the workflows are validated here with `actionlint` and a YAML parse, not by a run.
