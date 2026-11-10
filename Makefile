# One entry point for the commands in AGENTS.md. `make` alone is the first line of the definition of done.
.DEFAULT_GOAL := verify

# nsh runs the headless runner with the app's own environment.
export HERDR_DESKTOP_TEST := 1

# The terminal (native/app, feature `terminal`, on by default) builds libghostty-vt with zig 0.15.2 on the first compile:
# a copy under .scratch/zig is found without the person's PATH changing (docs/DEVELOPMENT.md "Building the terminal").
# `baseline` keeps the library's CPU code portable: a shipped binary cannot use the build machine's SIMD.
export LIBGHOSTTY_VT_SYS_CPU := baseline
ifneq ($(wildcard .scratch/zig/zig),)
PATH := $(CURDIR)/.scratch/zig:$(PATH)
endif
# zig 0.15.2 cannot link against the macOS 26 SDK: a copy of `xcrun` that names the 15.4 SDK, kept in .scratch/zigenv.
ifneq ($(wildcard .scratch/zigenv/xcrun),)
PATH := $(CURDIR)/.scratch/zigenv:$(PATH)
endif

CORE := native/core/Cargo.toml
APP  := native/app/Cargo.toml

.PHONY: lint fmt fmt-check hooks verify verify-mac check test test-smoke core docs consistency test-waits a11y copy run package theme perf cpu perf-check schema shots shots-mac

# Linux: everything. `a11y` needs AT-SPI (dbus, Xvfb, python3-gi), which only Linux has.
verify: check test core docs a11y

# macOS: what the platform can change. The 770 TSX tests are platform independent (Linux runs all of them), so a Mac runs
# `nsh check`, both crates' fmt/clippy/tests (the Rust has cfg(target_os) code of its own) and a smoke subset of the TSX
# tests. Not run there: `a11y` (the AT-SPI audit reads Linux's accessibility bus), the Xvfb screenshots (`shots`) and the
# perf/cpu scripts (/proc); nothing replaces them on a Mac yet, and docs/MACOS.md says so.
verify-mac: check core docs test-smoke

# oxlint (lint), oxfmt (format and sorted imports), the absolute-import rule.
lint:
	node_modules/.bin/oxlint --deny-warnings

fmt:
	node_modules/.bin/oxfmt

fmt-check:
	node_modules/.bin/oxfmt --check

# Git hooks: pre-commit (format, lint, imports, rustfmt, docs on what is staged) and commit-msg (semantic commits).
hooks:
	git config core.hooksPath .githooks

check:
	nsh check
	node scripts/absolute-imports.mjs --check
	node scripts/check-consistency.mjs
	node scripts/check-test-waits.mjs
	node_modules/.bin/oxlint --deny-warnings
	node_modules/.bin/oxfmt --check

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

# Ratchet on the ladders of lib/layout.ts: fails on a violation not in scripts/consistency-baseline.json.
consistency:
	node scripts/check-consistency.mjs

# Ratchet on the waits of the TSX tests (`herdr-test`, section 5): fails on a new assertion right after an action, or an order read
# from texts(); the existing ones are in scripts/test-waits-baseline.json.
test-waits:
	node scripts/check-test-waits.mjs

# AT-SPI tree of every screen: no unnamed control (needs dbus-run-session, xvfb-run, python3-gi).
a11y:
	dbus-run-session -- xvfb-run -a python3 scripts/atspi_audit.py

# Copy in a real window: real pointer and key events (XTEST), the clipboard read back (needs xclip, xvfb-run, dbus-run-session, python3-gi).
copy:
	dbus-run-session -- xvfb-run -a python3 scripts/copy_probe.py

# The window and the package are for the system running make.
HOST_TARGET := $(if $(filter Darwin,$(shell uname -s)),macos,linux)

run:
	nsh run . --target $(HOST_TARGET)

package:
	nsh package . --target $(HOST_TARGET) -o .scratch/dist
ifeq ($(HOST_TARGET),macos)
	scripts/sign-macos.sh ".scratch/dist/Herdr Desktop.app"
endif

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
	dbus-run-session -- xvfb-run -a env GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=atspi nsh test .shots/screens.test.tsx --target linux

# macOS: one lab or .shots scenario in the real AppKit window, nsh's own window screenshot, into .scratch/shots-mac. Never the
# screen. Example: make shots-mac ARGS="settings --no-steps --keys meta+, --theme both". docs/DEVELOPMENT.md, "Screenshots on a Mac".
shots-mac:
	node scripts/shots-mac.mjs $(ARGS)
