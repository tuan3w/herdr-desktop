# Proving a finding

A claim you did not try to break is a guess. This is how to try without touching the tree the owner is working in.

## Why a clean copy

The main tree often holds unfinished work, may not compile, and a full suite may be running in it. A verifier therefore never runs a throwaway test there, never stashes, checks out, resets or formats it, and kills only processes it started, by PID (a `pkill -f` once threatened a long training run on this machine). A copy made with `git archive` has no `.git`, so there is nothing to peek at and nothing to damage.

## Pure logic (most findings): no harness

`lib/*.ts` rules (`answer`, `board-table`, `session-rows`, `header-fit`, `shortcuts`) are tested by `lib/*.test.ts` through `nsh test`, headless. A ten-line test that feeds the function the trigger is enough.

## Commands

```sh
W=.scratch/review-<id>; rm -rf "$W"; mkdir -p "$W"
git archive <rev> | tar -x -C "$W"        # <rev>: HEAD, a commit, a branch. No .git.
# A working-tree change: copy the changed files over the archive.
cp <changed files> "$W/<same paths>"
cd "$W"
# One shared target/: the data disk is nearly full, never a second one (.cargo/config.toml uses a relative "target").
export CARGO_TARGET_DIR="<repo>/target"
HERDR_DESKTOP_TEST=1 nsh test lib/<file>.test.ts            # or components/<file>.test.tsx, or --filter "<name>"
```

Write the throwaway test inside `$W`, never in the repo. Whether a copy under `.scratch/` compiles the native module without a rebuild of the app's own crates is **unverified**: the first run may take minutes. When the finding is pure TypeScript logic that imports no `herdr-desktop/native`, say so in the report. Run `nsh` and `cargo` with the copy's root as the working directory so rustup sees `rust-toolchain.toml` (1.99.1).

**Always `HERDR_DESKTOP_TEST=1`** (or `make test` in the real tree, if the owner allows): without it the test seam is closed and the app connects to the owner's real herdr and machines.

## Where the fakes are

| Fake | Use |
|---|---|
| `seeded(name)`, `ready()`, `quiet()`, `pressSettled()` in `app-seam.ts` | the whole app on a scripted herdr (`fixtures/herdr/<name>.json`) |
| `Herdr.testSetSnapshot`, `testPush`, `testSetScreen`, `testSshFault`, `testRequests(method)`, `testNotifications`, `testPressNotification` | script and read the fake herdr from a lab or a test |
| `components/*-lab.tsx`, `*-probe.tsx`, `*.fixture.tsx` | test entries for one screen or kit part |
| `native/core/src/testing.rs`, `native/app/tests/` | the Rust side: `cargo test --manifest-path native/core/Cargo.toml`, same for `native/app` |
| `.shots/scenarios.ts` | named states for a render |

`herdr-test` has the rules for writing the test (no clock, no waiting for text the screen no longer has, select by `label:`).

## What counts as `ran`

A test that fails on the old code with the symptom the finding names and passes when the one line is changed. Keep the failing output. A test that fails for another reason (a bad fixture, a lost press, the harness) proves nothing: fix the test, not the finding. A press lost as the first step after `open` was seen under load: rerun before assuming a bug.

## What cannot be reproduced here

A real GTK or AppKit window (headless `nsh test` has no renderer), GPU frame times, a real ssh hop or relay (`HERDR_DESKTOP_SSH_TEST=localhost`, `--ignored`, needs key login), notifications over a real desktop, VoiceOver or Orca, keyboard focus in the AppKit backend. The status is then `read` or `lead`, never `ran`; write what would settle it.

## After

Delete the copy (`rm -rf "$W"`) unless the owner asked for the test, and name the test file's path in the report so it can be copied into the repo if a fix is wanted.
