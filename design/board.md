# The home, the answer dock, triage and bulk actions

The Board is the overview of every agent when the person is triaging rather than following one. The sidebar is the daily list; the Board is the same list as a wider table. Today's code: `components/board.tsx` (`Board`), `board-card.tsx` (`ProjectCard`, `AgentRow`, `Opener`), `project-parts.tsx` (`ProjectMark`, `Monogram`), `answer-dock.tsx` (`AnswerDock`), `bulk-bar.tsx` (`BulkBar`) with `bulk-confirm.tsx` (`BulkConfirm`), `pick-box.tsx` (`PickBox`), `status-bar.tsx` (`StatusBar`). The data is `lib/herdr.ts` (`board`, `revision`, `projectOf`, `rowOf`), the layout rules `lib/board-items.ts` (`strip`, `homeLines`) and `lib/sidebar.ts` (`shownRows`, folds and pins shared with the sidebar), the opening rules `lib/open-agent.ts` (`openAgent`), the picks `lib/selection.ts`, `lib/bulk.ts` (`planBulk`). Product wording is herdr-mobile's (`To review`, `The question changed`).

## Decided, not built yet: the table

The code still draws project cards and a Needs you inbox (`NeedsYou`, `Question`); the walk dialog and `Answer one by one` are gone, `Answer` on a row opens the agent. Owner decision 2026-11-07: they go, in one change (principle 10 of AGENTS.md), for these reasons.

- **The Board is a table grouped by project**, the same grouping as the sidebar. Why: cards inside a card repeated the sidebar's list and used one third of the width for nothing.
- **State is a filter chip, not a section.** The chips are the counts (Need you, Working, To review, Idle), said once; an agent is never listed under a second heading. Why: a Needs you section listed agents the project groups already listed.
- **Columns carry what the sidebar leaves out**: machine, last activity, age. About 20 agents fit without scrolling. It wins at 15 or more agents across machines and loses at 3, where the sidebar is enough (unverified: a prototype, not a render of the app).
- **The sidebar collapses to a rail on the Board** with one dot per project that needs you, so the two lists are never both open.
- **A stale machine is named once** (amber name) and its rows get a dashed glyph.
- **Answering many at once lives here**: filter Need you, pick rows, answer together with the count in the button. It costs a click per agent when many ask for the same safe thing; that is the price of one answer place. The rules of the answer dock below apply to each.
- **Order is stable** (last activity), never re-sorted by state, so a row does not move under the pointer.

## Projects, not states

The Board and the sidebar are organised by **project**: a repository (with its linked worktrees) or a folder, on one machine. State is a mark on a row, never the layout. The core derives the project (`native/core/src/project.rs`): herdr's `repo_key` for a workspace in a git repository, else the workspace's label, else the folder the agent runs in; a chat session, which has no workspace, joins the project whose checkout or repository root holds its folder (the deepest wins), else its folder is a project of its own. The same repository on two machines is two projects.

