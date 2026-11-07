#!/usr/bin/env bash
# Install Herdr Desktop for the current user, or remove it again.
#
#   local/install.sh                  build the package (make package) and install it
#   local/install.sh --uninstall      remove what an install put there
#   SKIP_BUILD=1 local/install.sh     reuse .scratch/dist/ from the last `make package`
#   PACKAGE=path/to/Herdr\ Desktop.tar.gz local/install.sh   install a release tarball instead of building
#   PREFIX=/tmp/x local/install.sh    put everything under PREFIX instead of ~/.local (a test run never touches your home)
#
# Layout under PREFIX (default ~/.local):
#   opt/herdr-desktop/              the package (the binary, nsh/ with the bundle and assets)
#   bin/herdr-desktop               a link to the binary
#   share/applications/<id>.desktop the launcher entry; its Exec is the absolute path of the installed binary, so it
#                                   works when ~/.local/bin is not on the desktop session's PATH
#   share/icons/hicolor/512x512/apps/<id>.png and scalable/apps/<id>.svg
#
# Needs at run time: GTK 4.14+, Pango and WebKitGTK 6.0 (libwebkitgtk-6.0-4 on Debian/Ubuntu).
# Only removes paths this script owns; your data (~/.local/share/dev.herdrmobile.herdr_desktop) stays.
set -euo pipefail

ID="dev.herdrmobile.herdr_desktop"
EXE="HerdrDesktop"
root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="${PREFIX:-$HOME/.local}"
opt="$prefix/opt/herdr-desktop"
bin="$prefix/bin/herdr-desktop"
desktop="$prefix/share/applications/$ID.desktop"
icons="$prefix/share/icons/hicolor"

refresh_caches() {
  # Only the real user prefix has caches the desktop reads; a test prefix has none.
  [[ -z "${PREFIX:-}" ]] || return 0
  command -v update-desktop-database >/dev/null && update-desktop-database "$prefix/share/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$opt"
  rm -f "$bin" "$desktop" "$icons/512x512/apps/$ID.png" "$icons/scalable/apps/$ID.svg"
  refresh_caches
  echo "removed Herdr Desktop from $prefix"
  exit 0
fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--uninstall]" >&2; exit 64; }

work="$(mktemp -d "${TMPDIR:-/tmp}/herdr-desktop-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [[ -n "${PACKAGE:-}" ]]; then
  tar -xzf "$PACKAGE" -C "$work"
  src="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)"
else
  if [[ -z "${SKIP_BUILD:-}" ]]; then
    # The GTK dev files: the system's, else the user-space sysroot of the dev machine.
    if ! pkg-config --exists gtk4 2>/dev/null && [[ -f "$root/.scratch/sysroot/env.sh" ]]; then
      # shellcheck disable=SC1091
      . "$root/.scratch/sysroot/env.sh"
    fi
    (cd "$root" && make package)
  fi
  src="$root/.scratch/dist/Herdr Desktop"
fi
[[ -x "$src/$EXE" ]] || { echo "no $EXE in '$src': run make package, or give PACKAGE=<tarball>" >&2; exit 66; }

# Replace the old install as a whole so a file that a newer version dropped does not stay.
rm -rf "$opt"
mkdir -p "$opt" "$(dirname "$bin")" "$(dirname "$desktop")" "$icons/512x512/apps" "$icons/scalable/apps"
cp -a "$src/." "$opt/"
ln -sf "$opt/$EXE" "$bin"

# The package's launcher says `Exec=HerdrDesktop`, which only works from a PATH that has it: make it absolute.
sed "s|^Exec=.*|Exec=\"$opt/$EXE\"|" "$opt/$ID.desktop" > "$desktop"
install -m 0644 "$opt/$ID.png" "$icons/512x512/apps/$ID.png"
if [[ -f "$root/icon.svg" ]]; then install -m 0644 "$root/icon.svg" "$icons/scalable/apps/$ID.svg"; fi
refresh_caches

echo "installed Herdr Desktop to $opt"
echo "run it with: $bin"
case ":$PATH:" in *":$prefix/bin:"*) ;; *) echo "note: $prefix/bin is not on your PATH; the launcher entry does not need it" ;; esac
