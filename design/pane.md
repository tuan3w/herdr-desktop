# The pane tab

`components/pane-tab.tsx` (`PaneTab`) and its parts: `pane-header.tsx`, `pane-find.tsx`, `composer.tsx`, `links-dialog.tsx`. The rules live in `lib/pane-input.ts` (pure, with tests). `pane-tab.test.tsx` drives it through `pane-lab.tsx` against the scripted herdr. The chat's slash commands are `lib/slash.ts` and `lib/pane-memory.ts` (`design/chat.md`).

## Decided, not built yet

Owner decision 2026-11-07, from a prototype (unverified in the app):

- **One header line.** It names the agent and carries its actions; it shows no state word and no glyph, because the agent's state is the mark on its sidebar row and, while it works, one muted live line in the conversation saying what it is doing now (`design/attention.md`). Why: a working agent was drawn eight times (tab, header glyph, header word, sidebar glyph, meta line, group count, status bar, turn footer).
- **The answer dock replaces the composer** while the agent asks something, in the same place, so the question and the reply box are never both open (`design/board.md`).
- **Facts about the agent move to the inspector** (where it runs, branch, context used, changes, files, subagents, terminal), not text buttons that open dialogs. Subagents and background jobs are inspector content: a sticky panel over the conversation took about 40% of the height with the tab strip and header.
- **One left edge.** Header, conversation and composer share a gutter; the conversation keeps a readable measure (about 720 pt) and extra width goes to the inspector.
- **The composer is one line tall until the text needs more**, shows an attachment once (a thumbnail, with no `[Image #n]` text beside it), and keeps its help line inside the box.

Today's code is the layout below.

## What it is

A **read-only view**: herdr gives the app the rows of the pane and takes text and key names back; there is no cursor and no mouse, so it cannot be a terminal and does not pretend to be one. The tab says so: its title is `<agent> (view)` and the header says `Read-only view`. Top to bottom (today): `PaneHeader`, a notice when the machine is not connected (the text is the last it showed, sending is off), `PaneFind` while open, the `PaneScreen`, `AnswerDock` while the agent asks something, `Composer`. A pane herdr no longer has shows `This agent is gone` and nothing to send to.

The pane's columns fill the width (`PaneScreen` scales the font from `paneFontSize` down to 9 pt, then the view scrolls sideways); the person has no layout choice. There are no key buttons, no typing mode and no command list in this tab: a keyboard belongs in a real terminal, which this app does not have yet (`docs/specs/terminal.md` decides what it will be: libghostty-vt, a prototype behind `HERDR_DESKTOP_TERMINAL=1`).

## What a person does here

- **Answer** a question the agent asks with the `AnswerDock` chips (`design/board.md` for the safety rules).
- **Stop** the agent (header, only while it works): `Herdr.sendKeys` of Escape.
- **Say something** in the `Composer`, the one way to steer a terminal agent in a view with no keyboard of its own. Enter sends `Herdr.sendInput(text, ["enter"])` as one request; Shift+Enter is a new line; Enter on an empty box does nothing. While the dock shows, an *empty* Enter says `Pick an answer above` (Enter would pick whatever the agent has highlighted); typed text still goes, because a free-text reply is an answer. Text survives a failed send: it comes back in front of anything typed since, with the reason. A `/command` is plain text here. `focusComposer()` is the `Reply…` hand-off. A shell pane's box says `Send a line to <name>`.
- **Look**: scroll, select, follow the end; `New output` pill when scrolled away.

## Links, find, options

- A link pressed in the view, or chosen in `LinksDialog` (palette entry `Links in this pane…`, Enter on a row), goes through `openLink` and `routeLink`: a file path opens in the file viewer (a folder in the browser), found in the pane's folder and the two above it on the pane's machine; a web address opens in the browser (`http` and `https` only); a page on a remote machine's own `localhost` opens in `WebPage` through a tunnel; anything else is copied. `design/files.md` has the rest. Files dropped on the tab are offered to the machine's folder (`SendFiles`), and `Browse files` in the header opens the pane's folder.
- `PaneFind` (`mod+f`) reads the view's rows (`PaneScreenRef.rows`) at every query and step, so output that arrived meanwhile is found. Enter next, Shift+Enter previous, Escape closes; it starts at the last match and says `2 of 5` politely. `matchRows` ignores case, diacritics and invisible characters.
- `Pane options`: find, links, `Duplicate` (an agent starts again in the same folder in a new tab of the workspace, a shell gets a new tab in its folder; the host's `onOpenPane` shows it), `Copy title`, `Copy pane id`.

## Gone on purpose

The key row (Esc, arrows, Ctrl+C), capture mode with its hint bar and `mod+shift+k`, the slash palette and quick phrases of the pane's box, `Wrap lines` and `Fit width`/`Actual size`. They were the phone's answer to having no keyboard; with a full keyboard they were clutter and a trap (capture mode took Escape and Ctrl+K from the person). Old settings (`paneFit`, `quickPhrases`) are ignored when read and absent from the next save.

## Not verifiable without a display

Key delivery and focus on real GTK (Shift+Enter as a new line: the headless keyboard sends Shift+Enter as Enter), the look of the header and box, and the announcements (`announce` cannot be read by a test).
