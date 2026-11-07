# Releasing

## The versioning rule

- **Stable releases** are `0.1.x` and move by patch only, unless the owner says otherwise.
- **Alphas, betas and release candidates** are `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` and `X.Y.Z-rc.N` (semver pre-releases of the stable version they lead to). The first alpha is `0.1.0-alpha.1`; the next ones are `0.1.0-alpha.2`, ..., and the first stable release is `0.1.0`. They are published as GitHub **pre-releases**.
- The tag is `v` plus the version. `nsh.json` `version` and the `version` of `native/core/Cargo.toml` and `native/app/Cargo.toml` are one string, exactly the tag without its `v`: `release.yml` refuses a tag when any of them differs, or when the tag is not `vX.Y.Z` or `vX.Y.Z-(alpha|beta|rc).N`.

Why a pre-release string is allowed in `nsh.json`: `nsh package` takes `version` as an opaque string (`crates/nsh-cli/src/package.rs` copies it into `app.json` and, on macOS, `CFBundleShortVersionString`; nothing parses it), and `nsh check` and Cargo accept it. The release workflow's dry run builds both packages with it.

The in-app update check (`lib/updates.ts`) reads the latest **non-pre-release** and compares `x.y.z`; a pre-release build never parses, so an alpha is not told about a newer alpha or about the stable release. That is deliberate for now: alpha testers update by hand.

## Steps

