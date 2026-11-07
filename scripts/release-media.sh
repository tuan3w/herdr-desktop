#!/usr/bin/env bash
# The pictures of a release live on the release, never in git: files named `<version>-<slug>.png|jpg|mp4`, made into the
# ignored `local/release-media/<version>/`, uploaded by the person who cuts the release once the workflow has published it.
# This script checks that the notes and the assets agree.
#
#   scripts/release-media.sh 0.1.0-alpha.4            # before the upload: every picture the notes name is a file in
#                                                     # local/release-media/0.1.0-alpha.4/
#   scripts/release-media.sh 0.1.0-alpha.4 --remote   # after the upload: every URL answers HTTP 200
#   scripts/release-media.sh 0.1.0-alpha.4 --upload   # gh release upload v0.1.0-alpha.4 local/release-media/0.1.0-alpha.4/*,
#                                                     # then the --remote check
#
# Fails when a URL in the notes is not `.../releases/download/v<version>/<file>` (scripts/check-changelog.mjs says why), when a
# file is missing, or when a URL does not resolve.
set -euo pipefail
version="${1:?usage: scripts/release-media.sh <version> [--remote|--upload]}"
mode="${2:-local}"
cd "$(dirname "$0")/.."
dir="local/release-media/$version"
prefix="https://github.com/tuan3w/herdr-desktop/releases/download/v$version/"

urls="$(scripts/release-notes.sh "$version" | grep -oE '\]\(https://[^)]+\)' | sed -e 's/^](//' -e 's/)$//' | grep '/releases/download/' | sort -u || true)"
if [ -z "$urls" ]; then
  echo "release-media: the notes of $version name no release asset (a release may have no media)"
  exit 0
fi

check_remote() {
  local bad=0 url code
  while IFS= read -r url; do
    # no-cache: GitHub's edge keeps a 404 it answered before the upload for a while
    code="$(curl -sL -H 'Cache-Control: no-cache' -o /dev/null -w '%{http_code}' "$url")"
    if [ "$code" = 200 ]; then echo "ok   $url"; else echo "FAIL $code $url"; bad=1; fi
  done <<< "$urls"
  return $bad
}

case "$mode" in
  local)
    bad=0
    while IFS= read -r url; do
      case "$url" in "$prefix$version-"*) ;; *) echo "FAIL not an asset of v$version named $version-<slug>: $url"; bad=1; continue ;; esac
      file="$dir/${url#"$prefix"}"
      if [ -f "$file" ]; then echo "ok   $file ($(wc -c < "$file" | tr -d ' ') bytes)"; else echo "FAIL missing $file"; bad=1; fi
    done <<< "$urls"
    exit $bad ;;
  --remote) check_remote ;;
  --upload)
    gh release view "v$version" >/dev/null || { echo "release-media: v$version is not published yet: wait for release.yml (gh run watch), then upload" >&2; exit 1; }
    gh release upload "v$version" "$dir"/"$version"-*.png "$dir"/"$version"-*.jpg "$dir"/"$version"-*.mp4 --clobber 2>/dev/null \
      || gh release upload "v$version" "$dir"/"$version"-* --clobber
    check_remote ;;
  *) echo "usage: scripts/release-media.sh <version> [--remote|--upload]" >&2; exit 64 ;;
esac
