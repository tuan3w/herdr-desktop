---
name: herdr-prototype
description: Build a throwaway, rendered prototype of herdr-desktop so a UI or UX question is discussed on pixels instead of words. Reproduce the owner's complaint with today's code and realistic data, then draw 2 to 4 directions that each move one axis (a layout, a region, a density), render them side by side at 1280, 960 and 760 in light and dark, get a blind critique, and say which wins when and what it costs. Use it whenever the best path is unclear, the owner says "prototype", "mock it up", "show me", "what would it look like", "let's explore", "compare options" or "discuss the UI", or before a non-trivial change to the window layout, the sidebar, the Board, the inspector or the chat's regions, even if they never say the word prototype.
---

# Prototyping herdr-desktop

A UI discussion in words stays vague: two people picture two screens. A prototype puts the same pixels in front of both, makes each option cheap to reject and shows what the words hid (a baseline that already looks fine, a variant that costs half the height). It is a tool for the conversation, not a step toward the product: nothing here ships and nothing is promoted.

Use it when the path is open. When the owner has already chosen, skip it: write the `herdr-design` plan table and implement. Use the real app, not this skill, for questions about keyboard flow, pointer feel, motion or frame time.

## The method

### 1. Pin the question

One sentence in the owner's words plus the moment (`herdr-design` step 1). ("The chat is a narrow column in a big window; Details is a text button; I cannot see where it runs or what changed.") Keep their phrasing: the baseline must reproduce it.

### 2. Reproduce it from the code, before drawing

Trace each complaint to where it comes from and cite `file:line` (a value from `lib/layout.ts`, a component in `components/`, a flag in `lib/settings.ts`). A complaint has several causes and a prototype that fixes the wrong one looks good and changes nothing. Then quote the rule the product already states (`AGENTS.md`, `DESIGN.md`, `design/*.md`, with its number or condition) and say what the screen is for today in one line; the gap between that and the complaint is usually the design problem. Check `AGENTS.md` "Still open" and the `design/*.md` "Decided, not built yet" lines: a documented decision with a reason binds the prototype, and a variant that breaks one must say so and why.

### 3. Teardown a reference

`herdr-design` step 6: the Claude desktop app's Code view, Linear, Zed's agent panel. One row per region, citing the screenshot. Options invented from this app alone repeat its phone assumptions. A reference you could not open makes the teardown **unverified**; say so.

### 4. Pick the lowest rung that answers the question

| Rung | What | Use when | Cost |
|---|---|---|---|
| 1. Stand-ins | Compose the screen from the kit (`#kit`) over plain records in a new `components/<topic>-lab.tsx` entry (the lab pattern below). | Layout, regions, information design, what to show or fold. Most questions. | Minutes. Touches no shared source. |
| 2. Real screen on `seeded(name)` or a real component in a lab | The real `Sidebar`, `Board`, chat parts on a fixture of the fake herdr (`startHerdr("", fixture)`), as `sidebar-lab.tsx` and `board-lab.tsx` do. | The baseline must be real, or data alone shows the effect. | Wiring; still no shared source change. |
| 3. Patched app in a throwaway worktree | The variant needs behaviour: resize, keyboard flow, motion. | Pixels cannot show it. | A worktree builds its own `target/` (`.cargo/config.toml` `target-dir` is relative) and the data disk is nearly full: **ask the owner first**, delete it afterwards. |

Say which rung you used and which parts are stand-ins (a stand-in for the answer dock is fine for a question about the sidebar and wrong for a question about the dock).

**The lab pattern here.** A lab is a test entry, not the app: `components/*-lab.tsx` calls `startHerdr("", host.params.fixture ?? "mixed")`, mounts components inside `ThemeRoot` (and `PopupRoot`, `ToastHost` when popups matter) and prints lines that say what a press did. A test opens it with `open("./x-lab.tsx", { width: 1280, height: 800, platform: "linux", clock: {}, host: { params: { fixture: "mixed" } } })`; a scenario in `.shots/scenarios.ts` names it with `entry:` and `params:` so `make shots` and `make a11y` pick it up. A lab has no `nsh.json` beside it and renders with the default theme: judge tokens and shadows from the App entry. Delete labs and scenarios you do not promote.

Never prototype by editing shared source in the main checkout: it often holds the owner's unfinished work and one `git stash` from losing it (the working tree is routinely dirty). New files only (a lab, a scenario, a fixture under `.scratch/` or `fixtures/`), then remove them.

### 5. Build the baseline first, on the same data

Draw today's behaviour with the data you will use for every variant. Does the render show the owner's complaint? If it looks fine, the data is flattering it: fix the data, not the widget. This is the check that keeps a prototype honest, and the most persuasive picture in the report.

### 6. Use realistic, mixed data, and mark what is invented

