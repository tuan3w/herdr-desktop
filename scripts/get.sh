#!/bin/sh
# Download, verify and install Herdr Desktop for the current user. Linux (x86_64) and macOS (Apple silicon); no root.
#
#   curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/get.sh | sh
#   sh get.sh --version v0.1.0-alpha.1      a given tag (default: the newest release, an alpha included)
#   sh get.sh --uninstall                   remove what an install put there
#   PREFIX=/tmp/x sh get.sh                 Linux: put everything under PREFIX instead of ~/.local (a test never touches your home)
#
# What it does: finds the release, downloads the package for this system and SHA256SUMS, stops if the checksum differs,
# then installs under your home. A file fetched by curl carries no quarantine mark, so macOS does not stop the app at
# first launch; the script clears the mark anyway and checks the signature nsh gave the app.
# Linux needs GTK 4.14+, Pango and WebKitGTK 6.0 at run time (libgtk-4-1, libwebkitgtk-6.0-4): it checks and says the
# `apt` line, it never installs packages. The app's data (~/.local/share/dev.herdrmobile.herdr_desktop) is never removed.
set -eu

REPO="tuan3w/herdr-desktop"
ID="dev.herdrmobile.herdr_desktop"
EXE="HerdrDesktop"
APP="Herdr Desktop.app"
version=""
uninstall=0

die() { printf 'herdr-desktop: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a tag, such as v0.1.0-alpha.1"; version="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1' (try --help)" ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Linux/x86_64) system="linux-x86_64"; ext="tar.gz" ;;
  Darwin/arm64) system="macos-arm64"; ext="zip" ;;
  Darwin/x86_64) die "there is no Intel Mac build: nsh 0.4.0 ships its macOS runtime for Apple silicon only" ;;
  *) die "no package for $os on $arch (releases hold Linux x86_64 and macOS arm64)" ;;
esac

prefix="${PREFIX:-$HOME/.local}"
opt="$prefix/opt/herdr-desktop"
bin="$prefix/bin/herdr-desktop"
desktop="$prefix/share/applications/$ID.desktop"
icons="$prefix/share/icons/hicolor"
apps="${APPLICATIONS:-$HOME/Applications}"

refresh_caches() {
  [ -z "${PREFIX:-}" ] || return 0
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$prefix/share/applications" 2>/dev/null || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true; fi
}

if [ "$uninstall" = 1 ]; then
  if [ "$os" = Linux ]; then
    rm -rf "$opt"
    rm -f "$bin" "$desktop" "$icons/512x512/apps/$ID.png" "$icons/scalable/apps/$ID.svg"
    refresh_caches
    say "removed Herdr Desktop from $prefix"
  else
    rm -rf "$apps/$APP"
    say "removed $apps/$APP"
  fi
  exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is needed"
if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum or shasum is needed to check the download"; fi

if [ -z "$version" ]; then
  # The newest release, a pre-release included (`releases/latest` skips alphas).
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || die "could not find a release of $REPO (pass --version <tag>)"
fi
number="${version#v}"
package="Herdr-Desktop-$number-$system.$ext"
base="https://github.com/$REPO/releases/download/$version"

if [ "$os" = Linux ]; then
  missing=""
  command -v ldconfig >/dev/null 2>&1 || ldconfig() { /sbin/ldconfig "$@"; }
  libs="$(ldconfig -p 2>/dev/null || true)"
  case "$libs" in *libgtk-4.so.1*) ;; *) missing="$missing libgtk-4-1" ;; esac
  case "$libs" in *libwebkitgtk-6.0.so.4*) ;; *) missing="$missing libwebkitgtk-6.0-4" ;; esac
  [ -z "$missing" ] || say "note: Herdr Desktop needs$missing at run time. On Debian or Ubuntu: sudo apt-get install -y$missing"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/herdr-desktop-get.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

say "downloading Herdr Desktop $version for $system"
curl -fL --progress-bar -o "$work/$package" "$base/$package" || die "no $package in release $version"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "no SHA256SUMS in release $version"
want="$(grep "  $package\$" "$work/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$want" ] || die "SHA256SUMS does not list $package"
[ "$(sum "$work/$package")" = "$want" ] || die "the checksum of $package does not match SHA256SUMS: nothing was installed"

if [ "$os" = Linux ]; then
  tar -xzf "$work/$package" -C "$work"
  src="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -x "$src/$EXE" ] || die "the package holds no $EXE"
  # Replace the old install as a whole, so a file that a newer version dropped does not stay.
  rm -rf "$opt"
  mkdir -p "$opt" "$(dirname "$bin")" "$(dirname "$desktop")" "$icons/512x512/apps"
  cp -a "$src/." "$opt/"
  ln -sf "$opt/$EXE" "$bin"
  # The package's launcher says `Exec=HerdrDesktop`, which needs a PATH that has it: make it absolute.
  sed "s|^Exec=.*|Exec=\"$opt/$EXE\"|" "$opt/$ID.desktop" > "$desktop"
  install -m 0644 "$opt/$ID.png" "$icons/512x512/apps/$ID.png"
  refresh_caches
  say "installed Herdr Desktop $version to $opt"
  say "run it with: $bin"
  case ":$PATH:" in *":$prefix/bin:"*) ;; *) say "note: $prefix/bin is not on your PATH; the launcher entry does not need it" ;; esac
else
  command -v ditto >/dev/null 2>&1 || die "ditto is needed to unpack the app (it ships with macOS)"
  ditto -x -k "$work/$package" "$work"
  [ -d "$work/$APP" ] || die "the package holds no $APP"
  mkdir -p "$apps"
  rm -rf "$apps/$APP"
  ditto "$work/$APP" "$apps/$APP"
  xattr -dr com.apple.quarantine "$apps/$APP" 2>/dev/null || true
  codesign --verify --deep "$apps/$APP" 2>/dev/null || say "note: the app's signature did not verify; if it will not open, run: codesign --force --deep -s - \"$apps/$APP\""
  say "installed $APP $version to $apps"
  say "open it with: open \"$apps/$APP\""
fi