1. Everything for the release is merged and the last push to `main` is green: `macos-package` and `macos-lint` of `.github/workflows/ci.yml`. The slow checks are not on that path: run `gh workflow run tests.yml --ref main` (macOS: `nsh check`, both crates' fmt/clippy/tests, every TSX test) and read it before tagging a stable release (`make verify-mac` also runs in the stable release itself).
2. Dry run: `gh workflow run release.yml -f tag=vX.Y.Z` (after step 3's version bump is on the ref you run it from, `--ref <branch>`) checks the notes, builds, signs, zips and checksums the macOS app and keeps the files as workflow artifacts without publishing. Download them with `gh run download <id>` and look at them. A tag whose `## [X.Y.Z]` section of `CHANGELOG.md` is missing, empty or off-format fails in the first job, before anything is built.
3. Move the three versions together: `nsh.json` `version` (and `build` when the package must be distinguishable from the last one), then the two `Cargo.toml` files. Run `cargo check --manifest-path native/core/Cargo.toml` and the same for `native/app` so both `Cargo.lock` files follow.
4. In `CHANGELOG.md` rewrite `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` and keep a fresh empty `## [Unreleased]` above it. The section **is** the release notes (the release page shows it verbatim), in the outcome-card format of `.agents/skills/herdr-changelog/SKILL.md`: a `###` headline in the person's words, a short paragraph, at most 3 `> [!TIP]` Try-it cards, bullets, `**Fixed**`, `**Not checked**`. Check it with `node scripts/check-changelog.mjs X.Y.Z`; `release.yml` runs the same check and fails when the section is missing, empty or off-format. Pictures are release assets, never files in git (step 7).
5. Commit: `chore(release): X.Y.Z, <headline>`.
6. Tag and push (the remote is `https://github.com/tuan3w/herdr-desktop.git`):

   ```sh
   git tag -a vX.Y.Z -m "Herdr Desktop X.Y.Z"
   git push origin main vX.Y.Z
   ```

   The tag starts `release.yml`: `prepare` checks the tag against the three versions and extracts and checks the changelog section; `build-macos` runs on `macos-15` (verify for a stable release, package, sign, zip, checksum); `publish` creates the GitHub release (with `--prerelease` for a `-` version) with the zip, `SHA256SUMS` and those notes. No Linux archive: Linux is paused (below).
7. Pictures, if the notes name any: render them into `local/release-media/X.Y.Z/` as `X.Y.Z-<slug>.png` (the skill, section 6), check them with `scripts/release-media.sh X.Y.Z`, and once the release is published run `scripts/release-media.sh X.Y.Z --upload` (`gh release upload vX.Y.Z local/release-media/X.Y.Z/*`, then an HTTP 200 check of every URL in the notes). They are never committed.
8. Open the release page and read the notes once.

Never move or delete a published tag; fix forward with the next version.

## What a release holds

| File | Built on | For |
|---|---|---|
| `Herdr-Desktop-<version>-macos-arm64.zip` | `macos-15` | Apple silicon Macs, containing `Herdr Desktop.app` (made with `ditto -c -k --keepParent`, which keeps permissions and the signature) |
| `SHA256SUMS` | | `shasum -a 256 -c SHA256SUMS --ignore-missing` |
| `<version>-<slug>.png` | | pictures the notes show (uploaded by hand, step 7) |

Releases `0.1.0-alpha.1` to `alpha.3` also have `Herdr-Desktop-<version>-linux-x86_64.tar.gz`; later ones do not (see "Linux (paused)").

**No Intel Mac build.** nsh 0.4.0 publishes its macOS CLI and runtime for arm64 only (`nsh-macos-arm64.tar.gz` is the one macOS asset of its v0.4.0 release), so there is nothing to package an x86_64 app with, whatever the runner (`macos-15-intel` exists and starts).

## The edge build

Every push to `main` that packages (`macos-package` green) replaces the pre-release **`edge`** on the Releases page: the signed zip of that commit (`Herdr-Desktop-edge-<short hash>-macos-arm64.zip`), `SHA256SUMS`, and as notes the `## [Unreleased]` section of `CHANGELOG.md` (so a feat or fix commit adds its bullet there, SKILL section 2). `scripts/install.sh --edge` installs it. The `edge` job of `ci.yml` is the only one with a write token; it deletes the release and its tag and creates them again, one at a time (`concurrency: edge`, never cancelled half-way). `edge` is not a version: the installer without a version and the in-app update check skip it, and nothing is ever tagged `vX` from it.

## Installing a release

One command: `curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh` (`scripts/install.sh`: downloads the newest release or `--version X` or the rolling `--edge` build, verifies `SHA256SUMS`, installs, `--uninstall` removes). On Linux it says `no Linux build in this release: Linux builds are paused, build from source (README)` when the release has no Linux archive. By hand:

Linux (only the alphas 1 to 3 have an archive):

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
- **macOS:** `Herdr Desktop.app`, signed ad hoc by nsh and then with the project's self-signed identity by `scripts/sign-macos.sh` (secrets `HERDR_SIGN_P12`, `HERDR_SIGN_PASSWORD`; `docs/MACOS.md`, "Signing", has rotation and notarization). `release.yml` refuses to build the macOS app without the secrets and fails if the result is ad hoc. Compare `designated =>` in the job summaries of two releases: it must be identical.

The app's declared reach is `nsh.json` `capabilities`: the clipboard, `openUrl` for `https`, `http` and `mailto`, one network rule (GET `https://api.github.com/repos/tuan3w/herdr-desktop/releases/latest`, for the update check) and a web view for `127.0.0.1`. Rust code (ssh, sockets, files) runs with the process's own permissions and needs no capability. Adding a capability is a change to the app's audit surface: say why in the commit.

## The terminal prototype is not in a release build

`native/app` has a cargo feature `terminal` (the `Terminal` component, `docs/specs/terminal.md`), off by default. A default build, which is what `make check`, `make core`, `make test` and `make package` run, compiles none of libghostty-vt and needs no zig: the optional dependencies sit in `Cargo.lock` but are not built. CI and release workflows are unchanged. Shipping the terminal later means a runner with zig 0.15.2 on `PATH` (a 51 MB download) and network access for the first build (the crate clones ghostty): about 2 minutes cold and 412 MB of build output, per target; or an installed library found through `PKG_CONFIG_PATH`. The owner decides before it is turned on.

## Linux (paused)

The owner is focusing on macOS, so Linux is not built on a push and not in a release (`0.1.0-alpha.4` and later hold the macOS zip only). Nothing was deleted: the code, the `Makefile` targets and the jobs work and are run by hand.

```sh
gh workflow run ci-linux.yml --ref main        # the four Linux jobs: check, test, a11y (Xvfb + AT-SPI), package
gh workflow run release.yml --ref main -f tag=vX.Y.Z -f linux=true   # a dry run that also builds the Linux archive (never published)
make verify                                    # on a Linux machine: check, test, core, docs, a11y
make package                                   # .scratch/dist/Herdr Desktop.tar.gz
```

To bring Linux back on every push, add `push: branches: [main]` under `on:` in `ci-linux.yml`; to ship it, make `build-linux` of `release.yml` run on a tag and list it in `publish`'s `needs`.

## The tests, by hand

`ci.yml` (every push) only packages and lints. Everything slow is `tests.yml`, nightly at 02:17 UTC and on demand:

```sh
gh workflow run tests.yml --ref main           # macOS: nsh check, oxlint/oxfmt/imports, docs, both crates' fmt + clippy -D warnings + tests, every TSX test
make verify-mac                                # the same minus the whole TSX suite, on a Mac (the smoke subset runs instead)
make test                                      # every TSX test, on any machine with nsh
```

## How the CI is kept fast

Measured on `macos-15` runners (3 cores) on 2026-11-07; every number is a job or step time from `gh run view <id> --json jobs`. "Warm" means the cache restored exactly; "cold" means none.

| | Before (`ci.yml`, per push) | After |
|---|---|---|
| `macos-package`, warm | 2 min 16 s to 2 min 30 s (setup 60 s, `make package` 67 to 89 s, zip and upload 5 s) | **69 s** (setup 36 s, `make package` 22 s, zip and upload 5 s) |
| `macos-check` / `macos-lint`, warm | 3 min 36 s (setup 62 s, `make verify-mac` 155 s) | **72 s** (checks 6 s, toolchain 8 s, nsh 15 s, cache 16 s, `nsh check` 15 s) |
| `macos-package`, cold | 7 min 43 s to 8 min 37 s | about 11 min (`make package` 622 s, with three other macOS jobs running) |
| Linux jobs per push (4) | about 8 min | none (`ci-linux.yml`, by hand) |
| TSX change only, warm | same as any warm run | `make package` 21 s: no Rust is compiled |
| Rust change, warm | same | `make package` 101 s, plus a 17 s cache save |

What each change saved:

- **Linux and the slow tests left the push path** (`ci-linux.yml`, `tests.yml`): four Linux jobs and `make verify-mac` (155 s) are gone from every push. `paths-ignore` skips docs-only pushes and `concurrency` cancels a run a newer push supersedes.
- **`scripts/ci-mtimes.sh`: 73 s to 22 s of `make package`.** Cargo calls a path crate fresh by file mtimes, and a checkout makes every file newer than the cached outputs, so every run recompiled `herdr-core` and `herdr-desktop-native` twice (debug for the types, release for the runner) and relinked a 91 MB binary. The script gives the files whose content equals what `target/` was built from the age of the cache. The cache key names `native/**`, so a change there saves a fresh cache and the next run (a TSX-only one too) is quick again. A cache saved by a cancelled run is never kept: it would be half-full under the key of a full one.
- **Debug stays in the cache.** `nsh package` builds the app crate in debug first (to read the types of the native module) and only then the release runner. A cache of `target/release` alone made the debug step 2 min 2 s instead of 24 s: restoring the 1.2 GB of debug is 5 to 10 s.
- **nsh from `actions/cache`** (607 MB): 9 to 16 s to restore against 11 to 27 s for `curl | sh`: a small saving, but no dependency on the download being quick on that day.
- **Minimal Rust profile, `RUSTUP_TOOLCHAIN` set:** 7 s; the toolchain file's `components` (clippy, rustfmt) are only installed by the jobs that use them (`macos-lint`: rustfmt; `tests.yml`: both).
- **No `bun install` and no `setup-node` in `macos-package`:** 3 s. The package job reads no `node_modules`; the lint job needs bun for oxlint and oxfmt (its own `setup-bun`, 3 s) and uses the runner's node.
- **A smaller cache per job:** registry index and crates, git db and `target/` only (no `~/.cargo/registry/src`, which cargo unpacks again in seconds). `target/` is 2.9 GB, 826 MB compressed; restore is 17 s, against 29 s for the 2.9 GB plus registry before.
- **`macos-lint` has its own cache:** `nsh check` is tsc plus `cargo check --all-targets` of the app crate, which needs the Rust toolchain and check artifacts (1.8 GB, 496 MB compressed). Cold it takes 265 s, warm 15 s; the oxlint, oxfmt, imports, theme, docs and rustfmt steps are 1 to 8 s each.

Measured and not adopted:

- **A cargo profile for CI builds.** `opt-level = 1` or `2` through `CARGO_PROFILE_RELEASE_OPT_LEVEL`: cold `make package` 581 s and 598 s, against 543 to 568 s for the default `release` (opt-level 3, no LTO, 16 codegen units, no debug info) on a quiet runner. No gain, so the shipped build is exactly the default one and nothing of its runtime speed is traded. nsh builds the runner with plain `--release` in a workspace it generates; a profile can only come from `.cargo/config.toml` or `CARGO_PROFILE_*`.
- **`Swatinem/rust-cache`, `sccache`:** not tried. The whole-`target/` cache restores in 17 s and recompiles nothing that did not change; what is left in a warm run is the 22 s of `nsh package` (types, bundle, link the runner, sign), not compilation.

The floor: a warm `macos-package` is about a minute: 36 s of setup (restoring nsh 12 s, the cache 17 s, toolchain 7 s), `nsh package` 22 s, zip and upload 5 s. A cold one is 9 to 11 minutes of compiling about 600 crates in release on 3 cores, which the cache avoids after the first run and after a lockfile change keeps partial (`restore-keys` starts from the newest older cache). ShipDesk's 3-minute cold build is not reachable here: this app has many more dependencies to compile (25 tree-sitter grammars, syntect, nsh's widget set); the opt-level measurement shows the time is not spent in LLVM optimisation.

## When something fails

- **Tag does not match**: delete the tag locally and on the remote only if no release was created from it, fix the versions, tag again. If a release exists, bump the version instead.
- **`make verify` fails only in CI**: download the `diagnostics-linux` artifact of the run (AT-SPI tree dumps and screenshots) before guessing.
- **A macOS runner does not start** (`The configuration 'macos-14-arm64-us-default' is not supported`): the label is gone for this repository; a probe run on 2026-11-07 showed `macos-15`, `macos-26` and `macos-latest` start. Change `runs-on` in `ci.yml`, `tests.yml` and `release.yml` together.
