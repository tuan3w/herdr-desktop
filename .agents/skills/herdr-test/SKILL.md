---
name: herdr-test
description: How to run and write tests in herdr-desktop (nsh 0.4.0 headless runner, TSX tests, the fake herdr server, Rust crates). Use it whenever you add, change, run, debug or review a test or a lab, fix a flaky or timing-dependent test, ask "how do I test this", "why did this press do nothing", "why is this test slow or flaky", "which command do I run", or need the seams (`seeded`, `ready`, `quiet`, `pressSettled`, `expandSidebar`, `scripted`, `Herdr.test*`), `make test` vs `make test-smoke` vs `HERDR_DESKTOP_TEST=1 nsh test` on one file, `make core`, or what runs on macOS versus Linux, even if they never say "test".
---

# Testing herdr-desktop

Tests here run the whole app, headless, against a **scripted herdr** (a fake server in Rust), never against the owner's real herdr. The rules that make that safe and stable come from failures; each is stated with its reason. The authoritative sources are `app-seam.ts` (read its comments), `docs/DEVELOPMENT.md` ("nsh host quirks"), the `Makefile` and `AGENTS.md` "Tests". This skill is the map.

## 0. Three rules that do real damage

1. **Never run `nsh test` bare.** `make test` and `make test-smoke` export `HERDR_DESKTOP_TEST=1`; run a single file as `HERDR_DESKTOP_TEST=1 nsh test <path>`. Without the variable the test seam is closed (`fixture.rs` ignores every fixture) and the app under test connects to the owner's real herdr and machines, reads their real projects and risks a press on a real pane. It happened once (2026-11-08; real project names reached a log). The same goes for labs, shots and scripts: use `scripts/run-linux.mjs`, `scripts/shots-mac.mjs` or a Makefile target.
2. **Never kill a process you did not start.** No `pkill -f`, `killall`, name kills. Keep the PID of what you spawn and kill only that. A test that starts a session must end it (`endSessions()` in `components/chat-parts-seam.ts`: the keeper outlives the app by design).
3. **A full suite may be running in this checkout.** Do not start a second one while the owner or another agent runs it: run one file, or wait. Never create a second `target/` (the disk is nearly full).

Also: never call a mutating herdr method on the live herdr; pane screens are private (fixtures are synthetic); never commit screenshots.

## 1. Commands

Run `nsh` and `cargo` from the repo root (rustup reads `rust-toolchain.toml`, 1.99.1).

