#!/usr/bin/env bash
# The README's three screenshots, rebuilt from synthetic data on Linux: docs/screenshots/{glance,review,night}.webp.
#
#   scripts/readme-shots/build.sh            all three
#   scripts/readme-shots/build.sh night      one (glance, review or night)
#
# Needs: nsh (the pinned one), xvfb-run, dbus-run-session, git, python3, ffmpeg with libwebp. Nothing real is read:
# gen.py makes the repositories, the scripted herdr and the Claude Code logs under .scratch/readme-shots/, and the app
# runs with the test seam open (HERDR_DESKTOP_TEST=1) against that fixture only. The picture is nsh's screenshot of the
# app's own window inside Xvfb, never the screen: 1280x800 points drawn at GDK_SCALE=2 (2560x1600 pixels, as sharp as a
# Retina capture), stored as lossless WebP (smaller than lossy at quality 90 for flat UI, and exact).
#
# How the logs reach the app: under the test seam the app's data directory is a fresh `$TMPDIR/herdr-desktop-<pid>-<n>`
# and its keeper (which reads every log) only follows files under `<data dir>/session-home`. So each render runs with
# TMPDIR set to .scratch/readme-shots/t; a watcher started here waits for the data directory, writes the logs into its
# session-home (times counted from that moment) and points .scratch/readme-shots/home, the folder the fixture names the
# logs through, at it. The watcher is this script's own child and is killed by its PID.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
out=$root/.scratch/readme-shots
gen=$root/scripts/readme-shots/gen.py
[ $# -gt 0 ] || set -- glance review night

for tool in nsh xvfb-run dbus-run-session git python3 ffmpeg; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool is missing" >&2; exit 1; }
done
case "$(ffmpeg -hide_banner -encoders 2>/dev/null)" in *libwebp*) ;; *) echo "build.sh: ffmpeg has no libwebp" >&2; exit 1 ;; esac

rm -rf "$out"
mkdir -p "$out/t" "$out/png"
python3 "$gen" setup "$out"

watcher=
stop_watcher() {
  if [ -n "$watcher" ]; then
    kill "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    watcher=
  fi
}
trap stop_watcher EXIT

watch_data_dirs() {
  while :; do
    for dir in "$out"/t/herdr-desktop-*; do
      [ -d "$dir" ] && [ ! -e "$dir/.readme-logs" ] || continue
      python3 "$gen" logs "$out" "$dir/session-home"
      ln -sfn "$dir/session-home" "$out/home"
      touch "$dir/.readme-logs"
    done
    sleep 0.1
  done
}

for shot in "$@"; do
  case "$shot" in glance | review | night) ;; *) echo "build.sh: no shot named $shot" >&2; exit 2 ;; esac
  rm -rf "$out/t" "$out/home"
  mkdir -p "$out/t"
  watch_data_dirs &
  watcher=$!
  # `make shots` sets the same GTK environment; HERDR_DESKTOP_FIXTURES makes the fixture the copy gen.py wrote. The Xvfb
  # screen (xvfb-run's default is 1280x1024) is made larger than the 2x window, 2560x1600 pixels.
  dbus-run-session -- xvfb-run -a -s "-screen 0 2800x1800x24" env HERDR_DESKTOP_TEST=1 \
    HERDR_DESKTOP_FIXTURES="$out/fixtures" TMPDIR="$out/t" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=atspi GDK_SCALE=2 \
    nsh test .shots/readme.test.tsx --target linux --filter "readme-$shot"
  stop_watcher
  png=$out/png/readme-$shot.png
  [ -s "$png" ] || { echo "build.sh: nsh wrote no $png" >&2; exit 1; }
  ffmpeg -v error -y -i "$png" -c:v libwebp -lossless 1 -compression_level 6 "docs/screenshots/$shot.webp"
  ls -l "docs/screenshots/$shot.webp"
done
