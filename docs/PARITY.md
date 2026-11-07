# Parity with herdr-mobile

One row per mobile feature (`herdr-mobile/docs/GUIDE.md` sections 3-9 and `docs/screens/`). Status: `planned` (phase in `where`), `done`, `changed` (done, different on desktop on purpose, reason given), `not applicable` (cannot exist on a desktop, reason given). Every row must be `done`, `changed` or `not applicable` before the first release. When a row changes status, fill `where` and `test` in the same change.

| feature | mobile source | status | where | test |
|---|---|---|---|---|
| Machines list with link state, enable, edit, remove | GUIDE 3 | done | `components/machines.tsx` | `components/machines.test.tsx` |
| Add machine over ssh with `Test connection` | GUIDE 3 | changed: system `ssh` (config aliases, agent, ProxyJump) replaces pasted keys, passwords and key generation | `components/machine-form.tsx` | `components/machines.test.tsx`, `lib/machine-rules.test.ts` |
| Host key trust on first use, changed key stops the machine | GUIDE 3 | changed: ssh's own `known_hosts`; the app shows the classified fatal text | phase 2.4, 5.1 | |
| Tailscale SSH machine | GUIDE 3 | changed: works through `ssh` when Tailscale SSH is configured | phase 5.1 | |
| Named herdr session per machine | GUIDE 3 | done | `components/machine-form.tsx`, core `ssh` | `lib/machine-rules.test.ts` |
| Worktrees grouped under their repo, start agent in a checkout | GUIDE 3 | done | `native/core/src/project.rs`, `components/board.tsx`, `components/sidebar.tsx` | `native/core/tests/board.rs`, `components/board.test.tsx` |
| Board sections `Needs you`, `To review`, `Working`, `Idle` | GUIDE 4 | done | `native/core/src/board.rs`, `components/board.tsx` | `native/core/tests/board.rs`, `components/board.test.tsx` |
| One count for status line, title, triage and notifications | GUIDE 4 | done | `native/core/src/board.rs` `Counts`, `native/app/src/engine/words.rs` | `native/core/tests/board.rs`, `components/board.test.tsx` |
| Idle fold (`22 more idle`) | GUIDE 4 | done | `lib/board-items.ts`, `BoardData.idleRest` | `components/board.test.tsx` |
| Dating a state change when first seen | GUIDE 4 | done | `native/core/src/board.rs` `FirstSeen` | `native/core/tests/board.rs` |
| Agent naming (pane label, title, omp session log) | GUIDE 4 | done | `native/core/src/board.rs`, `native/core/src/observed/names.rs` | `native/core/tests/board.rs`, `native/app/tests/observed.rs` |
| Offline machines dimmed and not counted | GUIDE 4, 9 | done | `native/core/src/board.rs`, `components/board-card.tsx` | `native/core/tests/board.rs` |
| `Answer one by one` triage | GUIDE 4 | changed: the dock answers in the agent's own tab and offers `Next`; no second list | `components/answer-dock.tsx` | `components/answer-dock.test.tsx` |
| Reviewed mark with `Undo` | GUIDE 4 | done | `lib/herdr.ts` `reviewWithUndo` | `components/board.test.tsx` |
| Multi-select with `Reviewed`, `Stop`, `Message`, `Close` and live confirm | GUIDE 4 | done | `lib/selection.ts`, `components/bulk-bar.tsx`, `lib/bulk.ts` | `components/bulk.test.tsx`, `lib/bulk.test.ts` |
| Pull to refresh | GUIDE 4 | not applicable: links reconnect automatically |  |  |
| One-tap answers with the command shown | GUIDE 5 | done | `native/core/src/prompt`, `components/answer-dock.tsx` | `native/core/tests/prompt.rs`, `components/answer-dock.test.tsx` |
| Hold for risky answers | GUIDE 5 | changed: two-step activation, because timed holds are not accessible | `components/answer-dock.tsx` | `components/answer-dock.test.tsx` |
| Ignore taps on a changed or new answer for 0.4 s | GUIDE 5 | done | `components/answer-dock.tsx` | `components/answer-dock.test.tsx` |
| Re-read and compare before sending (`The question changed`) | GUIDE 5 | done | `native/app/src/engine/answer.rs`, `components/answer-dock.tsx` | `native/app/tests/engine.rs`, `components/answer-dock.test.tsx` |
| Agent session permission dock (long command, `Read all`, `Cancel request`, queue) | GUIDE 5 | done | `components/answer-dock.tsx` | `components/answer-dock.test.tsx` |
| Swipe between agents | GUIDE 6 | changed: `mod+j` / `mod+shift+j` | `lib/actions.ts` `nextAttention` | `App.test.tsx` |
| Title switcher between agents | GUIDE 6 | changed: sidebar and palette | `components/sidebar.tsx`, palette | `components/sidebar.test.tsx` |
| Terminal pane mirror, `Fit width`, `Wrap lines` | GUIDE 6 | done | `native/app/src/pane_screen.rs`, `components/pane-header.tsx` | `native/app/src/pane_screen`, `components/pane-tab.test.tsx` |
| Composer, Shift+Enter for a new line | GUIDE 6 | done | `components/composer.tsx` | `components/pane-tab.test.tsx` |
| Key row, `Ctrl`/`Alt` modifiers | GUIDE 6 | changed: real keyboard, key row kept for esc, arrows, Tab, Ctrl+C | `components/key-row.tsx` | `components/pane-tab.test.tsx` |
| Typing into the pane | GUIDE 6 | changed: capture mode (`mod+shift+k`) | `lib/pane-input.ts`, `components/capture-bar.tsx` | `components/pane-tab.test.tsx` |
| Slash palette | GUIDE 6 | done | `lib/slash.ts` | `lib/slash.test.ts`, `components/pane-tab.test.tsx` |
| Quick phrases | GUIDE 6 | done | `lib/phrases.ts`, `lib/pane-memory.ts` | `lib/phrases.test.ts` |
| Dictation | GUIDE 6 | not applicable: nsh `Speech.start` exists only on macOS and iOS | | |
| Links in output (URLs and file paths) | GUIDE 6 | done | `native/core/src/screen/links.rs`, `components/links-dialog.tsx` | `native/core/tests/screen.rs`, `components/pane-tab.test.tsx` |
| `New output` pill | GUIDE 6 | done | `native/app/src/pane_screen/follow.rs` | `native/app/src/pane_screen` |
| Start, rename, close workspaces, tabs, panes | GUIDE 3, 6 | done | `lib/actions.ts`, `components/name-dialog.tsx`, `components/start-agent.tsx` | `App.test.tsx`, `components/name-dialog.test.tsx`, `components/start-agent.test.tsx` |
| Agent sessions (ACP): start, chat transcript, tools, diffs, plans | GUIDE 6 | done | `native/core/src/session/`, `components/session-tab.tsx`, `components/new-session.tsx` | `native/core/tests/session.rs`, `components/session-tab.test.tsx`, `docs/ACP.md` |
| Questions and elicitation forms in a session | GUIDE 6 | done | `components/session-question.tsx` | `components/session-question.test.tsx` |
| Message queue, attachments, session settings, `Past sessions` | GUIDE 6 | done | `components/session-tab.tsx`, `components/session-overview.tsx`, `components/past-sessions.tsx` | `components/session-tab.test.tsx`, `components/session-overview.test.tsx`, `components/past-sessions.test.tsx` |
| Subagents list | GUIDE 6 | done | `components/session-item.tsx`, `native/core/src/observed/` | `components/session-tab.test.tsx` |
| Session replay after restart | GUIDE 6 | done | `native/core/src/session/thread.rs` | `native/core/tests/session.rs` |
| `Show chat` / `Show terminal` for observed omp, Claude Code, Codex | GUIDE 6 | done | `native/core/src/observed/`, `lib/open-agent.ts` | `native/app/tests/observed.rs`, `components/workspace.test.tsx` |
| Files: browse, view text, images, markdown, binary | GUIDE 7 | done | `native/core/src/files/`, `components/files.tsx`, `components/file-viewer.tsx` | `native/core/tests/files.rs`, `components/files.test.tsx` |
| Send a file to the machine | GUIDE 7 | changed: drag and drop onto the pane tab | phase 7.1 | |
| Pages from a machine in a web view | docs/screens/web.md | done | `components/web-page.tsx`, `native/app/src/files.rs` | `native/core/tests/files.rs` |
| Mermaid diagrams, photo viewer | docs/screens/markdown.md, photos.md | done | `components/mermaid-block.tsx`, `components/photo-viewer.tsx` | `lib/mermaid.test.ts`, `components/files.test.tsx` |
| Notifications when an agent needs you, with safe action buttons | GUIDE 8, docs/ALERTS.md | done | `native/app/src/notify/` | `native/app/tests/notify.rs`, `native/app/tests/notify_dbus.rs` |
| Android foreground service, Doze, battery profiles | GUIDE 8 | not applicable: no battery or process-killing constraints; only a hidden-window slow profile | | |
| Stale/offline states, `Retry`, error messages | GUIDE 9 | done | `native/core/src/link/`, `components/machines.tsx` | `native/core/tests/link.rs`, `components/machines.test.tsx` |
| APK updater | GUIDE 2 | changed: release check with `Open release page` | `lib/updates.ts`, `components/settings.tsx` | `components/updates.test.tsx`, `lib/updates.test.ts` |
| Haptics | docs/DESIGN.md | not applicable: no haptics on a desktop | | |
| Tray icon | (desktop only) | not applicable: not in nsh 0.4.0; deferred until a release has it | | |
| Pane header with `Wrap lines`, `Fit width`, `Duplicate`, `Copy title`, `Copy pane id` | GUIDE 6 | done | `components/pane-header.tsx` | `components/pane-tab.test.tsx` |
| `Stop` (sends Esc) | GUIDE 6 | done | `components/pane-header.tsx` | `components/pane-tab.test.tsx` |
| Find in the pane (`mod+f`) | (desktop only) | done | `components/pane-find.tsx` | `components/pane-tab.test.tsx` |
| Command palette for every action | (desktop only) | done | `components/palette.tsx`, `lib/actions.ts` | `components/palette.test.tsx`, `App.test.tsx` |
| Keyboard shortcuts, application menu | (desktop only) | done | `lib/shortcuts.ts`, `lib/actions.ts` | `App.test.tsx`, `lib/shortcuts.test.ts` |
| Dock with splits and a saved layout | (desktop only) | done | `components/workspace.tsx`, `lib/dock.ts` | `components/workspace.test.tsx`, `lib/dock.test.ts` |
| Native chat as the main way to work, project-grouped home | (owner decision) | done | `components/session-tab.tsx`, `components/board.tsx` | `components/session-tab.test.tsx`, `components/board.test.tsx` |
| ACP sign-in card | (desktop only) | done | `components/session-signin.tsx` | `components/session-tab.test.tsx` |
