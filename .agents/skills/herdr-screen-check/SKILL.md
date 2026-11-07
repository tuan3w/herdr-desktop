---
name: herdr-screen-check
description: Prove a herdr-desktop screen with pixels. Render it to PNGs with the real fonts at 1280, 960 and 760 px wide (light and dark, two themes, fontScale 2.0), feed it realistic and worst-case data from the fake herdr, walk its states, look at every image, and report what broke and the fix. Use it before calling any UI change done, and whenever someone asks to check, screenshot, render, stress-test or break a screen, find edge cases, verify a layout, or compare variants side by side, even if they only ask "does it look right?".
---

# Checking a screen

Green tests do not prove a window works for the person looking at it. Pixels do. The repo has the machinery: `.shots/screens.test.tsx` and `make shots` (writes to the ignored `.scratch/shots/`), `make a11y` for the AT-SPI tree, `seeded(name)` and the fake herdr in `native/core/src/testing`. Use them; do not build a second harness.

**Platform.** Rendering is `nsh test ... --target linux` under `xvfb-run` with `GSK_RENDERER=cairo`. It does not run on macOS. On a Mac, say the render was not made and mark every layout claim **unverified**; do not describe a screen you did not see.

Demo data flatters a design: names that fit on one line, one machine, every field filled in. Undo that one field at a time with data a real person produces.

## 1. Map what the screen shows

| Value | Source | Limit | Optional? |
|---|---|---|---|
| agent title | herdr pane / ACP session | unbounded | no |
| the command to approve | prompt in the pane | multi-line, unbounded | yes |

Unbounded is a finding. Then the **states**: first paint, live, stale, offline, failed, empty, one, many (30+), needs-you, working, done, and a narrow window.

## 2. Build the data at the boundary

Through the fake herdr and `seeded(name)`, never by editing the widget. Spread failures across the first rows: row 1 a long title, row 2 a Vietnamese workspace name, row 3 a one-letter name, row 4 a 300-character command. Add 40 agents on 3 machines, one offline. Fixtures are synthetic; a real pane never reaches a screenshot.

## 3. Render the matrix

1280x800 (`DESKTOP`), 960 and 760; light and dark; two themes; `fontScale()` 2.0; reduced motion on. Name files `<screen>-<width>-<theme>-<mode>.png`. Add a **window at rest** and one **mid-transition** frame when something animates.

## 4. Look, with a fixed list

Open every PNG. For each, check and write down:

1. **Regions.** Is each region used, or is there dead space? At 1280, how much of the width is content?
2. **Density.** Count visible agents in the sidebar.
3. **Said once.** Count marks per waiting agent in the view.
4. **Truncation.** Is anything cut that the person needs (a command, a name that distinguishes two rows)? Is the cut marked with `…` and available in full on focus or hover?
5. **Foundations** (`emil-design-foundations`): one primary action, hierarchy by subtraction, nested radii (outer minus padding), hairlines not heavy borders, tabular figures on changing numbers, no layout shift.
6. **Focus** is visible on every control; `make a11y` shows no unnamed control.
7. **Contrast** of muted text on its surface in both appearances.

## 5. Report

| # | Severity | Screen / state | What breaks | Fix | PNG |
|---|---|---|---|---|---|

Severity: Broken, Friction, Noise, Inconsistent, Polish. Then what you did **not** check (feel, real GPU, a real monitor, keyboard flow, a Mac render), marked unverified. A finding that no PNG shows is a guess: label it.
