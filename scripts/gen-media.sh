#!/bin/sh
# Generates the small media fixtures the viewers' tests play (ffmpeg only; nothing here is a recording of anything).
#   scripts/gen-media.sh [dir]              the committed set (each file under 100 KB), default fixtures/files/media
#   scripts/gen-media.sh dir big <minutes>  one long Theora clip for the budget run (not committed): dir/long.ogv
# A Theora/Vorbis clip plays on a box whose GStreamer has no H.264 (the dev box); the H.265 clip is the one that must
# say "cannot play" there.
set -eu
out="${1:-fixtures/files/media}"
mkdir -p "$out"
if [ "${2:-}" = "big" ]; then
  minutes="${3:-60}"
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=24" -f lavfi -i "sine=frequency=330:sample_rate=44100" \
    -t "$((minutes * 60))" -c:v libtheora -q:v 5 -c:a libvorbis -q:a 1 "$out/long.ogv"
  ls -l "$out/long.ogv"
  exit 0
fi
# 5 s, a running counter and moving bars: the position text and the picture both move.
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x180:rate=15" -f lavfi -i "sine=frequency=440:sample_rate=22050" \
  -t 5 -c:v libtheora -q:v 2 -c:a libvorbis -q:a 0 "$out/clip.ogv"
ffmpeg -v error -y -f lavfi -i "sine=frequency=523:sample_rate=22050" -t 8 -c:a libvorbis -q:a 0 "$out/song.ogg"
ffmpeg -v error -y -f lavfi -i "sine=frequency=261:sample_rate=8000" -t 2 -c:a pcm_s16le "$out/tone.wav"
# Nothing on the dev box's GStreamer decodes this: the "cannot play" path.
ffmpeg -v error -y -f lavfi -i "testsrc2=size=160x90:rate=10" -t 2 -c:v libx265 -preset ultrafast -crf 40 -tag:v hvc1 \
  -x265-params log-level=none -movflags +faststart "$out/hevc.mp4"
# Not a movie at all: what the error row says for a file whose headers name nothing.
printf 'this is a text file that was named .mp4\n' > "$out/broken.mp4"
ls -l "$out"
