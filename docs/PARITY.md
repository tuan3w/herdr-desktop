# Parity with herdr-mobile

One row per mobile feature (`herdr-mobile/docs/GUIDE.md` sections 3-9 and `docs/screens/`). Status: `planned` (phase in `where`), `done`, `changed` (done, different on desktop on purpose, reason given), `not applicable` (cannot exist on a desktop, reason given). Every row must be `done`, `changed` or `not applicable` before the first release. When a row changes status, fill `where` and `test` in the same change.

| feature | mobile source | status | where | test |
|---|---|---|---|---|
| Machines list with link state, enable, edit, remove | GUIDE 3 | planned | phase 4.8 | |
| Add machine over ssh with `Test connection` | GUIDE 3 | changed: system `ssh` (config aliases, agent, ProxyJump) replaces pasted keys, passwords and key generation | phase 4.8 | |
| Host key trust on first use, changed key stops the machine | GUIDE 3 | changed: ssh's own `known_hosts`; the app shows the classified fatal text | phase 2.4, 5.1 | |
| Tailscale SSH machine | GUIDE 3 | changed: works through `ssh` when Tailscale SSH is configured | phase 5.1 | |
| Named herdr session per machine | GUIDE 3 | planned | phase 2.4 | |
| Worktrees grouped under their repo, start agent in a checkout | GUIDE 3 | planned | phase 4.2 | |
| Board sections `Needs you`, `To review`, `Working`, `Idle` | GUIDE 4 | planned | phase 2.6, 4.4 | |
| One count for status line, title, triage and notifications | GUIDE 4 | planned | phase 2.6 | |
| Idle fold (`22 more idle`) | GUIDE 4 | planned | phase 4.4 | |
| Dating a state change when first seen | GUIDE 4 | planned | phase 2.6 | |
| Agent naming (pane label, title, omp session log) | GUIDE 4 | planned | phase 2.6, 6.5 | |
| Offline machines dimmed and not counted | GUIDE 4, 9 | planned | phase 2.6 | |
| `Answer one by one` triage | GUIDE 4 | planned | phase 4.4 | |
| Reviewed mark with `Undo` | GUIDE 4 | planned | phase 4.4 | |
| Multi-select with `Reviewed`, `Stop`, `Message`, `Close` and live confirm | GUIDE 4 | planned | phase 4.7 | |
| Pull to refresh | GUIDE 4 | not applicable: links reconnect automatically | | |
| One-tap answers with the command shown | GUIDE 5 | planned | phase 2.7, 4.5 | |
| Hold for risky answers | GUIDE 5 | changed: two-step activation, because timed holds are not accessible | phase 4.5 | |
| Ignore taps on a changed or new answer for 0.4 s | GUIDE 5 | planned | phase 4.5 | |
| Re-read and compare before sending (`The question changed`) | GUIDE 5 | planned | phase 3.2, 4.5 | |
| Agent session permission dock (long command, `Read all`, `Cancel request`, queue) | GUIDE 5 | planned | phase 6.4 | |
| Swipe between agents | GUIDE 6 | changed: `mod+j` / `mod+shift+j` | phase 1.4 | |
| Title switcher between agents | GUIDE 6 | changed: sidebar and palette | phase 4.2 | |
| Terminal pane mirror, `Fit width`, `Wrap lines` | GUIDE 6 | planned | phase 3.4 | |
| Composer, Shift+Enter for a new line | GUIDE 6 | planned | phase 3.6 | |
| Key row, `Ctrl`/`Alt` modifiers | GUIDE 6 | changed: real keyboard, key row kept for esc, arrows, Tab, Ctrl+C | phase 4.6 | |
| Typing into the pane | GUIDE 6 | changed: capture mode (`mod+shift+k`) | phase 3.6 | |
| Slash palette | GUIDE 6 | planned | phase 4.6 | |
| Quick phrases | GUIDE 6 | planned | phase 4.6 | |
| Dictation | GUIDE 6 | not applicable: nsh `Speech.start` exists only on macOS and iOS | | |
| Links in output (URLs and file paths) | GUIDE 6 | planned | phase 2.8, 4.6 | |
| `New output` pill | GUIDE 6 | planned | phase 3.4 | |
| Start, rename, close workspaces, tabs, panes | GUIDE 3, 6 | planned | phase 3.2, 4.6 | |
| Agent sessions (ACP): start, chat transcript, tools, diffs, plans | GUIDE 6 | planned | phase 6 | |
| Questions and elicitation forms in a session | GUIDE 6 | planned | phase 6.4 | |
| Message queue, attachments, session settings, `Past sessions` | GUIDE 6 | planned | phase 6.4 | |
| Subagents list | GUIDE 6 | planned | phase 6.4 | |
| Session replay after restart | GUIDE 6 | planned | phase 6.3 | |
| `Show chat` / `Show terminal` for observed omp, Claude Code, Codex | GUIDE 6 | planned | phase 6.5 | |
| Files: browse, view text, images, markdown, binary | GUIDE 7 | planned | phase 7.1 | |
| Send a file to the machine | GUIDE 7 | changed: drag and drop onto the pane tab | phase 7.1 | |
| Pages from a machine in a web view | docs/screens/web.md | planned | phase 7.2 | |
| Mermaid diagrams, photo viewer | docs/screens/markdown.md, photos.md | planned | phase 7.3 | |
| Notifications when an agent needs you, with safe action buttons | GUIDE 8, docs/ALERTS.md | planned | phase 5.2 | |
| Android foreground service, Doze, battery profiles | GUIDE 8 | not applicable: no battery or process-killing constraints; only a hidden-window slow profile | | |
| Stale/offline states, `Retry`, error messages | GUIDE 9 | planned | phase 2.3, 5.1 | |
| APK updater | GUIDE 2 | changed: release check with `Open release page` | phase 9.2 | |
| Haptics | docs/DESIGN.md | not applicable: no haptics on a desktop | | |
| Tray icon | (desktop only) | not applicable: not in nsh 0.4.0; deferred until a release has it | | |
