---
name: herdr-design
description: Design herdr-desktop from the supervisor's side, on a desktop window. Trace each journey (an agent needs me, glance, follow, steer, start, review, set up, something broke, away from the desk), decide what each REGION of the window is for (sidebar, main, inspector, status), question every element's purpose, find the best path, keep what delights, remove noise, and keep the app coherent as a whole. Use it for any product, UX or layout decision (a new screen, a change to a flow, copy, what to show or hide, "make it better / denser / simpler / feel right", a design or UX review, a comparison with another app, planning work in components/ or lib/), even when the request sounds purely visual or purely technical. It is step 1 of every UI change; pair it with the emil-* craft skills, herdr-prototype, herdr-motion, herdr-screen-check, herdr-critic and herdr-review.
---

# Designing herdr-desktop

Design here is **how the window works for the person**, not how it looks. Start where the person is, walk through what they see, understand and do, and judge every element by whether it helps them. The look follows. `DESIGN.md` and `design/*.md` record the system and every screen's behaviour; this skill is how to decide what goes in them.

**Precedence.** `AGENTS.md` (owner decisions, rules) beats `DESIGN.md` and `design/*.md`, which beat this skill, which beats the general `emil-*` craft skills. Where an `emil-*` rule is written for the web and the repo says otherwise, the repo wins; keep the value (a 4-pt scale, outer radius minus padding, tabular figures) and translate the unit to nsh classes. Reopen a documented decision only with new evidence (a measurement, a render, a journey it breaks) and say what the evidence is.

herdr-desktop descends from herdr-mobile. The journeys, the five questions and the safety rules carry over. **The layout does not.** A phone has one region at a time, a thumb and seconds of attention. A desktop has a 1280 pt or wider window, a keyboard, a pointer and a person who keeps it open all day. A phone screen in a wide window is a stretched list with empty gutters.

## Who it is for

A **supervisor, not a pair-programmer**, running agents under `herdr` on this computer and others while doing other things. Each time they look they ask, in order:

1. **Does anything need me?** Which agent, what exactly it asks, what happens if I say yes.
2. **Is everything alive and on track?** What runs, for how long, whether anything is stuck, whether each machine is live.
3. **What did it do?** The outcome (what changed, failures, the answer), not the process.
4. **Steer it.** Correct, redirect, stop, start.
5. **Can I trust it?** The agent's mode and permissions, and this app: live, stale or offline?

A screen, row, word or animation that answers none of these is noise until proven otherwise. Desktop adds three tests the phone never had: **density** (a dozen agents visible and still room to read one), **regions** (what lives where, always) and **persistence** (what stays on screen while they work elsewhere in the window; a question waiting for them stays visible).

## The method

Write each step down. The thinking skipped is where noise and dead ends come from.

### 1. Find the moment, then the region

One sentence: who, where, why they opened the window now, what they already know, what they want to leave with. ("Second monitor, six agents running, glancing between my own work; a notification said omp waits. I want to read what it runs, allow the safe thing and look away.") Then name the **region** each answer lives in:

| Region | Job | Never |
|---|---|---|
| **Sidebar** | The one list of every agent, grouped by project only, state on the row; navigation; new. | Hold what the main region holds, list an agent a second time, or re-sort by state. |
| **Main** | The one agent being worked on (chat or terminal), the Board, or a Settings page. | Be a second list of agents. |
| **Inspector** (right, collapsible, remembers its state) | What you consult, not read: where it runs, branch, context used, changes, files, subagents, terminal. | Hold the conversation. |
| **Status** | Connection truth per machine: live, stale, offline. | Repeat counts the sidebar shows. |

Rules that follow (all from `AGENTS.md`):

- **An agent appears once per view.** Sidebar row, Board row and a "Needs you" list for one agent is three copies of one fact. The Board is a different view of the data (a table grouped by project, with the bulk answer under its `Need you` chip), never a copy beside the sidebar.
- **Wide windows get a second region, not wider text.** The conversation keeps a measure of 720 to 768 pt; spare width goes to the inspector or a split. Unused width and oversized type are defects.
- **A text button that opens a dialog for facts about the open agent (`Details`) is a missing inspector.**
- **Settings and Machines open in the main region**, not a modal over the sidebar, so a waiting question stays visible. A dialog is for a decision or a short form (`design/dialogs.md`).
- Check what is built and what is only decided: `AGENTS.md` lists "Still open" items and `design/*.md` mark "Decided, not built yet". Never design as if a decided item exists, and never ship a change that contradicts one.

### 2. Trace the journey end to end

From the trigger (a notification, `mod+j`, a worry, a habit) to looking away, and then the next time they open the window. For each step: what they see, what they must understand, what they do, what the app does, what they know after. Include waits (a pane read, an ssh hop), failures (offline, stale machine, refused, relay gone, host key changed) and interruptions (window hidden, machine asleep, ssh dropped, a second question arriving while they type).

