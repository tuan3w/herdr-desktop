# The pane tab

`components/pane-tab.tsx` (`PaneTab`) and its parts: `pane-header.tsx`, `pane-find.tsx`, `capture-bar.tsx`, `composer.tsx`, `slash-list.tsx`, `key-row.tsx`, `links-dialog.tsx`. The rules live in `lib/pane-input.ts`, `lib/slash.ts` and `lib/phrases.ts` (pure, with tests); what is learned is kept by `lib/pane-memory.ts`. `pane-tab.test.tsx` drives it through `pane-lab.tsx` against the scripted herdr.

## What it is

A **mirror**: herdr gives the app the rows of the pane and takes text and key names back; there is no cursor and no mouse. Top to bottom: `PaneHeader`, a notice when the machine is not connected (the text is the last it showed, typing is off), `PaneFind` while open, the `PaneScreen`, the hint line `Mirror: type with Mirror mode or the composer` (or the capture bar), `AnswerDock` while the agent asks something, `Composer`, `KeyRow`. A pane herdr no longer has shows `This agent is gone` and nothing to type into.

## Typing: three ways, one rule each

- **Composer** (`Composer`). Enter sends `Herdr.sendInput(text, ["enter"])` as one request; Shift+Enter is a new line; Enter on an empty box does nothing. While the dock shows, an *empty* Enter says `Pick an answer above` (Enter would pick whatever the agent has highlighted); typed text still goes, because a free-text reply is an answer. Text survives a failed send: it comes back in front of anything typed since, with the reason. `focusComposer()` is the `Reply…` hand-off.
- **Key row** (`KeyRow`, `keysFor`). One press each through `Herdr.sendKeys`; `/`, `@`, `~`, `-`, `|` go into the composer instead (a `/` starts the command list). An agent gets Space, Shift+Tab and `@`; a shell gets Ctrl+D and the symbols. `Stop` in the header (only while the agent works) is Escape.
- **Capture mode** (`CaptureBar`, `mod+shift+k`, `toggleCapture`). Text arrives in a field that is never cleared (so it only grows; what is new is what was typed) and goes through `Herdr.sendText`; every key that is not text goes through `Herdr.sendKeys` under `PaneKeys.herdrKey`. All sends run one at a time in the order typed: the engine runs calls on separate threads, and `ls` fired together reached the pane as `sl`. Paste is `sendText` of the pasted text.

## Capture mode is a documented trap, with four ways out

Agents need Escape and Tab, so they are the pane's and capture mode traps the keyboard on purpose. The bar says so (`Typing into <agent> · Ctrl+Shift+K to leave`, the keys from `keyLabel`, announced on entry and on leaving). Ways out: the `capture` shortcut (never forwarded); the `Leave` button; moving the keyboard focus anywhere else (otherwise typing would stop reaching the field while the bound keys still reached the pane); the tab stopping being in front, or its machine going away. It never starts, and its keys are not bound, while a dialog is open (`dialogDepth`).

`captureKeystrokes` is the list it binds. Left out, deliberately: every app shortcut (on Windows and Linux `mod` is Ctrl, so Ctrl+K, J, N, F, W, B and Z stay the app's even here), `ctrl+v` there (paste), and what the host refuses to bind (F11, Ctrl+Q; probed once per key with `keymap.bind`, because one refused key refuses the whole set). On Apple platforms every Ctrl+letter is the pane's.

## Slash commands and quick phrases

Ported from herdr-mobile (`slash_catalog`, `slash_usage`, `command_model`, `quick_phrases`, `sent_phrases`) with its tests.

- Typing `/word` (or `$word`) at the start of an agent's box lists commands (`matchCommands`): pinned first, then the five latest sent, then the table; for a word, names that start with it, names that hold it, descriptions, each by source then use. Up and Down move, Enter or Tab pick (a pick fills `/command ` and never sends), Escape hides the list until the next edit. Pins are a button as well as a key. A command typed in full lists nothing.
- `unknownCommand` holds a `/word` the agent does not list **once**: `Send as message` sends it as typed and does not remember it (remembering it would make the typo known). `clear new help exit quit` are never held. Built-in tables are best effort (`BUILT_IN`); omp and pi have none and list what was pinned or sent. Commands that are files on the machine (project and user commands, skills) are not listed: the engine has no file read yet.
- Quick phrases (`quickChips`) sit above the *empty* box and fill it, never send. A message sent to an **agent** at least twice joins them (`learnKey` refuses a `/command`, an address, a line of 24 or more unbroken characters, several lines); nothing typed into a shell is learned. They are the setting `quickPhrases`; the memory is `phrases.v1` and `slash.v1` in the Rust settings file.

## Links, find, options

- A link pressed in the mirror, or chosen in `LinksDialog` (palette entry `Links in this pane…`, Enter on a row), goes through `openLink` and `routeLink`: a file path opens in the file viewer (a folder in the browser), found in the pane's folder and the two above it on the pane's machine; a web address opens in the browser (`http` and `https` only); a page on a remote machine's own `localhost` opens in `WebPage` through a tunnel; anything else is copied. `design/files.md` has the rest. Files dropped on the tab are offered to the machine's folder (`SendFiles`), and `Browse files` in the header opens the pane's folder.
- `PaneFind` (`mod+f`) reads the mirror's rows (`PaneScreenRef.rows`) at every query and step, so output that arrived meanwhile is found. Enter next, Shift+Enter previous, Escape closes; it starts at the last match and says `2 of 5` politely. `matchRows` ignores case, diacritics and invisible characters.
- `Pane options`: layout (`Fit width`, `Actual size`, `Wrap lines`: the setting `paneFit`, the person's choice, not the pane's), find, links, `Duplicate` (an agent starts again in the same folder in a new tab of the workspace, a shell gets a new tab in its folder; the host's `onOpenPane` shows it), `Copy title`, `Copy pane id`.

## Not verifiable without a display

Key delivery and focus on real GTK (`autoFocus` of the capture field, the blur that ends the mode, Shift+Enter as a new line: the headless keyboard sends Shift+Enter as Enter), the look of the list, bar and key row, and the announcements (`announce` cannot be read by a test).
