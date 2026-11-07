#!/usr/bin/env bash
# Prints the signature of a packaged Herdr Desktop.app and, when the signing secrets are present (HERDR_SIGN_P12), fails
# if the app is still ad hoc signed: a release that silently fell back to ad hoc would ask every user's keychain again.
# The designated requirement goes to the job summary, so two builds can be compared (it must be identical across builds).
#
#   scripts/check-macos-signature.sh ".scratch/dist/Herdr Desktop.app"
set -euo pipefail
app="${1:?usage: check-macos-signature.sh path/to/Herdr Desktop.app}"
details="$(codesign -dvv "$app" 2>&1)"
requirement="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
echo "$details"
echo "designated requirement: $requirement"
codesign --verify --deep --strict "$app"
if [ -n "${HERDR_SIGN_P12:-}" ]; then
  if echo "$details" | grep -q '^Signature=adhoc'; then
    echo "::error::the app is ad hoc signed although the signing identity is configured" >&2
    exit 1
  fi
  echo "$details" | grep -q '^Authority=Herdr Desktop (self-signed)' || { echo "::error::the app is not signed by the Herdr Desktop identity" >&2; exit 1; }
  echo "$requirement" | grep -q 'certificate leaf = H"' || { echo "::error::the designated requirement does not name the certificate" >&2; exit 1; }
else
  echo "no signing identity in this run (a fork's pull request): the ad hoc signature stays"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "**Signature of $(basename "$app")**"
    echo
    echo '```'
    echo "$details" | grep -E '^(Identifier|Signature|Authority|CDHash)=' || true
    echo "designated => $requirement"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
