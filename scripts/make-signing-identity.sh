#!/usr/bin/env bash
# Makes the self-signed code-signing identity `scripts/sign-macos.sh` signs the macOS app with, once, in
# ~/.herdr-desktop-signing (outside the repository: the private key must never be committed). To let CI sign with the
# same identity, so a build from CI and one from a Mac are one app to the keychain:
#
#   base64 < ~/.herdr-desktop-signing/identity.p12 | tr -d '\n' | gh secret set HERDR_SIGN_P12
#   gh secret set HERDR_SIGN_PASSWORD < ~/.herdr-desktop-signing/p12.pass
#
# A new identity is a new app to the keychain: everyone is asked once more, so make it again only when the old one is lost
# or leaked. It refuses to replace an existing one without --force. Nothing is printed that is secret.
set -euo pipefail
dir="${HERDR_SIGNING_HOME:-$HOME/.herdr-desktop-signing}"
force=0
[ "${1:-}" = "--force" ] && force=1
if [ -f "$dir/identity.p12" ] && [ "$force" = 0 ]; then
  echo "already there: $dir/identity.p12 (--force makes a new identity: everyone is asked by the keychain once more)" >&2
  exit 1
fi
umask 077
mkdir -p "$dir"; chmod 700 "$dir"
work="$(mktemp -d "$dir/make.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cat > "$work/cert.cnf" <<'CNF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Herdr Desktop (self-signed)
O=herdr-desktop
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
CNF
openssl req -x509 -newkey rsa:3072 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 3650 -config "$work/cert.cnf" 2>/dev/null
pass="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-43)"
printf '%s' "$pass" > "$work/p12.pass"
# macOS's `security import` reads the older PBE encryption of -legacy and fails on OpenSSL 3's default.
passfile="file:$work/p12.pass"
openssl pkcs12 -export -legacy -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" -passout "$passfile" -name "Herdr Desktop (self-signed)" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" -passout "$passfile" -name "Herdr Desktop (self-signed)"
mv -f "$work/identity.p12" "$work/p12.pass" "$work/cert.pem" "$dir/"
chmod 600 "$dir/identity.p12" "$dir/p12.pass" "$dir/cert.pem"
echo "made $dir/identity.p12, p12.pass and cert.pem (certificate valid until $(openssl x509 -enddate -noout -in "$dir/cert.pem" | cut -d= -f2))"
echo "fingerprint (SHA-256): $(openssl x509 -fingerprint -sha256 -noout -in "$dir/cert.pem" | cut -d= -f2)"