| Goal | Command |
|---|---|
| Types (must print nothing) | `nsh check` |
| The whole TSX suite (about 770 tests, platform independent) | `make test` (= `nsh test`, with `HERDR_DESKTOP_TEST=1` exported) |
| One file | `HERDR_DESKTOP_TEST=1 nsh test components/board.test.tsx` |
| One test | `HERDR_DESKTOP_TEST=1 nsh test components/board.test.tsx --filter "<part of the name>"` |
| See the ops of a run | add `--trace` |
| Smoke subset (App + every global shortcut) | `make test-smoke` |
| Rust: fmt, clippy `-D warnings`, tests of both crates | `make core` |
| Lint, format, imports | `make check` (oxlint `--deny-warnings`, oxfmt `--check`, `scripts/absolute-imports.mjs --check`, `nsh check`); `make fmt` to format |
| Docs gate (DESIGN.md < 100 lines, design/*.md < 150, backticked names exist) | `make docs` |
| Everything on Linux | `make` (= `verify`: check, test, core, docs, a11y) |
| Everything a Mac can run | `make verify-mac` (check, core, docs, test-smoke) |
| A real GTK window under Xvfb | `xvfb-run -a env GSK_RENDERER=cairo nsh test components/<file>.test.tsx --target linux` (with `HERDR_DESKTOP_TEST=1`) |
| AT-SPI audit, no unnamed control | `make a11y` (Linux only) |
| Perf and idle CPU | `make perf`, `make cpu`, `make perf-check` (Linux only) |

**Platform limits.** Headless `nsh test` has no renderer: it checks behaviour, not looks. Under `--target linux` the test file runs apart from the app: it cannot import `herdr-desktop/native`, a test is cut after 30 s unless `test(name, body, timeout)` says otherwise, and `app.submit` types a line break into a box that sends on Return (`docs/PERFORMANCE.md` explains how `.perf/` works around that). On a Mac, `make test` runs the same headless tests; the Xvfb shots, `make a11y`, perf and cpu do not exist there, and `docs/MACOS.md` lists what is unverified. A test run on one platform proves nothing about the other platform's window.

## 2. Anatomy of a test

```ts
import { expect, test } from "nsh/test";
import { DONE, FIRST, pressSettled, ready, sidebarRow } from "../app-seam";   // a test under components/ imports from "../app-seam"

test("what a person would notice, in a sentence", async () => {
  const app = await ready();                       // the `mixed` fixture, board arrived, engine done reading
  await pressSettled(app, sidebarRow(FIRST), "label:Message");
  expect(app.shows("label:Message")).toBe(true);
});
```

- **`seeded(name, extra?)`** (`app-seam.ts`) opens the whole app against `fixtures/herdr/<name>.json` (`"mixed" | "storm" | "empty" | "projects"`; `big`, `long`, `tabs`, `start-fails` are used by labs and scenarios). It starts on Linux with a **manual clock** (`clock: {}`), at `DESKTOP` (1280 x 800), so the 400 ms guard, the 4 s armed window and the layout's quiet period move only when a test moves them. A test beside `App.tsx` leaves `ENTRY` alone; one under `components/` sets `../App.tsx` (an `open()` entry must be under the app directory).
- **`ready(platform?)`** is `seeded("mixed")`, waits for `label:Board, 2 need you`, then `quiet()`. The `mixed` fixture: 2 need you (`FIRST` = `payments review`, `SECOND` = `auth`), 1 to review (`DONE`), 2 working, 3 idle, in two projects (`payments`: 5 agents, `web`: 3, `WEB` = `Styling pass`). Other names are constants in the seam; do not retype them.
- **`quiet(app)`** waits for a fact, not a duration: the engine has read every agent's pane (`pane.read` requests in the scripted herdr's log reach the number of agent rows), then runs the clock 300 ms.
- **`pressSettled(app, selector, done)`** presses until `done` (a selector that shows, or a condition) holds, then waits for it. A press that took is not repeated; the repeat is only for a press the headless harness lost or aimed at a row that moved. Each repeat runs the clock, never real time. `expandSidebar(app)` is the one press for "the app opens on the Board where the sidebar is the rail: bring back the list".
- **Others in `app-seam.ts`:** `settle` (runs the clock 400 ms), `chatReady`, `openAgents`, `openTerminals`, `sidebarRow(name)`, `terminal(name)`, `shown`, `onBoard`, `front`, `saved`, `savedDock`, `groupsOf`, `nameOf`.
- **Moving the fake herdr on:** `scripted(name)` in `components/board-seam.ts` (`addIdle`, `ask`, `show`, `become`, `remove`, `sentKeys()` for the keys sent to panes), or `Herdr.testSetSnapshot`, `testPush`, `testSetScreen`, `testSshFault`, `testRequests(method)`, `testNotifications`, `testPressNotification` directly (native module; not available under `--target linux`).
- **Selecting:** by accessibility label, `label:<name>` (regexes as `label:/^...$/`), `role:tab`, `text:...`; `app.shows`, `app.count`, `app.texts()`, `app.enabled`, `app.waitFor`, `app.waitUntil(fn, { timeout })`, `app.press`, `app.keyboard.press("mod+j")`, `app.clock!.runFor(ms)`, `app.setColorScheme`, `app.screenshot(path)`, `app.storage()`. `app.clock` is `Clock | null` (`!` where the test opened with `clock: {}`); `toBeNull()` is strict (an `undefined` fails it).

## 3. Labs, probes and fixtures

`components/*-lab.tsx`, `*-probe.tsx` and `*.fixture.tsx` are **test entries**, not the app: a lab mounts one screen or kit part against the scripted herdr (`startHerdr("", host.params.fixture)`), inside `ThemeRoot` (plus `PopupRoot`, `ToastHost` for popups), and prints lines that say what a press did (`picked ...`, `new session dialog open`) so a test can assert an effect no selector names. A test opens it with `open("./sidebar-lab.tsx", { width: 1280, height: 800, platform: "linux", clock: {}, host: { params: { fixture: "mixed" } } })`. Name a new entry `-lab`, `-probe` or `.fixture`; tests sit beside what they test (`palette.test.tsx`); `.shots/` and `.perf/` are hidden directories (`nsh test` skips them). Fixtures under `fixtures/herdr/` are **synthetic only**, produced from `herdr-mobile/tool/demo-agent.py` in a scratch pane; never a real pane.

## 4. Rules for a good test (`AGENTS.md`, "Tests")

- Test what a person would notice: behaviour, boundaries, transitions, errors, precedence. Never wiring, copies, source text, incidental defaults or wording; delete such a test instead of re-pinning it.
- **A test never depends on the clock or the CPU.** Poll for the condition (`waitFor`, `waitUntil`), await the event, or run the manual clock (`clock.runFor`). Motion time goes through `motionClock`. `app.wait(ms)` standing in for a condition is a bug in the test.
- **A bug has a test that failed before the fix.** Run it on the old code first and keep the failing output.
- End-to-end tests use `seeded(name)`, `DESKTOP` and `label:`; the fake server is the only herdr a test talks to.
- A test says what the person did and what they see in the title; one behaviour per test.

## 5. Flake families found, and the fix

| Symptom | Cause | Fix |
|---|---|---|
| A press right after `ready()` does nothing; passes alone, fails under load; the failing run's view ids differ from the passing one's | The board shows on the first `session.snapshot`, then the engine reads every agent's pane from its own thread; each answer is a revision that re-pulls the board and re-renders the lists; a press resolved in between aims at a row replaced a moment later | `quiet(app)` (waits for the `pane.read` count, then 300 ms of clock); `ready()` and the lab openers already use it; `pressSettled` for the press |
| Every `lab()` spends 5 s (manual clock and real time) and the test still passes | A wait for a status text the screen no longer has (`heard just now`) was swallowed by a `.catch` or a timeout, masking the race too | Wait for a fact that exists. Never `.catch(() => undefined)` a `waitFor` without a reason in a comment (check the one at `components/machines.test.tsx:24` before copying it) |
| An order assertion differs run to run | `app.texts()` of a list is in the order its recycled cells were made, not screen order | Read an order from `Herdr.board()`, never from `texts().indexOf` |
| `app.press` as the very first step after `open` is lost under machine load | The headless harness | Rerun before assuming a bug; use `ready()` / `waitFor` before the first press |
| Menu or submenu steps do nothing; a `DataTable`'s cells are not listed; no pointer path between rows | The harness does not list a `DataTable`'s cells, does not open submenus and has no real pointer path | Do not assert what the harness cannot show (`docs/DEVELOPMENT.md`); see how `components/menus.test.tsx` and `menus.fixture.tsx` test the kit menu; a row of a `List` is found by `label:` |
| A handler "works" in a test but never fires | A whole event object treated as the value (`onExpandedChange={(expanded) => ...}`) type-checks by truthiness | Read the declaration in `.nsh/types/nsh/*.d.ts` for every event, test the behaviour |
| `Tab` does not reach a chip | Headless Tab reaches pressable views only with `platform: "macos"` | Open as `ready("macos")` for focus tests |
| The host dies with no message (`the host left`) | A preloaded allocator plus GTK (`native/app/src/preload_guard.rs`) | Not a test bug; `docs/DEVELOPMENT.md` has how to get a stack |
| A clipboard or storage write "worked" but nothing happened | `Clipboard.writeText` needs `"clipboard": true` in `nsh.json`; `Storage` is one 5 MB quota and its storage is isolated from the real app's | Assert the observable result; read `app.storage()` |
| Asset import error appears only in `nsh test` | `nsh check` does not resolve asset imports (a deleted icon fails at bundle time) | Run the test, not only `nsh check` |

## 6. Rust

`herdr-core` (`native/core`) is pure Rust with no nsh: unit tests and `tests/` run with `cargo test --manifest-path native/core/Cargo.toml`; the fake herdr server is `native/core/src/testing.rs`. `native/app` is the `#[native_module("herdr-desktop/native")]` crate (`Herdr` module, `PaneScreen`). `make core` runs fmt, clippy `-D warnings` and tests for both. Three kinds need more than cargo and are `#[ignore]`d or need a tool: real ssh (`HERDR_DESKTOP_SSH_TEST=localhost`, key login, python3 there, `-- --ignored`; the second signals only the ssh children its own link exposes, by PID), notifications over D-Bus (`native/app/tests/notify_dbus.rs`, runs in `make core`: needs `dbus-daemon` and python3 with `gi`; kills only its own two processes) and the live board (`native/app/tests/live.rs`, `--ignored`, counts only, no pane text, against the owner's live herdr: read-only methods). Anything that reaches a remote shell has an injection test; a wire error has a test for fatal versus retryable.

## 7. After writing

1. The new test fails on the old code (when a bug) and passes on the new.
2. Run the file three times; run it once while something else uses the CPU if you can, or reason about every wait: is each one a fact?
3. `nsh check`, `node_modules/.bin/oxlint --deny-warnings`, `node_modules/.bin/oxfmt --check`, `node scripts/absolute-imports.mjs --check`; `make fmt` fixes format.
4. Say what you ran and on which platform; say what you did not (the full suite, Linux if on a Mac, `make a11y`, `make core`).
5. A docs change that a test implies (`design/*.md`, `docs/DEVELOPMENT.md` for a new quirk, with the failure that taught it) goes in the same change.
