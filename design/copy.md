# Copy

Copying text is essential here: a command to run, a path, an error to send, what an agent wrote. The rule is that **every place text appears can be taken from**, with the keys a person already knows, and with an explicit action where a drag is the wrong tool. This file says how, what was found when it was probed in a real window, and what to do when a new surface shows text.

## How text is taken

| Way | What it does | Where it works |
|---|---|---|
| Drag, double click (word), triple click (paragraph), Shift+click | selects; a finished drag also fills the primary selection (middle click pastes it on Linux) | every selectable surface (below) |
| `Ctrl+C` or `Ctrl+Insert` (`Cmd+C` on macOS), `Ctrl+A` | the host copies / selects all of the selection's area; with no selection nothing is copied and nothing is said | the same |
| A copy action (`Copy message`, `Copy code`, `Copy path`) | `copyText`: puts text on the clipboard, a toast `<what> copied` that is announced politely, an error toast with the reason when the clipboard refuses | buttons, menus, palette |
| Right click | `copyMenu`: a menu of explicit copies for the thing under the pointer; none needs a selection | messages, code, diffs, tabs, sidebar rows, the terminal |

Copied text is plain text. Line numbers, signs and gutters are `userSelect: "none"` and never in it; a tab is a tab (`TAB_STOP`), trailing spaces are the file's own; no zero-width or private-use characters (`safeCode` turns direction overrides and control characters into visible `‹U+202E›` marks before they are drawn, and what is drawn is what is copied). `Copy message` is the words without the Markdown that drew them (`plainText`: a table is tab-separated rows), `Copy as Markdown` the source.

## What is selectable

A surface is selectable when its texts carry `userSelect: "text"` (or it is a `View selectable`, which makes one selection run across its texts, cells and code blocks). Three kinds of surface:

- **Areas**: `MarkdownText` (a chat message, a thought, a Markdown file), a `CodeBlock` or `DiffBlock` (`CodeView` and `CodeDiff` make each plain column of rows an area of its own, as their virtual lists already were: without it every line selected alone and a drag across a command copied its first line), `PaneScreen` (its rows are a virtual list that is an area; a selection survives the output of a working agent).
- **Single texts**: a user message, the answer dock's command, a question, a setting's label and description, an error under a field, a toast, an empty state's hint. A drag stays inside the text.
- **Controls** (buttons, tabs, rows that press) are not selectable: they have `Copy …` in a right-click menu instead (`Copy title`, `Copy path`, `Copy name`, `Copy folder`).

A folded line in the chat (`Read 8 files, ran 4 commands`) is a control: it is not selectable, and its steps carry their own copy when opened. A path or count that links into the inspector is a control too, with `Copy path` in its right-click menu. Why: the fold's text is a summary the app wrote, not words the agent said, so there is nothing true to take from it. Link and inspector are decided, not built yet.

New text that a person may want to take gets `userSelect: "text"`; a block of rows becomes one area; a control gets a copy action. A reason not to goes next to the code.

## What a real window showed

Probed with real pointer and key events (`scripts/copy_probe.py`: XTEST on Xvfb, the clipboard read back from the X server), not with the headless harness, which simulates a drag in the engine and reads a seam:

- Drag, double click, triple click, `Ctrl+A` and `Ctrl+C` worked in the chat, tool output, the terminal mirror and the file viewers. They did **not** across lines in a plain `CodeView` column (the permission dock's command, any block that fits its height) or in a `CodeDiff`: only the first line was copied. Fixed by making the column an area.
- A tab was copied as spaces (the viewer expanded it to four columns), so a Makefile or Go source pasted with its indentation broken. A tab is now kept and drawn at stops of eight columns, as a terminal does; the tab size option is gone.
- The host draws **no** context menu for selectable text on GTK, and a native menu (`Menu.popup`, also the window's `Edit` menu) takes the keyboard focus, which ends the selection before `Copy` runs: `Edit > Copy` by mouse copied nothing. So the right-click menu offers only copies that need no selection, and the keys act on the selection itself.
- The host has no way to hand the selected text to the app, so a button cannot copy "the selection" either; `Copy message`, `Copy code` and `Copy all output` copy the thing they name.

## Tests

- `lib/plain-text.test.ts`, `components/session-tab.test.tsx` (`Copy message`, `Copy as Markdown`), `components/code-block.test.tsx` (the menus), the sidebar and tabs tests: the copy actions put the right text on `app.clipboard()`.
- `make copy` runs the XTEST probe. Each case drags, clicks or presses keys and compares what the clipboard holds with what a person would expect, gutters and signs absent, tabs kept, nothing copied without a selection, a selection kept while the screen changes.
- Not covered: Wayland (this host has a headless mutter, `gnome-shell --headless --wayland`, whose RemoteDesktop D-Bus interface can inject input and read the clipboard, but a probe built on it was not made reliable: a virtual monitor of another size than 1280x800 made the shell drop its RemoteDesktop service, and the first key sent to a fresh window was lost), macOS (the host's `Cmd+C` is its own and was not run), a screen reader's copy, an input method.
