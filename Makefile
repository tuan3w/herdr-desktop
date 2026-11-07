# One entry point for the commands in AGENTS.md. `make` alone is the first line of the definition of done.
.DEFAULT_GOAL := verify

# nsh runs the headless runner with the app's own environment.
export HERDR_DESKTOP_TEST := 1

CORE := native/core/Cargo.toml
APP  := native/app/Cargo.toml

.PHONY: verify verify-mac check test test-smoke core docs a11y run package theme perf cpu perf-check schema shots

# Linux: everything. `a11y` needs AT-SPI (dbus, Xvfb, python3-gi), which only Linux has.
verify: check test core docs a11y

# macOS: what the platform can change. The 770 TSX tests are platform independent (Linux runs all of them), so a Mac runs
# `nsh check`, both crates' fmt/clippy/tests (the Rust has cfg(target_os) code of its own) and a smoke subset of the TSX
# tests. Not run there: `a11y` (the AT-SPI audit reads Linux's accessibility bus), the Xvfb screenshots (`shots`) and the
# perf/cpu scripts (/proc); nothing replaces them on a Mac yet, and docs/MACOS.md says so.
verify-mac: check core docs test-smoke

check:
	nsh check
	node scripts/absolute-imports.mjs --check

test:
	nsh test

# The whole app opened and every global shortcut pressed: enough to see the headless runner works on this platform.
test-smoke:
	nsh test App.test.tsx
	nsh test lib/shortcuts.test.ts

# Pure Rust crate (no nsh) and the native crate: format, lints, tests.
core:
	cargo fmt --manifest-path $(CORE) --check
	cargo clippy --manifest-path $(CORE) --all-targets -- -D warnings
	cargo test --manifest-path $(CORE)
	cargo fmt --manifest-path $(APP) --check
	cargo clippy --manifest-path $(APP) --all-targets -- -D warnings
	cargo test --manifest-path $(APP)

docs:
	node scripts/check-docs.mjs

# AT-SPI tree of every screen: no unnamed control (needs dbus-run-session, xvfb-run, python3-gi).
a11y:
	dbus-run-session -- xvfb-run -a python3 scripts/atspi_audit.py

# The window and the package are for the system running make.
HOST_TARGET := $(if $(filter Darwin,$(shell uname -s)),macos,linux)

run:
	nsh run . --target $(HOST_TARGET)

package:
	nsh package . --target $(HOST_TARGET) -o .scratch/dist

# Only after the default theme's spec changes.
theme:
	bun scripts/gen-theme.mjs

# Both need a display; see AGENTS.md for what each reads.
perf:
	bun scripts/perf.mjs

cpu:
	bun scripts/cpu.mjs

# The budgets of .perf/budgets.json: three runs each, the medians (about 20 minutes).
perf-check:
	bun scripts/perf.mjs --check
	bun scripts/cpu.mjs --check

# Refresh the protocol schema from the installed herdr.
schema:
	scripts/sync-schema.sh

# Screenshots of the real GTK window at 1280/960/760, light and dark, into .scratch/shots (needs xvfb, dbus; the
# GTK dev files from the system or `. .scratch/sysroot/env.sh`).
shots:
	mkdir -p .scratch/shots
	dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo GTK_A11Y=atspi nsh test .shots/screens.test.tsx --target linux
