#!/usr/bin/env bash
# Installs the toolchain of rust-toolchain.toml (minimal profile) in the background, so the 7 s it takes overlap the restore of
# nsh and of the cargo cache instead of adding to them.
#
#   scripts/ci-toolchain.sh start [component...]   # first step: names the toolchain for the rest of the job, starts the install
#   scripts/ci-toolchain.sh wait                   # before the first cargo call: waits for it, shows its log, fails if it failed
#
# `RUSTUP_TOOLCHAIN` is exported to the job so that rustup ignores the file's `components` (clippy, rustfmt): a component is
# installed only where a job names it (`start rustfmt`).
set -euo pipefail
dir="${RUNNER_TEMP:?}/rustup-install"
case "${1:?start|wait}" in
  start)
    shift
    mkdir -p "$dir"
    channel="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
    components=()
    for c in "$@"; do components+=(--component "$c"); done
    echo "RUSTUP_TOOLCHAIN=$channel" >> "$GITHUB_ENV"
    rm -f "$dir/status"
    # Detached from the step: the runner stops what a step leaves running only when the job ends.
    nohup bash -c 'rustup toolchain install "$@" > "$0/log" 2>&1; echo $? > "$0/status"' "$dir" \
      "$channel" --profile minimal ${components[@]+"${components[@]}"} --no-self-update > /dev/null 2>&1 < /dev/null &
    echo $! > "$dir/pid"
    echo "installing $channel in the background"
    ;;
  wait)
    # macOS's bash is 3.2: an empty array is "unbound" under `set -u` without the `+` form above.
    for _ in $(seq 1 600); do
      [ -f "$dir/status" ] && break
      kill -0 "$(cat "$dir/pid")" 2>/dev/null || { sleep 1; [ -f "$dir/status" ] && break; echo "::error::the Rust toolchain install died without a result"; cat "$dir/log" 2>/dev/null || true; exit 1; }
      sleep 0.5
    done
    [ -f "$dir/status" ] || { echo "::error::the Rust toolchain install did not finish in 5 minutes"; cat "$dir/log" || true; exit 1; }
    cat "$dir/log"
    [ "$(cat "$dir/status")" = 0 ] || { echo "::error::the Rust toolchain install failed"; exit 1; }
    ;;
  *) echo "usage: $0 start [component...]|wait" >&2; exit 64 ;;
esac