- **Order never moves under the pointer.** Today: pinned projects first, then by name; counts and states reorder nothing, and only a pin (`Herdr.pinProject`) moves a project. Inside a project, agents that need you come first, then the rest newest state first (today's code; the decided order is last activity, see above).
- **Idle is inventory.** A project lists everyone who works, waits or finished, and its first `QUIET_SHOWN` (3) idle agents; the rest fold behind `N more idle in <project>`. A search lists every match.
- A project's header names its machine, muted, unless it is this computer (the same project on two machines is two groups), `Pinned`, and a waiting count only while the project is collapsed (`ProjectMark`; design/attention.md). Hovering it offers a new session there, with its machine and folder chosen.
- A row is a state glyph and a title: no program name, no age; only an exception adds a word (`quiet 41m`) or a dashed glyph. The program shows in the inspector and in the composer note when it limits you.
- **Layout (today's cards).** One column below `TWO_COLUMNS_FROM` (760 pt of the home itself), two above; a project listing `WIDE_ROWS` agents takes the whole line. A card's place depends only on the cards before it. The home scrolls (cards are not virtualized: the idle fold keeps what is built small).

## One count

The Rust engine builds the board once per change; `board()` pulls it once per `revision()` and every reader shares it. The status line (`board().statusLine`), the window title, the status bar, the filter chips and the jump to the next waiting agent therefore never disagree. A machine that is not connected lists its agents dimmed and marked `offline`, and never counts as needing you.

- `3 to review` in the status line is a button: it picks exactly the finished agents (`select`) and unfolds the projects that hold them. `Reviewed` in the bar then marks them under one `Undo` (`reviewWithUndo`). Opening a finished agent never reviews it; `Reviewed` on its row (hover or focus) does.

## The answer dock

One component, one behaviour. Decided, not built yet: it sits in the agent's own conversation in place of the composer, so there is no second place to answer; the code still also mounts it in the inbox and triage. Why: a question belongs next to the work that raised it, and a waiting question stays visible in the sidebar's mark. It shows the question, the command or path being approved in full (wrapped, never cut) and one chip per option, in the agent's own words. More than five options: the last chip is `N more…` and opens every answer.

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

## Moving between waiting agents

`mod+j` (`lib/shortcuts.ts`) jumps to the next agent that needs you, in any project. It never answers and never moves on by itself after an answer, so nothing slides under the person's hand. After an answer the dock says how many still wait and offers Next. The dock offers it through `onNext`; the walk dialog no longer exists.

## Picking and bulk actions

`lib/selection.ts` holds the picked keys (`BoardRow.key`), shared by the home and the sidebar and pruned to rows still on the board. `PickBox` is the box: press toggles, Shift-press picks the range from the last toggled (`rangeTo`, in the order the cards list their rows), Space toggles, Return does not. It shows on hover or focus, and always once anything is picked.

`BulkBar` exists only while something is picked and is mounted once under the page. `Reviewed` acts at once with one `Undo`. `Stop` (Esc), `Message` (text then Enter) and `Close` (closes the panes, cannot be undone) open `BulkConfirm`, built from live data (`planBulk`): who is reached, `Waiting for an answer (skipped)` and `Not connected (skipped)`. An agent waiting on a question is typed into only with `Send anyway` (`Close anyway` for Close), off every time the dialog opens. The plan is worked out again when the button is pressed. The result is one toast (`Stopped 3 agents`, or `Stopped 2 · 1 failed: name: why`, lasting).

## The status bar and the sidebar footer

Counts are said once (the Board badge, the project marks); a machine's link is said where the machines are: the **sidebar footer** (`SidebarFooter` in `components/sidebar-footer.tsx`, above `Settings`, not in the rail). It draws nothing while every machine is online; otherwise one wrapped line per machine that is not (name in `text-warning`, a dashed or half ring, what happened and what comes next, `Fix` only for `attention`), three lines at most plus a fourth, then `and N more machines` as one line that opens the rest. A switched-off machine is the person's choice and is not listed.

`StatusBar` is only the `Context N%` meter of the chat in front, one muted line under the workspace, right-aligned, drawn only while that chat reports a context: the Board and a chat without a meter show no bar. It is the stand-in until the inspector's Overview tab exists, and is then deleted. Nothing is estimated: a meter an agent does not report is not drawn.

## Folders reached by a link

One folder can have two names on this computer (macOS: `/var` is a link to `/private/var`, a checkout may sit behind `~/work -> /Volumes/...`). herdr reports a checkout by one, a session's log may use the other. `Directory` (`native/core/src/project.rs`) resolves both through `real_path` before matching a folder to a project, so a chat started through a link joins its repository's project; `projectOfFolder` (`lib/dock.ts`) does the same with `Git.canonicalPath` for a tab. Case is never folded. Limit: a remote machine's folders are compared as given, since only that machine could resolve them. A terminal agent in a workspace of a repository is placed by its workspace, not by its folder, so it needs none of this.

## Tests

`board.test.tsx`, `answer-dock.test.tsx`, `bulk.test.tsx`, `sidebar.test.tsx`, `workspace.test.tsx` and `projects-chat.test.tsx` run against the scripted herdr (`fixtures/herdr/projects.json`, `mixed.json`, `storm.json`) through `board-lab.tsx`, `sidebar-lab.tsx` and the whole app; `board-seam.ts` moves that herdr on (a new question, a state change, a pane closed, more idle agents) and `sentKeys` reads what it was sent. The pure rules are in `lib/board-items.test.ts` and `lib/sidebar.test.ts` over `lib/board-rows.fixture.ts`; the grouping is in `native/core/tests/board.rs`. Time is the test clock, never a sleep.
