# The home, the answer dock, triage and bulk actions

`components/board.tsx` (`Board`, the home tab), `board-card.tsx` (`ProjectCard`, `AgentRow`, `Opener`, `Question`), `project-parts.tsx` (`StateChips`, `Monogram`), `answer-dock.tsx` (`AnswerDock`), `triage.tsx` (`Triage`), `bulk-bar.tsx` (`BulkBar`) with `bulk-confirm.tsx` (`BulkConfirm`), `pick-box.tsx` (`PickBox`), `status-bar.tsx` (`StatusBar`). The data is `lib/herdr.ts` (`board`, `revision`, `projectOf`, `rowOf`), the layout rules `lib/board-items.ts` (`strip`, `homeLines`) and `lib/sidebar.ts` (`shownRows`, folds and pins shared with the sidebar), the opening rules `lib/open-agent.ts` (`openAgent`), the picks `lib/selection.ts`, `lib/bulk.ts` (`planBulk`). Product wording is herdr-mobile's (`Needs you`, `To review`, `Answer one by one`, `The question changed`).

## Projects, not states

The home and the sidebar are organised by **project**: a repository (with its linked worktrees) or a folder, on one machine. State is what every row and every project header shows, never the layout. The core derives the project (`native/core/src/project.rs`): herdr's `repo_key` for a workspace in a git repository, else the workspace's label, else the folder the agent runs in; a chat session, which has no workspace, joins the project whose checkout or repository root holds its folder (the deepest wins), else its folder is a project of its own. The same repository on two machines is two projects.

- **Order never moves under the pointer.** Pinned projects first, then by name. Counts and states reorder nothing: a project that starts needing you gets a louder header, it keeps its place. Only a pin (`Herdr.pinProject`) moves a project. Inside a project, agents that need you come first (longest waiting first), then the rest newest state first: attention leads because it is the one reason to look, recency follows because it is what a returning person wants next.
- **Idle is inventory.** A project lists everyone who works, waits or finished, and its first `QUIET_SHOWN` (3) idle agents; the rest fold behind `N more idle in <project>`. A search lists every match.
- A project's header: its name (a button that folds it, the fold is shared with the sidebar), the machine when there are several, `Pinned`, then the state as shape and number chips (`StateChips`: needs you = the disc with a bar and a signal capsule, working = half ring, to review = check; zero is not shown), `Pin` on hover or focus. Under it the checkout chips (when it has a linked worktree or several), its agents, and `New agent session in <project>` (the folder is the main checkout, `projectFolder`).
- Agents are chat sessions and terminal agents together: glyph, name, `agent · checkout · chat|terminal`, age, and for a chat the first line of what the agent said last. A chat that needs you says `Waiting for your answer in the chat`: its permission dock, with its own two-step rule, is in the chat tab.
- **Layout.** One column below `TWO_COLUMNS_FROM` (760 pt of the home itself), two above; a project listing `WIDE_ROWS` agents takes the whole line. A card's place depends only on the cards before it. The home scrolls (cards are not virtualized: the idle fold keeps what is built small).

## One count

The Rust engine builds the board once per change; `board()` pulls it once per `revision()` and every reader shares it. The status line (`board().statusLine`), the project chips, the window title, the status bar and the triage walk therefore never disagree. A machine that is not connected lists its agents dimmed and marked `offline`, and never counts as needing you.

- `3 to review` in the status line is a button: it picks exactly the finished agents (`select`) and unfolds the projects that hold them. `Reviewed` in the bar then marks them under one `Undo` (`reviewWithUndo`). Opening a finished agent never reviews it; `Reviewed` on its row (hover or focus) does.

## The Needs you inbox

Over the projects, while something waits, `NeedsYou` shows the agent that has waited longest (`STRIP_SHOWN`, 1) with its question and the one `AnswerDock`: an answer takes a tall dock, so more would push the projects off the screen; `N more waiting` and `Answer one by one` (`Triage`) take the rest. It is an inbox over the projects, not the layout: it takes no room when empty, reserves nothing and does not animate. **Each question is answered in one place**: the agent that is in the inbox has `Answer it in Needs you, above` on its project row instead of a second set of chips, and the row of every other waiting agent carries its own dock (the next to wait longest moves up into the inbox when it is answered). The inbox has no picking box (picking happens on the rows).

## The answer dock

One component for the home, the pane tab and `Triage`: one behaviour. It shows the question, the command or path being approved in full (wrapped, never cut) and one chip per option, in the agent's own words. More than five options: the last chip is `N more…` and opens every answer.

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

## Opening an agent

`openAgent(row)` decides the view. A chat session opens its chat tab. A terminal agent that is omp, Claude Code or Codex (`Sessions.canObserve`) opens the chat read from its log, with `Show terminal` one press away (a button in the chat's header, the palette entry of the same name); everything else opens the terminal mirror. The choice is per pane and lasts for the run; `Show chat` (palette, the terminal's header) swaps back. Rows say which view they open only through their detail line: `chat` or `terminal`.

## Triage

`Answer one by one` is on the inbox when more than one agent needs you. `Triage` walks `board().needsYou` without the unreachable ones: `1 of 2 need you`, `Previous agent` and `Next agent` (they wrap), the dock or the last rows of the screen, a message box (Enter sends text and Enter to that pane), `Open`. A chat waits for its answer in its tab: the dialog says so and `Open` goes there. It follows an agent by key, so a newcomer never swaps the one being read; when the agent stops waiting the walk goes on from its place, and with none left it says `All clear`.

## Picking and bulk actions

`lib/selection.ts` holds the picked keys (`BoardRow.key`), shared by the home and the sidebar and pruned to rows still on the board. `PickBox` is the box: press toggles, Shift-press picks the range from the last toggled (`rangeTo`, in the order the cards list their rows), Space toggles, Return does not. It shows on hover or focus, and always once anything is picked.

`BulkBar` exists only while something is picked and is mounted once under the page. `Reviewed` acts at once with one `Undo`. `Stop` (Esc), `Message` (text then Enter) and `Close` (closes the panes, cannot be undone) open `BulkConfirm`, built from live data (`planBulk`): who is reached, `Waiting for an answer (skipped)` and `Not connected (skipped)`. An agent waiting on a question is typed into only with `Send anyway` (`Close anyway` for Close), off every time the dialog opens. The plan is worked out again when the button is pressed. The result is one toast (`Stopped 3 agents`, or `Stopped 2 · 1 failed: name: why`, lasting).

## The status bar

`StatusBar` is a slim line under the workspace: machines connected, the same needs-you and working counts, and, while a chat is in front, `Context N%` as the session reports it. Nothing is estimated: a meter an agent does not report is not drawn.

## Tests

`board.test.tsx`, `answer-dock.test.tsx`, `triage.test.tsx`, `bulk.test.tsx`, `sidebar.test.tsx`, `workspace.test.tsx` and `projects-chat.test.tsx` run against the scripted herdr (`fixtures/herdr/projects.json`, `mixed.json`, `storm.json`) through `board-lab.tsx`, `sidebar-lab.tsx` and the whole app; `board-seam.ts` moves that herdr on (a new question, a state change, a pane closed, more idle agents) and `sentKeys` reads what it was sent. The pure rules are in `lib/board-items.test.ts` and `lib/sidebar.test.ts` over `lib/board-rows.fixture.ts`; the grouping is in `native/core/tests/board.rs`. Time is the test clock, never a sleep.
