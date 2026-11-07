# One entry point for the commands in AGENTS.md. `make` alone is the first line of the definition of done.
.DEFAULT_GOAL := verify

# nsh runs the headless runner with the app's own environment.
export HERDR_DESKTOP_TEST := 1

CORE := native/core/Cargo.toml
APP  := native/app/Cargo.toml

.PHONY: verify verify-mac check test core docs a11y run package theme perf cpu schema shots

# Linux: everything. `a11y` needs AT-SPI (dbus, Xvfb, python3-gi), which only Linux has.
verify: check test core docs a11y

# macOS: the same minus `a11y`. The AT-SPI audit, the screenshots (`shots`) and the CPU/frame scripts (`perf`, `cpu`)
# read Linux's accessibility bus and /proc; nothing replaces them on a Mac yet, and docs/ACCESSIBILITY.md says so.
verify-mac: check test core docs

check:
	nsh check

test:
	nsh test

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

# Refresh the protocol schema from the installed herdr.
schema:
	scripts/sync-schema.sh

# Screenshots of the real GTK window at 1280/960/760, light and dark, into .scratch/shots (needs xvfb, dbus; the
# GTK dev files from the system or `. .scratch/sysroot/env.sh`).
shots:
	mkdir -p .scratch/shots
	dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo GTK_A11Y=atspi nsh test .shots/screens.test.tsx --target linux