Trace through the code, not memory: open the files, cite `file:line`, render with `herdr-screen-check`. `references/journeys.md` maps the journeys and the surfaces that share them; start there, then verify, because the code moves on.

| Question | Look for |
|---|---|
| **Purpose** | Which of the five questions? None means noise. |
| **Necessity** | Default it, remember the last choice, fold it in, infer it. |
| **Cost** | Clicks, keystrokes, reading, waiting, eye travel across the window. |
| **Truth** | Is it true now? If it may not be, does it say so (stale, offline)? |
| **Safety** | Worst case of a wrong click or key. Guard in proportion. |
| **Recovery** | On failure: what happened, what next, without losing typed text. |
| **Keyboard** | Is there a key path, shown in the tooltip and the palette? |

### 3. Density: one row is not enough

| Tier | Where | Shape |
|---|---|---|
| **Compact** | Sidebar, many agents | One line: state glyph and title. No program name, machine or age by default; only an exception adds a word (`quiet 41m`) or a dashed glyph (stale machine). `ROW` in `lib/layout.ts` holds the height. |
| **Standard** | A group's expanded rows, a queue | Glyph, title, one meta line. |
| **Rich** | The thing that needs an answer | Question, the exact command, the choices (the answer dock). |

The test: at 1280 x 800, can the person see **a dozen agents** in the sidebar and still read the open conversation? Count them in the render. Do not restate numbers from `lib/layout.ts` in a doc or screen; the scale is mid-cutover (`AGENTS.md`).

### 4. Best path patterns

- **Bring the action to the information.** Answer from where the question appears (the one answer dock in the agent's conversation, or the Board's filtered view for many), not after opening something.
- **A chat turn is ranked by consequence, not time.** Always visible: a pending question, the final answer, failures, effects outside the working tree (a push, a delete, an install). Folded to one muted line: reads, searches, commands, narration. Paths and counts are links into the inspector. No repeated state word, no `Done in 12s`; while working, one live line says what it does now.
- **Say it once, where they look.** One state, one place, one mark (`design/attention.md`). A project header shows a count only while folded.
- **Order does not chase attention.** Stable (last activity) order, so a row never moves under the pointer. `mod+j` jumps to the next waiting agent; it never answers and never advances by itself.
- **Guards in proportion.** Cheap and reversible: a click. A slip: a click plus `notify(..., { undo })`. Irreversible: `confirmDestructive`. Risky answer: two steps (press, then press again within 4 s), never a timed hold, never silent. Bulk: a confirm built from live data, every command in full, boxes start unticked.
- **Show what is approved**, whole. A choice chip that cuts the thing it grants (`2. Yes, and always allow access to…`) fails this rule. The answer path re-reads the pane and refuses when the question changed.
- **Never a dead end.** Unavailable stays, dimmed, with its reason. A failure says what happened and what to do.
- **Keep their work.** Typed text survives a failed send, a hidden window and a reconnect.
- **Keyboard first and discoverable.** Every action has a key (`lib/shortcuts.ts`, always with `mod`, never `alt`), shown in its tooltip and menu, and in the palette.
- **One of each.** One answer dock, toast, palette, guard, switcher. Two patterns for one job means migrating every caller (principle 10).
- **Respect the CPU.** An app at rest draws no frames. A timer, poll or loop is a cost; see `herdr-motion`.

### 5. Keep a ledger: noise and delight

Mark each item keep, remove or change, with a reason.

**Noise:** the same fact twice (a count in the sidebar, the title bar and the status bar); decoration; a confirmation for something cheap; a raw pane id where a name exists; a label for the obvious; a card inside a card; a state word beside a state glyph; an option almost nobody needs on the main path; a chevron that says nothing; a banner for what a footer line says.

**Delight is friction that vanished:** answering without opening; `mod+j` to the next waiting agent; a tab that opens where it was left; `Marked 3 reviewed` with one Undo; the inspector already showing the branch and diff when you look; a project that restores its layout. Earned moments are rare (a check that draws once after a connection test passes). If a "delightful" idea adds motion or marks to a frequent path, it is noise.

### 6. Compare against a real reference before deciding

Do not design from memory or from this repo's docs alone: they are where the phone assumptions live. Open one or two apps people find excellent for the same job (the Claude desktop app's Code view, Linear, Zed's agent panel, Superhuman for an inbox model) and write a **teardown**, one row per region:

| Region | Reference does | We do | Gap | Why it matters |
|---|---|---|---|---|

Take what answers one of the five questions; skip their brand. Cite the screenshot. A gap with no reason on our side is a finding. A reference you could not open means the teardown is **unverified**: say so.

### 7. Check the whole app

