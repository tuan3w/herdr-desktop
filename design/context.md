# Context

A person supervising twenty agents thinks "the payments API", then "the infra repo", then "what needs me". The workspace follows: it shows one **context** at a time, and the tabs of the others are put away, not closed.

## What a context is

- **Home** (`HOME`): the board, and whatever was left there. The one context outside any project. `mod+1` shows it; the board tab is never closable, so Home is never empty.
- **A project** (`BoardProject.key`): its own layout (groups, splits, sizes, the displayed tab of each group) and its own focused tab. It may hold no tab: the workspace then shows the project's own card (`ProjectEmpty`: agents, state, `New agent session`), so a context is never blank. Closing the last tab does not delete the context.
- **Agents** are destinations inside contexts. A tab belongs to its agent's project: `openPanel` of an agent open somewhere shows it where it is (its context comes back with it); otherwise it is added to the project's context, which is shown (`homeOf`). `openPanel(key, { here: true })` puts it in the context shown instead and moves it out of the one that had it (a tab is in one context only). `Open here` is `Shift+Enter` in the Switcher and an item of a project's menu (its first agent); the action panel of the palette reuses `{ here: true }`.

## What comes back

`switchContext` swaps the layout the `DockArea` shows; the old project's tabs unmount. Restored: the layout, the focused tab (made the displayed tab of its group), the unsent message of each composer, the scroll position of each chat. Not restored, on purpose: pane screens (they are live; a restored pane tab is a fresh mirror of the same pane), selections, find queries, window size, sidebar folds.

| Data | Where | Kept |
|---|---|---|
| Layouts | `Storage` `herdr.dock.v2`: `{ v, current, home, contexts, strays }` (`readDock`, `writeDock`) | written after a 500 ms quiet period; the newest `CONTEXT_CAP` contexts, the shown one always; a context whose project the board lacks is dropped after `GONE_AFTER_MS` |
| Drafts | memory (`lib/view-state.ts`, `draftOf`, `setDraft`) | across switches, never across a restart: a draft can hold a pasted secret |
| Chat scroll | `Storage` `herdr.views.v1` (`anchorOf`, `setAnchor`): at the end, or this far above it; a chat reopens there once enough of it is loaded, else at the end | across restarts; `ANCHOR_CAP` entries |
| Visits | Rust `recents.json` (`Herdr.visit`, `recents`, `forget`) | ids, the last ten times, a count; never pane contents |

The file of the first version (`herdr.dock.v1`, one layout) opens as the Home as it was and is split by project when the board first knows its panels (`bucket`, `adopt`); a panel whose project is unknown stays in Home as a stray and is adopted when its row turns up. The old key is removed only after the new one was written.

## Going somewhere (`lib/nav.ts`)

| Key | Does |
|---|---|
| `ctrl+tab`, `ctrl+shift+tab` | swap with the previous agent / project (taps: again comes back) |
| `mod+e`, `mod+shift+e` | the Switcher (`components/switcher.tsx`): places visited last, row two highlighted (row one is where you are), `mod+e` moves down, `Enter` opens, `Escape` leaves things as they were; rows fixed while open, their shape and age live |
| `mod+[`, `mod+]` | back and forward through the places gone to by command (50, a click replaces the step, a command drops what was ahead, a place whose agent is gone is skipped) |
| `mod+shift+[`, `mod+shift+]` | previous and next project in the sidebar's order, wrapping |

`ctrl+tab` is spelled with `ctrl`, not `mod`, and carries `always` (a text field uses Tab). Nothing can report a key release in nsh 0.4.0, so there is no hold-to-cycle.

## Jumping to a waiting agent

`mod+j` (`lib/shortcuts.ts`) goes to the next agent that needs the person, in any project; if it lives in another context it switches the context. It never answers and never advances by itself after an answer. Why: with a stable sidebar order a marked row can sit below the fold, and the jump must not make rows slide under the hand (`design/attention.md`). A project header names its machine, so the same project on two machines is two contexts, each with its own branch and tabs.

## Where a person presses

In the sidebar and on a Board row the project name shows the project's workspace and the chevron alone folds it; the card of a project with no tab open has no fold control. The rail's popover has `Show project`. A project's menu has `Switch to this project` and `Open here`.

## Motion

A project switch is the one deliberate exception to "switching never animates": the incoming workspace fades from `CONTEXT_FROM` to 1 in `DURATION.context` (`contextEnter`), with no fade-out and nothing waiting for it; skipped when a second switch comes within `CONTEXT_REPEAT_MS`, when a key caused it (every global shortcut calls `markKeyboard()` first in `App.tsx`; `play` is silent for `KEY_WINDOW_MS`, 250 ms) and under reduced motion. So `ctrl+shift+[` never fades; a click on a project does. It moves the area's wrapper, never a pane's rows.

## Measured

`Herdr.metrics()` has `watchedPanes` (flat across switches: a mirror stops watching when its tab unmounts). The `.perf` scenario `switch project x20` presses `ctrl+shift+[` and `]` twenty times and reports the commit time, memory, threads, descriptors and watched panes (`docs/PERFORMANCE.md`).

## Calm

The Switcher and the card follow `design/attention.md`: the quiet shape and a muted word, never the signal colour. A screen reader hears each Switcher row whole with its place (`2 of 5`); a switch announces `payments, 3 tabs, 1 needs you`.
