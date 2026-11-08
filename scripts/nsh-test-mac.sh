#!/bin/sh
# Runs `nsh test --target macos <files>` (a real AppKit window) WITHOUT taking the keyboard focus: the host is started
# with the test-only no-focus library (scripts/no-focus). Usage: scripts/nsh-test-mac.sh <test file>... [nsh options]
set -e
cd "$(dirname "$0")/.."
# The terminal feature (on by default) builds libghostty-vt with zig 0.15.2: use the copy under .scratch when there is one
# (and the xcrun wrapper that lets zig 0.15.2 link on macOS 26: docs/DEVELOPMENT.md "Building the terminal").
[ -x .scratch/zig/zig ] && PATH="$PWD/.scratch/zig:$PATH"
[ -x .scratch/zigenv/xcrun ] && PATH="$PWD/.scratch/zigenv:$PATH"
export PATH LIBGHOSTTY_VT_SYS_CPU=baseline
[ -f .scratch/no-focus/no_focus.dylib ] || sh scripts/no-focus/build.sh >/dev/null
HERDR_DESKTOP_TEST=1 DYLD_INSERT_LIBRARIES="$PWD/.scratch/no-focus/no_focus.dylib${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" exec nsh test --target macos "$@"
