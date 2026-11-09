# The terminal tab

`components/terminal-tab.tsx` (`TerminalTab`) with `terminal-header.tsx`. The program it runs is composed in `lib/terminal-command.ts` (pure, a table of shapes and refusals in its test); the rules for which view opens an agent are `lib/open-agent.ts`. What the widget is and how its keys work is `docs/specs/terminal.md`. The chat's own tab is `design/chat.md`.

**Off by default for now** (owner decision, 2026-11-08): with a terminal tab open, switching to the Board could send nsh's reactive runtime into a loop (`docs/STATUS.md`). The setting `terminalEnabled` (Settings, Look, `Terminal tab (experimental)`) turns it on; the terminal's own rows there are disabled with `Turn on the terminal tab first` while it is off. Off: no header has `Terminal`, `mod+shift+m` only says the tab is off (the shortcuts sheet leaves it out, `listedShortcuts`), the palette has no `Show terminal`, a split never picks a terminal as companion, and an agent that can be read as a chat always opens it. An agent that cannot still opens its terminal tab, which mounts no `Terminal` and none of its effects (`TerminalOff`, `components/terminal-off.tsx`): the agent's name, one line `This agent has no chat here. Open it in your terminal:`, the exact command (`herdr`, `herdr --session …`) as selectable mono text with `Copy`, and `Turn on the terminal tab`; a tab of an agent that has a chat (restored from a layout) also offers `Show chat`. A tab opened or restored while off is never armed, so turning the setting on shows `Press Return to reconnect`. Everything below is the tab while on.

## What it is

A real terminal: a pty running herdr's own client, drawn by `Terminal`, with the whole keyboard and mouse. It is the way to **work in** an agent; the chat is the way to **supervise** it. An agent that omp, Claude Code or Codex runs opens as its chat, with the terminal one press away; a shell, or an agent whose log cannot be found, opens as the terminal. The tab's title is `<agent> (terminal)`.

Top to bottom: the header (`TerminalHeader`, one `TopBar` line like a chat's), a notice when the machine is not connected, the terminal, one muted hint line. The header names the agent (only while no tab strip says it) and its machine and folder, carries no state mark (the sidebar row says it once), and carries `Chat` (only when the agent has a chat; `mod+shift+m`), `Browse files` and `Pane options` (`Duplicate`, `Copy title`, `Copy pane id`). No `Stop`, no `Send`, no message box and no answer dock: typing goes to the program, Ctrl+C is the person's, and the app sends nothing the person did not type. A pane herdr no longer has shows `This agent is gone`.

## Rules

- **Chat and Terminal are one switch.** `Terminal` in a chat and `Chat` here swap the tab for the other view of the same pane (`showTerminal`, `showChat`), keep the choice for this run only, and say it once politely. A restart opens the chat again.
- **Starting is the person's act.** The tab starts its program only when the person opened it in this run (`isArmed`). A tab restored from the saved layout says `Press Return to reconnect` and attaches on Return or `Reconnect`: a restart must never put a client into a live agent unasked. Return counts only while no text field is being edited.
- **Pointing, then attaching.** The client opens on the session, not on one pane, so the tab first focuses the pane and zooms it through the public API (so the client shows that pane alone), then attaches. Closing the tab puts back a zoom the tab made, and hangs the program up.
- **The way out of a terminal.** `mod+p` is a program's key on Windows and Linux, so the palette also answers `mod+shift+l`; the hint line names the chord that works. It is said once on entry and in the hint line, nowhere else.
- **A program that ends** says so with its status and offers `Restart`.
- Links the program prints open through `openLink`. Files dropped on the tab are offered to the machine's folder (`SendFiles`) and sent only after the person confirms.

## Not verifiable without a display

Key delivery and focus on real GTK or AppKit, the look of the header and the hint, and the announcements (`announce` cannot be read by a test).
