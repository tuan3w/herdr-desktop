# The board, the answer dock, triage and bulk actions

`components/board.tsx` (home), `board-card.tsx` (`AgentCard`, `AgentRow`), `answer-dock.tsx` (`AnswerDock`), `triage.tsx` (`Triage`), `bulk-bar.tsx` (`BulkBar`) with `bulk-confirm.tsx` (`BulkConfirm`), `pick-box.tsx` (`PickBox`). The data is `lib/herdr.ts` (`board`, `revision`, `meta`, `startHerdr`), the picks `lib/selection.ts`, the pure rules `lib/board-items.ts` (`boardItems`) and `lib/bulk.ts` (`planBulk`). Product wording is herdr-mobile's (`Needs you`, `To review`, `Working`, `Idle`, `Answer one by one`, `The question changed`).

## One count

The Rust engine builds the board once per change; `board()` pulls it once per `revision()` and every reader shares it. The status line (`board().statusLine`), the sections, the window title and the triage walk therefore never disagree. A machine that is not connected lists its agents dimmed and marked `offline`, and never counts as needing you (the `Needs you` header says `N offline`).

- Sections in order: `Needs you` (never folds, longest waiting first), `To review`, `Working`, `Idle`. An empty section has no header.
- `Idle` shows the five newest; `board().idleRest` holds the others behind one line (`22 more idle: api-fix, docs…`) that opens them in place and then reads `Show less`. Folds and that open state are the sidebar's (`folded`, `idleOpen` in `lib/sidebar.ts`): one state for both lists.
- `3 to review` in the status line is a button: it picks exactly the finished agents (`select`) and opens `To review` when folded. `Reviewed` in the bar then marks them under one `Undo` (`reviewWithUndo`). Opening a finished agent never reviews it; `Reviewed` on its row (hover or focus) does.
- Rows are `AgentRow` (one line: glyph, name, `folder · agent · machine`, age); an agent that needs you and can be answered is an `AgentCard`: its question through `AnswerDock`, or the last eight rows of its screen when the app does not understand the question, and `Reply…` (opens the pane with the message box).
- The list is a virtualized `List`: rows are plain data (`BoardItem`), cells are recycled, so a card reads its row as an accessor and holds no state that could leak to another agent. The one stateful part, `AnswerDock`, resets whenever its machine, pane or question changes.

## The answer dock

One component for the board card, the pane tab and `Triage`: one behaviour. It shows the question, the command or path being approved in full (wrapped, never cut) and one chip per option, in the agent's own words. More than five options: the last chip is `N more…` and opens every answer.

Safety rules, each tested in `components/answer-dock.test.tsx`:

| Rule | Why |
|---|---|
| Nothing sends by itself: no timer, no default, no notification. | Nothing is ever approved silently. |
| An answer pressed within `GUARD_MS` (400 ms) of appearing, of the question changing or of the list opening is ignored and dimmed. | A press aimed at one question must not land on the next. |
| The press goes through `Herdr.answer(machine, pane, digest, index)`: the pane is read again and the keys go only if it still shows that question. `changed` says `The question changed` on the chip; `notBlocked` and `failed` say so under the answers. | A question answered elsewhere must not receive a stale `1`. |
| A risky answer (`riskReason`, or `standingGrant`) is two-step: the first press arms it for `ARM_MS` (4 s) and shows `Press again to send · <reason>`, announced politely; the second sends. It disarms by itself and when the question changes. Focus stays on the chip. | Timed holds are not accessible. |
| Keys `1` to `9` pick the nth visible answer only while an answer has the focus; the guard and the two steps still apply. | A digit typed elsewhere must never answer. |
| The dock never takes the focus. | Nothing moves under the person's hands. |

A chip is a pressable `View` (not nsh's `Button`: it has no focus events). Its accessible name is the option's label; armed, it adds `Press again to send, <reason>`. Headless, Tab reaches pressable views only with `platform: "macos"`, so the focus test opens as that idiom.

## Triage

`Answer one by one` is on the `Needs you` header when more than one agent needs you. `Triage` walks `board().needsYou` without the unreachable ones: `1 of 2 need you`, `Previous agent` and `Next agent` (they wrap), the dock or the last rows of the screen, a message box (Enter sends text and Enter to that pane), `Open`. It follows an agent by key, so a newcomer never swaps the one being read; when the agent stops waiting the walk goes on from its place, and with none left it says `All clear`.

## Picking and bulk actions

`lib/selection.ts` holds the picked keys (`BoardRow.key`), shared by the board and the sidebar and pruned to rows still on the board. `PickBox` is the box: press toggles, Shift-press picks the range from the last toggled (`rangeTo`), Space toggles, Return does not. It shows on hover or focus, and always once anything is picked.

`BulkBar` exists only while something is picked and is mounted once under the page. `Reviewed` acts at once with one `Undo`. `Stop` (Esc), `Message` (text then Enter) and `Close` (closes the panes, cannot be undone) open `BulkConfirm`, built from live data (`planBulk`): who is reached, `Waiting for an answer (skipped)` and `Not connected (skipped)`. An agent waiting on a question is typed into only with `Send anyway` (`Close anyway` for Close), off every time the dialog opens. The plan is worked out again when the button is pressed. The result is one toast (`Stopped 3 agents`, or `Stopped 2 · 1 failed: name: why`, lasting).

## Tests

`board.test.tsx`, `answer-dock.test.tsx`, `triage.test.tsx` and `bulk.test.tsx` run against the scripted herdr (`fixtures/herdr/mixed.json`, `storm.json`) through `board-lab.tsx` and `answer-dock-lab.tsx`; `board-seam.ts` moves that herdr on (a new question, a state change, a pane closed, more idle agents) and `sentKeys` reads what it was sent. Time is the test clock, never a sleep.
