# The home, the answer dock and the status bar

The Board (the home's table of every agent, the state chips, the bulk answer view and the selection bar) was removed 2026-11-19 (owner: "not see any value here"). The sidebar is the one list of agents; the main region with nothing open shows the last agent, else a quiet empty state (`components/project-empty.tsx`). Bulk answering is gone: an agent is answered in its own conversation, and `mod+j` is the walk. What this page keeps is what outlived it.

## Projects, not states

The sidebar is organised by **project**: a repository (with its linked worktrees) or a folder, on one machine. State is a mark on a row, never the layout. The core derives the project (`native/core/src/project.rs`): herdr's `repo_key` for a workspace in a git repository, else the workspace's label, else the folder the agent runs in; a chat session, which has no workspace, joins the project whose checkout or repository root holds its folder (the deepest wins), else its folder is a project of its own. The same repository on two machines is two projects.

- **Order never moves under the pointer.** Pinned projects first, then by name; counts and states reorder nothing, and only a pin (`Herdr.pinProject`) moves a project. Inside a project, agents that need you come first, then the rest newest state first.
- **Idle is inventory.** A project lists everyone who works, waits or finished, and its first `QUIET_SHOWN` (3) idle agents; the rest fold behind `N more idle in <project>`. A search lists every match.
- A project's header names its machine, muted, unless it is this computer (the same project on two machines is two groups), `Pinned`, and a waiting count only while the project is collapsed (`ProjectMark`; design/attention.md). Hovering it offers a new session there, with its machine and folder chosen.
- In the sidebar a row is a type mark, a title and a state glyph: no machine, no age; only an exception adds a word (`quiet 41m`) or a dashed glyph. The type mark (which agent it is) is identity, not attention: the neutral mark in the muted ink, Claude and Codex in their brand colour, and it never takes the signal colour (`design/attention.md`, `design/components.md`).

## One count

The Rust engine builds the board once per change; `board()` pulls it once per `revision()` and every reader shares it. The sidebar's empty text (`board().statusLine`), the window title and the jump to the next waiting agent therefore never disagree. A machine that is not connected lists its agents dimmed and marked `offline`, and never counts as needing you. Opening a finished agent never reviews it; `Reviewed` on its row (hover or focus) does.

## The answer dock

One component, one behaviour: it sits in the agent's own conversation in place of the composer, so there is no second place to answer. A question belongs next to the work that raised it, and a waiting question stays visible in the sidebar's mark. It shows the question, the command or path being approved in full (wrapped, never cut) and one chip per option, in the agent's own words. More than five options: the last chip is `N more…` and opens every answer.

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

`openAgent(row)` decides the view. A chat session opens its chat tab. A terminal agent that is omp, Claude Code or Codex (`Sessions.canObserve`) opens the chat read from its log, with `Show terminal` one press away (a button in the chat's header, the palette entry of the same name); everything else opens the terminal mirror. The choice is per pane and lasts for the run; `Show chat` (palette, the terminal's header) swaps back. A row does not say which view it opens.

## Moving between waiting agents

`mod+j` (`lib/shortcuts.ts`) jumps to the next agent that needs you, in any project. It never answers and never moves on by itself after an answer, so nothing slides under the person's hand. After an answer the dock says how many still wait and offers Next.

## The status bar and the sidebar footer

Counts are said once (the project marks); a machine's link is said where the machines are: the **sidebar footer** (`SidebarFooter` in `components/sidebar-footer.tsx`, above `Settings`, not in the rail). It draws nothing while every machine is online; otherwise one wrapped line per machine that is not (name in `text-warning`, a dashed or half ring, what happened and what comes next, `Fix` only for `attention`), three lines at most plus a fourth, then `and N more machines` as one line that opens the rest. A switched-off machine is the person's choice and is not listed.

`StatusBar` is only the `Context N%` meter of the chat in front, one muted line under the workspace, right-aligned, drawn only while that chat reports a context: a chat without a meter shows no bar. It is the stand-in until the inspector's Overview tab exists, and is then deleted. Nothing is estimated: a meter an agent does not report is not drawn.

## Folders reached by a link

One folder can have two names on this computer (macOS: `/var` is a link to `/private/var`, a checkout may sit behind `~/work -> /Volumes/...`). herdr reports a checkout by one, a session's log may use the other. `Directory` (`native/core/src/project.rs`) resolves both through `real_path` before matching a folder to a project, so a chat started through a link joins its repository's project; `projectOfFolder` (`lib/dock.ts`) does the same with `Git.canonicalPath` for a tab. Case is never folded. Limit: a remote machine's folders are compared as given, since only that machine could resolve them. A terminal agent in a workspace of a repository is placed by its workspace, not by its folder, so it needs none of this.

## Tests

`answer-dock.test.tsx`, `sidebar.test.tsx`, `workspace.test.tsx` and `projects-chat.test.tsx` run against the scripted herdr (`fixtures/herdr/projects.json`, `mixed.json`) through `sidebar-lab.tsx` and the whole app; `components/test-seam.ts` moves that herdr on (a new question, a state change, a pane closed, more idle agents) and `sentKeys` reads what it was sent. The pure rules are in `lib/sidebar.test.ts` over `lib/board-rows.fixture.ts`; the grouping is in `native/core/tests/board.rs`. Time is the test clock, never a sleep.
