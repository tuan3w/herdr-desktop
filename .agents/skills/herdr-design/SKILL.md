---
name: herdr-design
description: Design herdr-desktop from the supervisor's side, on a desktop window. Trace each journey (an agent needs me, glance, follow, steer, start, review, set up, something broke, away from the desk), decide what each REGION of the window is for (sidebar, main, inspector, status), question every element's purpose, and keep the app coherent. Use it for any product, UX or layout decision (a new screen, a change to a flow, copy, what to show or hide, "make it better / denser / feel right", a design review, a comparison with another app), even when the request sounds purely visual. Pair it with emil-design-foundations and emil-surfaces (craft), herdr-critic (fresh-eyes critique) and herdr-screen-check (proof in pixels).
---

# Designing herdr-desktop

Design here is **how the window works for the person**, not how it looks. The look follows. `DESIGN.md` and `design/*.md` record the system; this skill is how to decide what goes in them.

herdr-desktop descends from herdr-mobile. The journeys, the five questions and the safety rules carry over. **The layout does not.** A phone has one region at a time, one thumb and seconds of attention. A desktop has a 1280 to 2560 px window, a keyboard, a pointer and a person who keeps it open all day. Copying a phone screen into a wide window gives a stretched list with empty gutters. Most of what looks "much worse than the Claude desktop app" is this, not polish.

## Who it is for

A **supervisor, not a pair-programmer**, running many agents on many machines. Each time they look they ask, in order: **1. Does anything need me? 2. Is everything alive and on track? 3. What did it do? 4. Steer it. 5. Can I trust it?** (`AGENTS.md`). A thing that answers none is noise.

Desktop adds one more truth: **they look often and for long.** So the window is judged on three things the phone never had to face: *density* (how many agents and how much of one agent at once), *regions* (what lives where, always), and *persistence* (what stays on screen while they work in another part).

## The method

### 1. Find the moment, then the region

One sentence for the moment ("second monitor, 6 agents running, glancing between my own work"). Then name the **region** each answer lives in. A window has four, and each has one job:

| Region | Job | Never |
|---|---|---|
| **Sidebar** | The one place every agent is listed, grouped, with state. Navigation and "new". | Hold content that the main region also holds. |
| **Main** | The thing being worked on now: one agent's conversation or terminal. | Be a second list of agents. |
| **Inspector** (right, collapsible) | Facts about the open agent that you consult but don't read in sequence: where it runs, branch, context used, what changed, files, a terminal. | Hold the conversation. |
| **Status** | Connection and machine truth (live / stale / offline). | Repeat counts the sidebar already shows. |

Rules that follow:

- **An agent appears once per view.** Sidebar row, board card and "Needs you" entry for the same agent is three copies of one fact. The board is the overview *instead of* the main view, never beside a sidebar that says the same thing. If it must be both, one of them is a different view of the data (grouped by project vs. a queue of questions), not a copy.
- **Wide windows get a second region, not wider text.** The conversation stays at a readable measure (about 720 to 768 px). Spare width goes to the inspector, a split (terminal beside chat), or the diff, never to margins.
- **The inspector is where "Details" lives.** A text button that opens a modal is a missing region. Environment, context, changes, files and the terminal are tabs or sections of one right-hand panel that remembers whether it was open.

### 2. Trace the journey end to end

From trigger (a notification, a worry, a habit) to looking away. For each step write what they see, what they must understand, what they do, what the app does and what they know after. Include waits, failures (offline, stale, refused, host gone) and interruptions (window hidden, machine asleep, ssh dropped).

| Question | Look for |
|---|---|
| **Purpose** | Which of the five questions? None means noise. |
| **Necessity** | Default it, remember the last choice, fold it in, infer it. |
| **Cost** | Clicks, keystrokes, reading, waiting, eye travel across the window. |
| **Truth** | Is it true now? If it might not be, does it say so? |
| **Safety** | Worst case of a wrong click. Guard in proportion. |
| **Recovery** | On failure, what happened and what to do, without losing typed text. |

### 3. Density: one row is not enough

The agent row is the unit, but a desktop needs **tiers**. One tier for every place is the phone's habit.

| Tier | Where | Shape |
|---|---|---|
| **Compact** | Sidebar list of many agents | One line: state glyph and title. No program name, machine or age by default (they live in the project header, the inspector and the Board); only an exception adds a word (`quiet 41m`). About 30 px. |
| **Standard** | A group's expanded rows, a queue | Glyph, title, one meta line. About 48 px. |
| **Rich** | The thing that needs an answer | Question, the exact command, the choices. |

