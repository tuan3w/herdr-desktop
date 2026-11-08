#!/bin/sh
# Builds the test-only no-focus library into .scratch/no-focus/ (not committed).
set -e
cd "$(dirname "$0")/../.."
mkdir -p .scratch/no-focus
/usr/bin/clang -dynamiclib -fobjc-arc -framework AppKit -o .scratch/no-focus/no_focus.dylib scripts/no-focus/no_focus.m
echo ".scratch/no-focus/no_focus.dylib"