Spread the awkward cases through the first rows (`herdr-screen-check/references/worst-case.md`). Use the `big`, `long`, `storm`, `projects` fixtures before inventing. Synthetic only: a real pane never enters a prototype. When a variant depends on a value the app may not be able to get (the person's last prompt as a title; herdr gives no time of last output), write `INVENTED` next to that field in the lab's header and in the report. A beautiful variant on data the app cannot supply is a promise, not a design; whether the data exists is the first thing to check.

### 7. Draw the variants: the smallest change first, then directions

At most four variants besides today. Five is a menu, not a discussion.

1. **The smallest change**: the cheapest edit that might fix the complaint alone (a sort, a default, a width, one removed bar), as its own variant. Every direction must beat it, and without it the credit goes to the wrong idea. Keep it out of the directions; only the combination may contain it. If you cannot name one, say the problem is not cheap.
2. **Up to two directions**, each moving one axis and named by the axis, not A/B/C: *inspector open vs. a Details dialog*, *one-line sidebar rows vs. two-line*, *Board instead of the sidebar vs. beside it*, *answer in the chat's dock vs. in a Board row*. One axis per variant makes the trade readable.
3. **One combination** of the pieces that compose, usually the real answer.

Same data, same window size (1280 x 800 first, then 960 and 760), same chrome, so the only difference on screen is the idea. Render expandable things open and closed. Skip strawmen. Include the baseline.

### 8. Render and look

Render each variant through `herdr-screen-check` (Linux: a scenario per variant and `make shots`; macOS: `make shots-mac ARGS="--entry components/<topic>-lab.tsx --size 1280x800 --theme both --name <variant>"`, window only, popups and menus not in the image, system font instead of Inter). Output is under `.scratch/`; never commit the pictures. Open them: the baseline, every variant, one dark. For the variant you expect to win, also open 960 and 760 and, on Linux, `fontScale()` 2.0: long titles and two-line rows break there first. Say how many PNGs you opened. On a Mac mark every layout claim **unverified on Linux**.

### 9. Get an independent critique

You built these, so you can no longer see them as the owner will. Before you pick, run `herdr-critic` on the PNGs: a fresh subagent given the moment and the images (renamed neutrally) but not your preference. Its glance test (can it say what each row is?) is the cheapest honest check that a variant works. Record at least one thing that changed because of it. If its ranking puts your pick low, lead the report with that disagreement and show both views as the first decision; do not quietly keep your pick.

### 10. Show it

A chat message cannot hold twelve PNGs side by side. For the owner, make one review page: `node scripts/review-page.mjs` builds `.scratch/shots/index.html` from the shots (one section per scenario, light and dark side by side at each width, click to enlarge); serve it with `python3 -m http.server -d .scratch/shots <port>` started in the background and stopped by its own PID. Open and look at the page before you send it: a page you did not open is as unproven as a PNG you did not look at. For a short discussion, name the PNG paths and describe only what you saw.

### 11. Report, short

1. What the baseline shows (the complaint in a picture, causes with `file:line`) and the product's documented rule for it quoted with its number or condition.
2. A table: variant, axis, what it does, when it wins, what it costs.
3. Your pick and the one-line reason; where the critic's ranking differs and why you stand where you do.
4. Caveats: what is invented, what is a stand-in, what you did not check (keyboard flow, motion, real GPU, a Linux or Mac render).
5. The command to re-render, the output folder, then the questions for the owner, last.

Lead with what they can decide. Do not list everything you rendered.

### 12. After the owner chooses

Delete the losing variants, the lab and the scenario once nothing in them is wanted. Then write the `herdr-design` plan table and implement in `components/` and `lib/` from `#kit`. Do not promote prototype code: stand-ins skip the answer guard, the focus order, accessibility names, stale and offline states and the Rust engine's data, which is exactly the work the real change must do. Update `design/*.md` in the same change (`make docs` gates it), and add the tests (`herdr-test`).

## Rules

- Prototypes live under `.scratch/` or as `components/*-lab.tsx` entries; delete what you do not promote. Never commit screenshots (`AGENTS.md`).
- Synthetic data only. Never a real pane.
- **Never run `nsh test` bare**: use `make test`, `make shots`, `make shots-mac` or set `HERDR_DESKTOP_TEST=1`. Never call a mutating herdr method against the user's live herdr; the fake server is the only herdr a prototype talks to.
- **Never kill a process you did not start**: keep the PID of the server and the renders you spawned.
- A full suite may be running; renders are cheap, but do not start a second `nsh test` while it is.

## What pixels cannot tell you

Keyboard flow, pointer feel, motion, whether the real data exists, a real GPU and monitor. Name which remain unchecked, so a good-looking render is not mistaken for a decided design.
