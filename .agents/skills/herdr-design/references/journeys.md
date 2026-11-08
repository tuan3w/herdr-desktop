# The journeys of herdr-desktop

A map of what the app does for the person, written from `AGENTS.md`, `design/*.md` and `docs/`. It is a starting point, not a source of truth: **verify each row against the code before relying on it** (cite `file:line`), and when a doc says "Decided, not built yet" treat the row as a plan. Where the code and this file disagree, the code wins and this file is stale: fix it in the same change.

## Surfaces

| Surface | What it is | Code and doc |
|---|---|---|
| Sidebar | The one list of every agent, grouped by project, state glyph and title on a row; collapses to the rail (one dot per project that needs you) while the Board is in front | `components/sidebar.tsx`, `lib/sidebar.ts`, `design/components.md`, `design/attention.md` |
| Board | A table of every agent grouped by project; filter chips `Need you`, `Working`, `To review`, `Idle` are the only counts; bulk answer and `Reviewed` live here | `components/board.tsx`, `board-card.tsx`, `bulk-answer.tsx`, `design/board.md` |
| Chat tab | An agent's conversation: ranked turns, one live line, the message box, queue, attachments | `components/session-*.tsx`, `design/chat.md`, `design/composer.md` |
| Answer dock | The one place a question is answered; replaces the message box; never takes focus | `components/answer-dock.tsx`, `lib/dock.ts`, `design/board.md` |
| Pane / terminal | The live mirror of an agent's pane (Rust rows, never TSX) | `components/pane-tab.tsx`, `design/pane.md` |
| Inspector | Right, collapsible, remembers its state: overview, changes, files, terminal. Check what is built before designing against it (`AGENTS.md` "Still open") | `design/changes.md`, `design/files.md`, `design/tabs.md` |
| Changes | Diff review with notes to the agent and revert | `components/changes*.tsx`, `design/changes.md` |
| Palette | `mod+k`: agents, projects, commands, files; two-step commands | `components/palette*.tsx`, `design/palette.md` |
| Switcher | `mod+e`: places visited last | `components/switcher.tsx`, `lib/nav.ts`, `design/context.md` |
| New agent | `mod+n`, a project header's plus, the empty project card | `components/start-agent.tsx`, `new-session.tsx`, `design/chat-parts.md` |
| Settings, Machines | Pages in the main region, not modals | `components/settings*.tsx`, `machines.tsx`, `design/patterns.md` |
| Status bar and footer | Connection truth per machine, one line | `components/status-bar.tsx`, `sidebar-footer.tsx` |
| Notifications, window title | `(N) Herdr Desktop`; OS notifications by platform | `docs/ALERTS.md`, `docs/MACOS.md` |

## Journeys

### 1. An agent needs me (the one that matters)

Trigger: a notification, the window title count, a mark on a sidebar row, the Board's `Need you` chip, or `mod+j`.

1. They see the signal mark on one row (said once, `design/attention.md`). `mod+j` walks only waiting agents, announces whose conversation opened, never answers.
2. The chat opens with the answer dock where the box was: the question, the exact command or path whole, the choices as the agent worded them, `Nothing is sent until you choose`.
3. They press a choice (keys 1 to 9 only while an answer has focus). A press within 400 ms (`GUARD_MS`) of the question appearing is ignored. A risky choice arms for 4 s (`ARM_MS`) and says why; the second press sends.
4. The answer path re-reads the pane and refuses if the question changed (`The question changed`). They know it went when the dock leaves and the dock offers `Next`.

Failures: the pane left the blocked state (`notBlocked`), the machine went stale, the relay died. Each says what happened. Several at once: Board, chip `Need you`, tick rows, every command in full, boxes unticked, two presses, the count in the button.

### 2. Glance: is everything alive?

Sidebar rows (state glyph, title), stale machine as an amber project-header name, dashed glyphs and one footer line, `quiet 41m` on an exception. The Board adds `Last` and `Age`. Questions to ask: can they tell stale from live without reading? Is a connected machine a dot, never the check that means done?

### 3. What did it do? (follow, review)

Open the agent: chat read from its log for omp, Claude Code and Codex (`Show terminal` one press away), else the terminal mirror. The turn shows the answer, failures and effects outside the working tree; reads and commands fold to one muted line; paths and counts link into the inspector. `Reviewed` marks a finished agent (hover or focus on its row), with one Undo. Changes: `j`/`k` files, `n`/`p` changes, `x` reviewed, `c` note, `mod+enter` preview the notes to send.

### 4. Steer

Type in the box (`Enter` sends, `Shift+Enter` newline; a draft survives a project switch), `/` slash commands, `@` mentions, attach files (`mod+shift+o`), a message queue (`session-queue.tsx`; check in the code what stop and redirect do before designing on them). Terminal agents are steered by keys into the pane; anything typed into a remote shell is validated or single-quoted (`shq()`).

### 5. Start

`mod+n` or a project header's plus (the project and machine are pre-chosen), the palette, the empty project card. The new session opens in the project's context. Failure: `start-fails` fixture covers what the person sees when a start fails.

### 6. Go somewhere

`mod+k` palette, `mod+p` find a file, `mod+e` switcher, `ctrl+tab` previous agent, `mod+[` / `mod+]` back and forward, `mod+1` Board, `mod+0` sidebar, `mod+b` hide it, `mod+shift+1..9` tabs, `mod+\` split. A project is a context with its own layout, restored on return (`herdr.dock.v2`).

### 7. Set up and recover

Machines (add by ssh destination, test, host key, relay), Settings (every option is a signal in `lib/settings.ts`), updates. A machine that is offline lists its agents dimmed and `offline` and never counts them as waiting.

### 8. Away from the desk

Notifications (`docs/ALERTS.md`: Linux over D-Bus with buttons, macOS through `osascript` with none), the title count. No notification, timer or default ever answers.

## Shared parts and known seams

- `projectLines` is the one place that decides which projects exist, their order, folds and pins; the sidebar and the Board both read it. A change to grouping goes there.
- `board()` is pulled once per `revision()` from the Rust engine; the sidebar text, the title, the chips and `mod+j` therefore agree. Never count in TSX.
- `lib/dock.ts` and `answer-dock.tsx` own the answer rules; Board bulk answer reuses them. A fix to one is a bug in the other until checked.
- Known seams to check in any review: the answer dock still also mounts in the inbox and triage in places (`design/board.md` says so); `design/attention.md` and `design/board.md` still describe pieces already cut over or not yet built; leftover 36 pt controls (list in `AGENTS.md`); two neutrals (warm sidebar, blue-grey strips); a check glyph meaning both connected and done.
