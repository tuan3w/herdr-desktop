#!/bin/sh
# Install Herdr Desktop from a GitHub release, on Linux (x86_64) or macOS (Apple silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh -s -- --version 0.1.0-alpha.2
#   curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh -s -- --uninstall
#
# Options
#   --version X.Y.Z[-alpha.N]   install that release (default: the newest one, pre-releases included)
#   --uninstall                 remove what this script put there (your data stays)
#   --help                      this text
#
# Environment
#   PREFIX=DIR                  Linux: install under DIR instead of ~/.local
#   APP_DIR=DIR                 macOS: put "Herdr Desktop.app" in DIR instead of ~/Applications
#   HERDR_DESKTOP_BASE=URL      download from URL/<asset> instead of the GitHub release (a test run, a mirror)
#
# What it does: downloads the archive and SHA256SUMS, refuses to install when the checksum does not match,
# unpacks into a temporary folder, then replaces the previous install as a whole.
#   Linux  opt/herdr-desktop/, bin/herdr-desktop, share/applications/<id>.desktop, share/icons/hicolor/512x512/apps/<id>.png
#          Needs GTK 4.14+ and WebKitGTK 6.0 at run time (libgtk-4-1, libwebkitgtk-6.0-4 on Debian/Ubuntu).
#   macOS  ~/Applications/Herdr Desktop.app, quarantine flag removed, signature verified. Apple silicon only
#          (nsh 0.4.0 has no Intel runtime). The app is signed with the project's own certificate, not notarized.
# It never uses sudo and only removes paths it owns.
set -eu

REPO="tuan3w/herdr-desktop"
ID="dev.herdrmobile.herdr_desktop"
EXE="HerdrDesktop"
APP="Herdr Desktop"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

version=""
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; version="${2#v}"; shift 2 ;;
    --version=*) version="${1#--version=}"; version="${version#v}"; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "unsupported system $(uname -s): Herdr Desktop has builds for Linux x86_64 and macOS Apple silicon" ;;
esac
arch="$(uname -m)"
case "$os-$arch" in
  linux-x86_64|linux-amd64) target=linux-x86_64; ext=tar.gz ;;
  macos-arm64) target=macos-arm64; ext=zip ;;
  macos-x86_64) die "no Intel Mac build: nsh 0.4.0 publishes its macOS runtime for Apple silicon only" ;;
  *) die "no build for $os on $arch (available: linux-x86_64, macos-arm64)" ;;
esac

prefix="${PREFIX:-$HOME/.local}"
opt="$prefix/opt/herdr-desktop"
bin="$prefix/bin/herdr-desktop"
desktop="$prefix/share/applications/$ID.desktop"
icons="$prefix/share/icons/hicolor"
apps="${APP_DIR:-$HOME/Applications}"

refresh_caches() {
  [ -z "${PREFIX:-}" ] || return 0
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$prefix/share/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
}

if [ "$uninstall" = 1 ]; then
  if [ "$os" = linux ]; then
    rm -rf "$opt"
    rm -f "$bin" "$desktop" "$icons/512x512/apps/$ID.png" "$icons/scalable/apps/$ID.svg"
    refresh_caches
    say "removed Herdr Desktop from $prefix (your data in ~/.local/share/$ID stays)"
  else
    rm -rf "$apps/$APP.app"
    say "removed $apps/$APP.app (your data in ~/Library/Application Support/$ID stays)"
  fi
  exit 0
fi

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "needs curl or wget"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "needs sha256sum or shasum to verify the download"; fi
}

work="$(mktemp -d "${TMPDIR:-/tmp}/herdr-desktop-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -z "$version" ]; then
  [ -z "${HERDR_DESKTOP_BASE:-}" ] || die "give --version with HERDR_DESKTOP_BASE"
  say "looking for the newest release..."
  fetch "https://api.github.com/repos/$REPO/releases?per_page=1" "$work/latest.json"
  tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$work/latest.json" | head -1)"
  [ -n "$tag" ] || die "could not read the newest release from GitHub (rate limited? try --version)"
  version="${tag#v}"
fi
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "'$version' is not a version like 0.1.0 or 0.1.0-alpha.2" ;;
esac
case "$version" in *[!A-Za-z0-9.-]*) die "'$version' has characters a version does not" ;; esac

asset="Herdr-Desktop-$version-$target.$ext"
base="${HERDR_DESKTOP_BASE:-https://github.com/$REPO/releases/download/v$version}"
say "installing Herdr Desktop $version ($target)"
fetch "$base/$asset" "$work/$asset" || die "could not download $base/$asset (is $version a release?)"
fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || die "could not download $base/SHA256SUMS"

want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$work/SHA256SUMS")"
[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
got="$(sha256_of "$work/$asset")"
[ "$got" = "$want" ] || die "checksum mismatch for $asset (expected $want, got $got): nothing was installed"
say "checksum ok"

if [ "$os" = linux ]; then
  tar -xzf "$work/$asset" -C "$work"
  src="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -x "$src/$EXE" ] || die "the archive has no $EXE"

  rm -rf "$opt"
  mkdir -p "$opt" "$(dirname "$bin")" "$(dirname "$desktop")" "$icons/512x512/apps"
  cp -a "$src/." "$opt/"
  ln -sf "$opt/$EXE" "$bin"
  # The package's launcher says Exec=HerdrDesktop, which needs a PATH that has it: make it absolute.
  sed "s|^Exec=.*|Exec=\"$opt/$EXE\"|" "$opt/$ID.desktop" > "$desktop"
  install -m 0644 "$opt/$ID.png" "$icons/512x512/apps/$ID.png"
  refresh_caches

  say "installed to $opt"
  say "run it from the application menu, or: $bin"
  case ":$PATH:" in *":$prefix/bin:"*) ;; *) say "note: $prefix/bin is not on your PATH; the menu entry does not need it" ;; esac
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | grep -q 'libgtk-4\.so' || say "warning: GTK 4 was not found (Debian/Ubuntu: sudo apt install libgtk-4-1)"
    ldconfig -p 2>/dev/null | grep -q 'libwebkitgtk-6\.0' || say "warning: WebKitGTK 6.0 was not found (Debian/Ubuntu: sudo apt install libwebkitgtk-6.0-4); pages from a machine need it"
  fi
else
  command -v unzip >/dev/null 2>&1 || die "needs unzip"
  unzip -q "$work/$asset" -d "$work/app"
  [ -d "$work/app/$APP.app" ] || die "the archive has no $APP.app"
  if command -v codesign >/dev/null 2>&1; then
    codesign --verify --deep --strict "$work/app/$APP.app" 2>/dev/null || die "the app's signature does not verify: nothing was installed"
    say "signature ok"
  fi
  mkdir -p "$apps"
  rm -rf "$apps/$APP.app"
  mv "$work/app/$APP.app" "$apps/$APP.app"
  # Gatekeeper does not know the project's certificate: clear the flag a download would carry, so it opens first time.
  xattr -dr com.apple.quarantine "$apps/$APP.app" 2>/dev/null || true
  say "installed to $apps/$APP.app"
  say "open it from Launchpad or Finder, or: open \"$apps/$APP.app\""
fi