The test: at 1280 x 800, can the person see **at least 12 agents** in the sidebar and still read the open conversation? If a row costs 56 px for two lines of mostly identical text, that is the cost, not the data.

### 4. Best path patterns (carry over, unchanged)

- Bring the action to the information: answer from where the question appears, not after opening it.
- The default view is the outcome; process is one click down; a finished turn folds its log.
- Say it once, where they look. One state, one place, one mark. (`design/attention.md`.)
- Guards are proportional. Cheap and reversible is a click; a slip gets Undo; risky is two-step (press, then press again within 4 s), never a timed hold; bulk gets a confirm built from live data with the count in the button. Nothing is ever approved silently.
- Show what is approved: the command itself, whole, never truncated behind an ellipsis. **A choice chip that cuts the thing it grants (`2. Yes, and always allow access to…`) fails this rule.**
- Never a dead end. Unavailable stays, dimmed, with its reason. A failure says what and what next.
- Keep their work. Typed text survives a failed send, a hidden window and a reconnect.
- Keyboard first, and discoverable: every action has a shortcut shown in its tooltip and menu, and the palette lists them all.
- One of each: one answer dock, toast, palette, guard.

### 5. Keep a ledger: noise and delight

Mark each item keep, remove or change, with a reason.

**Noise:** the same fact twice (a count in the sidebar, the top strip and the status bar); decoration; a confirmation for something cheap; a raw id where a name exists; a label for the obvious; a card inside a card; an option almost nobody needs on the main path.

**Delight is friction that vanished:** answering without opening; `j`/`k` through the waiting queue; a thread that opens where it was left; `Marked 3 reviewed` with one Undo; the inspector already showing the branch and diff when you look.

### 6. Compare against a real reference before you decide

Do not design from memory or from this app's own docs. Open one or two apps people already find excellent for the same job (the Claude desktop app's Code view, Linear, Zed's agent panel, Superhuman for the inbox model) and write a **teardown**, one row per region:

| Region | Reference does | We do | Gap | Why it matters |
|---|---|---|---|---|

Take what answers one of the five questions; skip what is just their brand. Cite the screenshot. A gap with no reason on our side is a finding.

### 7. Check the whole app

- **Same concept on every surface: a parity table.** One row per surface where it appears, one column per property the person relies on (what is shown, the stale guard, the second step on risk, the confirmation, the failure path, the words). Fill each cell from that surface's own code, not the shared component.
- **Same object, same word.** Machine, workspace, tab, pane, agent, session, turn.
- **Entry and exit.** Notification, palette, deep link, sidebar and board all land somewhere coherent; back goes where expected.
- **Two patterns for one job:** pick one and migrate every caller (`AGENTS.md`, principle 10).
- **Resize.** Check 1280, 960 and 760. At each width a region is dropped or collapsed deliberately (inspector first, then sidebar to the rail), never squeezed.

### 8. Write the plan, then prove it

| Step | Today | Problem (question, cost, risk) | Change | Where |
|---|---|---|---|---|

Fix data correctness before polish. Build from the kit (`#kit`). Prove it with `herdr-screen-check` on worst-case data. Update `DESIGN.md` only when a system rule changes, with the reason next to it. Screen-level tweaks go in the screen's `design/*.md`.

## Words

Plain, short, specific, sentence case. Outcome first, with numbers: `Hold` is not used here; `Press again to send · pushes to a remote`, `Quiet for 2m`, `Marked 3 reviewed`, `Couldn't reach build-box · Retry`. Name the thing, not the category. Say how to recover. No apology, no exclamation. Honest tense: a subagent `was running`, never `running`, once the link is gone.

## Reviewing

For a design review report:

1. The journeys touched, one line each.
2. Findings, worst first: `| # | Severity | Region / step | What the person experiences | Why | Change | file:line |`. Severity is Broken, Friction, Noise, Inconsistent or Polish.
3. The noise and delight ledger and the reference teardown.
4. Decisions for the owner: more than one right answer, with a recommendation.
5. A verdict.

Respect a decision `DESIGN.md` documents with a reason. Reopen it only with new evidence (a measurement, a capture, a journey it breaks) and name it.

## Going deeper

`DESIGN.md` is the system. `design/attention.md` says how state is shown once. The regions and density tiers are above, and the "Regions of the window" table in `AGENTS.md` is the short form. For craft, defer to `emil-design-foundations`, `emil-surfaces`, `emil-typography`, `emil-ui-polish`, `emil-animations`.