- **Parity table.** The same concept on several surfaces (a waiting agent: sidebar row, Board row, rail tile, answer dock, bulk answer, palette, switcher, notification, window title) gets one row per surface and one column per property the person relies on: what is shown, the stale guard, the second step on risk, the confirmation, the failure path, the words. Fill each cell from that surface's own code, not the shared component: twins drift through a flag that defaults off or a copy that missed a fix. An empty or differing cell is a finding unless a reason is written down.
- **Same object, same word.** Machine, project, agent, session, pane, tab, turn.
- **Entry and exit.** Notification click, palette, `mod+e` switcher, `mod+[` back, deep link, Board and sidebar all land somewhere coherent.
- **State that carries.** What survives a launch, a project switch, a reconnect (the saved layout, the inspector's open state) and what deliberately does not.
- **Resize.** 1280, 960, 760 and `fontScale()` 2.0. At each width a region is dropped or collapsed on purpose (inspector first, then the sidebar to the rail), never squeezed. Use `compact()`, `rail()`, `narrow()`, `snug()`; never read the window size in a screen.
- **The cost elsewhere.** A new row type changes every list that holds it; a new signal changes the Settings page (rule 10); a new colour changes four themes in two appearances.

### 8. Write the plan, then prove it

| Step | Today | Problem (question, cost, risk) | Change | Where (`file:line`) |
|---|---|---|---|---|

Fix data correctness before polish. Build from `#kit`. Then, in order: craft (`emil-design-foundations`, `emil-typography`, `emil-surfaces`, `emil-color`, `emil-forms-and-inputs`, `emil-component-design`, `emil-ui-polish`, `emil-animations` with `herdr-motion`), `herdr-prototype` if the path is open, `herdr-screen-check` on worst-case data, `herdr-critic` on the PNGs, `herdr-review` and `emil-ui-review` on the diff. Update `DESIGN.md` only when a system rule changes (it must stay under 100 lines; `make docs` gates it), screen-level changes go in that screen's `design/*.md`, and update `design/attention.md` and `design/board.md` in the same change as any cutover. Mark what was not rendered **unverified**; on macOS a Linux-only check cannot be claimed.

## Words

Plain, short, specific, sentence case. Outcome first, with numbers, joined by a middle dot: `Press again to send · pushes to a remote`, `Quiet for 2m`, `Marked 3 reviewed`, `Couldn't reach build-box · Retry`. Name the thing, not the category. Say how to recover. No apology, exclamation or cuteness. Correct plurals, tabular figures. Honest tense: a subagent `was running`, never `running`, once the link is gone. `Nothing needs you`, not `All clear!`. Copy rules are in `design/typography.md` and `design/copy.md`.

## Never / Instead (the closed lists of `DESIGN.md`)

| Never | Instead |
|---|---|
| Hex, `rgb()`, `oklch()` or `text-x/60` in a screen | A semantic token class; `opacity-*` for faded text; `term-*` only for terminal colour |
| Pasting a kit component's class string; an invented `Btn`, `Pill` or `IconName` variant | `#kit` components; change `components/kit/` and `DESIGN.md` together |
| A `Card`; a box in a box; a capsule for a count | Plain rows, hairlines, a grey number |
| `text-signal` for text; a second signal mark for one agent | The mark on the row's glyph only (`design/attention.md`) |
| `ring-*` focus | `FOCUS_RING`, `FOCUS_RING_SIDEBAR`, `FOCUS_RING_INSET` |
| Selected or hover changing weight, border width or size | Colour only; reserve the line a message may take |
| Status by colour alone; a glyph (`✕`) as a name; the role word in a name | Shape, word, colour; `Icon`; `Close`, not `Close button` |
| A global shortcut without `mod`, or with `alt`; `Escape` global; `mod+q`, `F11` | `lib/shortcuts.ts`, once |
| A window-size check in a screen | `compact()`, `rail()`, `narrow()`, `snug()` |
| A duration, easing or `transition-*` outside `lib/motion.ts` | `lib/motion.ts` helpers |
| A 36 pt control beside a 32 pt field; a fixed-height text box | One row height; `min-h` so `fontScale()` 2.0 grows it |
| A new option without a Settings entry | A signal in `lib/settings.ts` and a Settings entry |

## Reviewing

For a design review report: (1) the journeys touched, one line each; (2) findings, worst first:

| # | Severity | Region / step | What the person experiences | Why it matters | Change | file:line |
|---|---|---|---|---|---|---|

Severity: **Broken** (wrong, unsafe, a dead end, lost input), **Friction** (extra steps, waits, reading), **Noise** (answers none of the five questions), **Inconsistent** (the same job done differently elsewhere), **Polish**. (3) the noise and delight ledger and the reference teardown; (4) decisions for the owner, with a recommendation; (5) a verdict. For bugs and maintainability read from a diff use `herdr-review`.

## Going deeper

- `references/journeys.md`: the surfaces, the core journeys step by step, shared parts and known seams. Read before changing a flow.
- `references/foundations.md`: the general principles behind this skill, translated for a desktop window.
- `DESIGN.md` is the system; `design/attention.md` says how state is shown once; the "Regions of the window" table in `AGENTS.md` is the short form; `docs/ACCESSIBILITY.md` is the checklist every screen answers to.
