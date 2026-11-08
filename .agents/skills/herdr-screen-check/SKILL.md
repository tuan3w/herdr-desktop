---
name: herdr-screen-check
description: Prove a herdr-desktop screen with pixels. Render it to PNGs of the real window (Xvfb plus cairo on Linux with `make shots`, nsh's own window screenshot on a Mac with `make shots-mac`) at 1280, 960 and 760 px wide, light and dark, two themes, `fontScale()` 2.0 and reduced motion, feed it realistic and worst-case data from the fake herdr, walk its states, look at every image, and report what broke and the fix. Use it before calling any UI change done, and whenever someone asks to check, screenshot, render, stress-test, break or verify a screen, find edge cases, check a layout at another width or text size, run the a11y audit, or compare variants side by side, even if they only ask "does it look right?".
---

# Checking a screen

Green tests do not prove a window works for the person looking at it. Pixels do. The repo already has the machinery: `.shots/scenarios.ts` (named states, shared by the screenshots and the AT-SPI audit), `.shots/screens.test.tsx`, `make shots`, `make shots-mac`, `make a11y`, `scripts/review-page.mjs`, `seeded(name)` and the fake herdr (`native/core/src/testing.rs`, `fixtures/herdr/*.json`). Use them; do not build a second harness.

Demo data flatters a design: names that fit on one line, one machine, every field filled in. Your job is to undo that one field at a time with data a real person produces, then judge as the person would: can they tell at a glance what needs them, and can they act?

## 0. Safety, before you run anything

- **Never run `nsh test` bare.** Use the Makefile targets or `scripts/*.mjs` (they export `HERDR_DESKTOP_TEST=1`), or set it yourself. Without it the fixture seam is closed and the app under test connects to the owner's real herdr and machines (it happened once; real project names reached a log).
- **Never kill a process you did not start**; no `pkill -f`, `killall`, name kills. Keep the PID of what you spawned. `shots-mac.mjs` and `atspi_audit.py` kill only the one child they started.
- **A real pane is private.** Fixtures are synthetic only. Never screenshot, log or commit a real pane. Output goes under the ignored `.scratch/`, never `/tmp`, never committed (`AGENTS.md`).
- A full test suite may be running in this checkout: renders are cheap, but do not start a second `nsh test` run if the owner said the suite is running; ask or wait.
- Do not call a mutating herdr method against the live herdr. Renders use the fake server.

## 1. Which platform, which command

| Host | Command | Output | Limits |
|---|---|---|---|
| **Linux** (GTK 4, Xvfb, cairo) | `make shots` for every scenario at 1280, 960, 760, light and dark. One image: `dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo GTK_A11Y=atspi nsh test .shots/screens.test.tsx --target linux --filter "board dark 1280"` (filter is `<scenario> <scheme> <width>`) | `.scratch/shots/<scenario>-<scheme>-<width>.png`; `node scripts/review-page.mjs` builds `.scratch/shots/index.html` (serve with `python3 -m http.server -d .scratch/shots 8765`, start and stop it by PID) | cairo is CPU-rendered: fine for layout, not for frame times or GPU shadows. `GSK_RENDERER=cairo` is required under Xvfb. |
| **macOS** (AppKit) | `make shots-mac ARGS="<scenario> --size 1280x800 --theme both"` or `ARGS="--entry components/x-lab.tsx --press 'text:Sort' --theme dark --name menu"` | `.scratch/shots-mac/<name>-<width>-<theme>.png` | See below. |
| Either | `make a11y` (Linux only): AT-SPI tree of every scenario, fails on an unnamed control | `.scratch/a11y/<scenario>.txt` | Reads Linux's accessibility bus; nothing replaces it on a Mac. |

**On a Mac** (`docs/DEVELOPMENT.md`, "Screenshots on a Mac"): the picture is nsh's `app.screenshot` of the window, never the screen. Options: `--size 1280x800|960x700|760x640`, `--theme light|dark|both`, `--press <selector>` (after the scenario's steps; repeatable), `--keys <chord>` (`meta+,` opens Settings; a scenario's own `ctrl+,` does nothing on a Mac, so add `--no-steps`), `--js "<steps with app in scope>"`, `--wait ms`, `--settle ms` (after each key or press, default 1200: a dialog shot at 500 ms shows the board through it, mid fade), `--theme-id`, `--fixture`. What does **not** show: `ActionMenu` (a native `NSMenu`) and `Popover` (a window of its own) are not in the image; the Select popup is. Box-shadow rings and outer shadows under opaque fills are not drawn, so never judge `SHADOW` or a popup's light edge here. A lab under `components/` has no `nsh.json` beside it and renders with the default theme: judge tokens and shadows from a scenario (the App entry), not a lab. `Inter` is not installed, so the system font is used and widths differ from Linux: a one-line fit seen on a Mac may not fit there. `app.press` on a list row by `label:` with a path did not select it (use `--js` with `app.keyboard.press("j")`), and `app.type` into an input did not change the value. Say on every report from a Mac: **layout verified on the AppKit window only; Linux render, `make a11y` and large-text checks not done**.

If neither platform can render, say the render was not made and mark every layout claim **unverified**. Never describe a screen you did not see.

## 2. Map what the screen shows

List every value the screen renders and where it comes from, including the ones people forget: counts, relative times, status words, the project header's machine name, the list's own length.

| Value | Source | Limit | Optional? |
|---|---|---|---|
| agent title | herdr pane or ACP session | unbounded (herdr gives none) | no |
| the command to approve | prompt read from the pane | multi-line, unbounded | yes |

Unbounded is a finding in itself. Then list the **states**, because a window is many windows: first paint, live, stale machine, offline machine, failed, empty, one agent, many (30+), needs-you, working, done, collapsed project, narrow (rail), inspector open and closed, a dialog or page open over a waiting question.

## 3. Build the data at the boundary

The worst case enters where real data does: a fixture of the fake herdr (`fixtures/herdr/`: `mixed`, `storm`, `empty`, `projects`, `big`, `long`, `tabs`, `start-fails`), `Herdr.testSetSnapshot`, `testSetScreen`, `testPush` in a lab, never an edit to the widget (that tests your edit, not the screen). Spread failures across the first rows the way real data mixes them: row 1 a 120-character title, row 2 a Vietnamese project name, row 3 a one-letter name, row 4 a 300-character command. Use the rows of `references/worst-case.md`. Add 40 agents on 3 machines with one offline. A new scenario is an entry in `.shots/scenarios.ts` (it is then also audited by `make a11y`); a new fixture is synthetic only, produced from `herdr-mobile/tool/demo-agent.py` in a scratch pane, never a real pane.

## 4. Render the matrix

Minimum, per state that matters:

- **Widths** 1280 x 800 (`DESKTOP`), 960 (full sidebar at its narrow width) and 760 (the rail).
- **Light and dark**, and two themes of the four (Harbor, Container, Chart, Graphite). The default theme first.
- **`fontScale()` 2.0.** It comes from `gtk-xft-dpi`; no script in the repo sets it. `docs/ACCESSIBILITY.md` (checklist, item 9) gives the manual route: `gsettings set org.gnome.desktop.interface text-scaling-factor 2.0` (inside the `dbus-run-session` you render in; reset it after; whether the headless Xvfb session honours it is **unverified**). If you cannot, say large text was not checked. A row has `min-h`, so rows should grow, not clip.
- **Reduced motion** on: `open(..., { reducedMotion: true })` in a test; for a render, `gsettings set org.gnome.desktop.interface enable-animations false` (same checklist; reset it after).
- A **window at rest** and, when something animates, one mid-transition frame (`app.screenshot` after `clock.runFor` in a test).

Name files `<screen>-<width>-<theme>-<mode>.png`. Then **open the PNGs and look at them** with the image reader. A render you did not look at proves nothing. Open at least one per state and size plus every image you cite; say how many you opened. Do not claim you looked at all unless you did.

## 5. Look like the person, then like an inspector

First, as the person, one glance at a time:

- Can I tell what needs me in under a second? Is it the loudest thing and the only loud thing?
- Do I know what will happen if I press the obvious control? Is the command I am approving visible, whole?
- Do I know whether this is live, stale or offline, per machine?
- Is there anything here I would never read? (Noise: report it.)

Then as an inspector, with a fixed list for every PNG:

1. **Regions.** Each region used, or dead space? At 1280, how much of the width is content? Is the conversation at its measure and the surplus used?
2. **Density.** Count visible agents in the sidebar. A dozen at 1280 x 800 is the bar.
3. **Said once.** Count marks per waiting agent in the view (`design/attention.md`).
4. **Truncation.** Is anything cut that the person needs (the command, the name that tells two rows apart)? Is the cut marked with `…` and shown whole on hover or focus (`Clipped`)? Paths middle-truncated, not end.
5. **Foundations** (`emil-design-foundations`, `emil-surfaces`): one primary action, hierarchy by subtraction, nested radii (outer minus padding), hairlines not heavy borders, aligned edges across stacked bars, two neutrals vs one, tabular figures on changing numbers, no layout shift.
6. **Focus** visible on every control; `make a11y` shows no unnamed control.
7. **Contrast** of muted text on its surface in both appearances.
8. **Type**: sizes from the scale, nothing off it; Vietnamese diacritics not clipped.

| What you see | Usual cause | Fix |
|---|---|---|
| A text cut with no `…` and no hover | A fixed-height box, or `line-clamp` with nothing behind it | `Clipped`; `min-h`, never `h` |
| Row text clipped at `fontScale()` 2.0 | A fixed height | `min-h` (`ROW`, `lib/layout.ts`) |
| A focus ring hidden behind the next row | An outline is painted by its own view; a later sibling's fill covers it | `FOCUS_RING_SIDEBAR` or `FOCUS_RING_INSET` |
| A ring or a shadow that is missing | `ring-*` and box-shadow rings draw nothing on nsh | `FOCUS_RING` (outline), a border |
| Muted text that is too faint | Alpha on a text colour (`text-x/60` is an unknown class) | `opacity-*` on the `Text`, or the right token |
| A leftover 36 pt control beside a 32 pt field | `components/files.tsx`, `folder-picker.tsx`, `kit/collapsible.tsx`, `kit/menu.tsx`, `board.tsx`, `changes-notes.tsx` (`AGENTS.md`) | One row height |
| The inspector squeezing the chat below its measure at 960 | A region not dropped at that width | Overlay or collapse (`snug()`, `narrow()`) |
| A count changing width every second | Proportional figures | Tabular figures |
| The same state said three times (glyph, tab dot, header word, status count) | Decoration | Say it once |
| A check meaning both "connected" and "done" | One glyph, two meanings | A dot for a machine, the check for done |
| Two greys of background in one window | Warm sidebar next to a blue-grey strip | Needs a render to find the cause: do not guess a fix |
| `1 agents`, `0 need you` | A hand-built plural | A count-aware string |

## 6. Report, then stop

Part 1, what broke, worst first. **Broken** means unreadable, unreachable or wrong data. **Ugly** means readable but visibly wrong. **Fragile** means fine now, one realistic step from breaking.

| # | Severity | Screen / state | Worst case | What happens | Fix (`file:line`) | PNG |
|---|---|---|---|---|---|---|

Every row names a PNG you opened and the exact `file:line` to change. A break only inferred from code goes under **Fragile**, marked "from code, not seen". Part 2, decisions for the owner (wrap or truncate this title?), one line each with a recommendation. Part 3, what held up, so nobody "fixes" it. Give the command that re-renders and the output folder. Then the **unchecked list**: feel, motion, keyboard flow, a real monitor and GPU, `fontScale()` 2.0 if not set, a Mac or a Linux render, `make a11y` on a Mac, popups on a Mac.

Fix only what was asked. After a fix, re-render every state including the happy one: a fix for the worst case must not regress the demo.

## 7. Keep the proof

Keep the fixture and the scenario: they are the regression check for the next change. When a break could come back unseen (an overflow, a lost inset, a list that mounts every row), also add a normal test that fails on it, asserting behaviour (a row is findable by `label:`, a bounded number of rows exists), not pixels (`herdr-test`; `AGENTS.md`, "Tests").

## Comparing variants

When a design question is open, build and compare directions with `herdr-prototype`; it owns the baseline, the variants and the report. Once the owner picks one and it is implemented, prove that one through this matrix, then hand the PNGs to `herdr-critic`.
