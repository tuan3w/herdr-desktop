#!/usr/bin/env bash
# Makes cargo see what did not change as unchanged, in a checkout that follows a restored `target/`.
#
# Cargo decides that a path crate (herdr-core, herdr-desktop-native) is up to date by comparing the mtimes of its source
# files with its build outputs. `actions/checkout` gives every file the time of the checkout, which is newer than the
# cached outputs, so every run recompiled both crates (and relinked the runner) although nothing in them had changed.
#
#   scripts/ci-mtimes.sh before   # after the cache is restored, before the build
#   scripts/ci-mtimes.sh after    # after the build: records what the outputs in target/ were built from
#
# The record is `target/.ci-sources`: "<sha1>  <path>" for every tracked file but the symlinks. `before` gives every file whose line is in
# the record an old mtime (2000-01-01, older than any cached output) and leaves the rest at "now", so those and only those
# are rebuilt. With no record (a cold build) it does nothing. A mistake here can only cost time, never a stale build: cargo
# still compares against the outputs' own mtimes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
record="target/.ci-sources"
now="$(mktemp)"
trap 'rm -f "$now" "$now.old"' EXIT
git ls-files -s | awk '$1 != "120000" { print substr($0, index($0, "\t") + 1) }' | tr '\n' '\0' | xargs -0 shasum -a 1 | sort > "$now"
case "${1:?before|after}" in
  before)
    if [ ! -f "$record" ]; then echo "ci-mtimes: no record in $record (cold build): nothing to do"; exit 0; fi
    sort "$record" > "$now.old"
    same="$(comm -12 "$now.old" "$now" | wc -l | tr -d ' ')"
    total="$(wc -l < "$now" | tr -d ' ')"
    comm -12 "$now.old" "$now" | cut -c43- | tr '\n' '\0' | xargs -0 touch -t 200001010000
    echo "ci-mtimes: $same of $total files are as they were when target/ was built"
    comm -13 "$now.old" "$now" | cut -c43- | grep -E '^(native/|Cargo|rust-toolchain|\.cargo/)' || true
    ;;
  after)
    mkdir -p target
    cp "$now" "$record"
    ;;
  *) echo "usage: $0 before|after" >&2; exit 64 ;;
esac
