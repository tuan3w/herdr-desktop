#!/usr/bin/env bash
# Signs a packaged Herdr Desktop.app with the one identity every build uses, so the keychain and the permissions macOS
# remembers recognise the app after an update.
#
#   scripts/sign-macos.sh ".scratch/dist/Herdr Desktop.app"
#
# `nsh package` signs ad hoc, and an ad hoc signature is identified by the hash of the code (`cdhash`): it changes with every
# build, so anything the system tied to the app (a keychain item, a granted permission) is asked again after each update. With a
# certificate the designated requirement is `identifier "dev.herdrmobile.herdr_desktop" and certificate root = H"<hash>"`, the
# same in every build. The certificate is self-signed (no Apple developer account), so Gatekeeper still wants a first
# right-click > Open, or `xattr -dr com.apple.quarantine`; notarization needs a Developer ID (docs/MACOS.md).
#
# The identity is `HERDR_SIGN_P12` (base64 of the .p12) with `HERDR_SIGN_PASSWORD` in the environment (CI), or the files of
# ~/.herdr-desktop-signing (a Mac that made it with scripts/make-signing-identity.sh). Without either the app keeps nsh's ad hoc
# signature, the script says so and exits 0: a build from a fork still works. The private key never reaches a log or a
# command line: the password is read from a file, the identity from a file.
set -euo pipefail
app="${1:?usage: sign-macos.sh path/to/Herdr Desktop.app}"
ID="dev.herdrmobile.herdr_desktop"
NAME="Herdr Desktop (self-signed)"
home="${HERDR_SIGNING_HOME:-$HOME/.herdr-desktop-signing}"
work="$(mktemp -d)"
old=""
cleanup() {
  [ -z "$old" ] || security list-keychains -d user -s $old >/dev/null 2>&1 || true
  security delete-keychain "$work/sign.keychain-db" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

umask 077
if [ -n "${HERDR_SIGN_P12:-}" ] && [ -n "${HERDR_SIGN_PASSWORD:-}" ]; then
  printf '%s' "$HERDR_SIGN_P12" | base64 --decode > "$work/identity.p12"
  printf '%s' "$HERDR_SIGN_PASSWORD" > "$work/p12.pass"
elif [ -f "$home/identity.p12" ] && [ -f "$home/p12.pass" ]; then
  cp "$home/identity.p12" "$work/identity.p12"
  cp "$home/p12.pass" "$work/p12.pass"
else
  echo "sign-macos: no signing identity (HERDR_SIGN_P12 and HERDR_SIGN_PASSWORD, or $home): the app keeps its ad hoc signature, and the keychain asks again after every update." >&2
  exit 0
fi

# A keychain of its own, so the login keychain is never touched and nothing outlives this run.
kc="$work/sign.keychain-db"
kcpass="$(uuidgen)"
security create-keychain -p "$kcpass" "$kc"
security set-keychain-settings -lut 600 "$kc"
security unlock-keychain -p "$kcpass" "$kc"
# `security import` has no way to read the password from a file or stdin (`-P` is an argument, `-p` prompts on a terminal), so
# it is on the command line of that one process for an instant. On a CI runner that is the job's own machine; on a Mac
# with other users it is visible to `ps`, the cost of this tool.
security import "$work/identity.p12" -k "$kc" -P "$(cat "$work/p12.pass")" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kcpass" "$kc" >/dev/null
old="$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$kc" $old

# --timestamp=none: a self-signed certificate has no timestamp authority to ask, and asking would only fail offline.
codesign --force --deep --timestamp=none --keychain "$kc" --sign "$NAME" --identifier "$ID" "$app"
codesign --verify --deep --strict "$app"
codesign -dr - "$app" 2>&1 | sed -n 's/^designated => /designated requirement: /p'
