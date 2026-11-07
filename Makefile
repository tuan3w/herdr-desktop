# One entry point for the commands in AGENTS.md. `make` alone is the first line of the definition of done.
.DEFAULT_GOAL := verify

# nsh runs the headless runner with the app's own environment.
export HERDR_DESKTOP_TEST := 1

CORE := native/core/Cargo.toml
APP  := native/app/Cargo.toml

.PHONY: verify check test core docs a11y run package theme perf cpu schema shots

verify: check test core docs a11y

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
	python3 scripts/atspi_audit.py

run:
	nsh run . --target linux

package:
	nsh package . --target linux -o .scratch/dist

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
