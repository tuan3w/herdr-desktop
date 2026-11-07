#!/usr/bin/env bash
# Prints the release notes of one version: its section of CHANGELOG.md, from `## [<version>]` up to the next `## [`,
# without the heading. `unreleased` prints the `## [Unreleased]` section (the notes of the rolling `edge` release).
# Fails when the section is missing or empty, so a release never ships without notes.
#
#   scripts/release-notes.sh 0.1.0-alpha.3
#   scripts/release-notes.sh unreleased
set -euo pipefail
version="${1:?usage: scripts/release-notes.sh <version>|unreleased}"
cd "$(dirname "$0")/.."
heading="## [$version]"
[ "$version" != unreleased ] || heading="## [Unreleased]"
notes="$(awk -v h="$heading" '
  index($0, h) == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' CHANGELOG.md | sed -e '/./,$!d')"
if [ -z "${notes//[[:space:]]/}" ]; then
  echo "CHANGELOG.md has no notes under '$heading'" >&2
  exit 1
fi
printf '%s\n' "$notes"
