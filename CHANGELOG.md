# Changelog

What changed for the person using Herdr Desktop, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `docs/RELEASING.md` (0.1.x, patch bumps). The section of a version is its release notes: write it for the person, not for the commit log, in the format of `.agents/skills/herdr-changelog/SKILL.md` (pictures are assets of the release, never files in git).

## [Unreleased]

- **The terminal tab is off for now** (Settings, Look, `Terminal tab (experimental)`): it could make the app spin. An agent with a chat opens its chat; one without says how to open it in your own terminal, with the command to copy.

- **A long chat scrolls more steadily.** PageUp and PageDown glide a page instead of jumping (they still jump with reduced motion, and a held key still moves a page a press); the scroll bar no longer shrinks and jumps as you scroll through a long conversation; rows already in the conversation no longer rise in as you scroll up to them; and a message scrolled away and back is not worked out again. Measured headless and in a Mac window on a synthetic 420-turn chat; how a trackpad feels on a real display is not checked.

- An agent that needs you is marked in the signal colour on its sidebar row again (and on the Board's row while the Board is in front), so it stands out from the agents that work.

- **Subagents and background work live in a panel beside the chat, and you can read a subagent's conversation.** A chat with an agent in a terminal now has `Activity` at the right (the list button in its header, or `Cmd/Ctrl+Shift+I`): `Running` shows each subagent and background command on one line with how long it has run, `Finished 26 · last 35 min ago` folds the rest, and a subagent or task that fails while you watch shows under `Needs you` and opens the panel by itself. Each row says what it is in a few words (`pnpm test --watch`, not the whole command; the first sentence of a subagent's task, not the whole prompt), and says `running` once, in its section. Press a subagent to read its own conversation, read-only, and `Back` to return; a background command can be stopped with the square (twice within 4 s once it has run a minute), which asks the agent to stop it in the chat. The panel no longer pushes the conversation down, and in a window under 1100 pt it slides over the chat instead of squeezing it. Checked on a Mac in light and dark at 1280 and 960 pt with synthetic data; real agents' subagents, a remote machine, large text and hover are not checked.

- **Buttons, fields and choices hold up with real data.** A disabled button keeps its kind and fades (a disabled `Cancel` no longer turns into a grey filled button) and keeps its shortcut, so it no longer changes width when a form becomes ready; a long label in a narrow place ends in `…` instead of running out of its column. Disabled fields, selects and pickers now look disabled, and read-only ones look read-only. A long path rests on one line ending in `…` in every field; a value the list no longer offers shows as itself instead of looking empty; a number field lines up with the fields beside it; long check box labels wrap beside their box; a segmented control with many or long options stays inside its column; chips with long names stay inside their field; and a long pick list shows half of its next row so you can tell it scrolls. Errors that run to several lines keep their icon on the first line. Checked on a Mac in light and dark at 1280 pt, with Large hit targets, in a lab with synthetic data; large text, hover, the keyboard focus on most controls and the opened select lists are not checked in a picture.

- **Menus, dialogs and toasts hold up with real data.** A menu leaves room for its shortcuts as Linux writes them (`Ctrl Shift N`), so a label beside one is no longer cut, and a short label beside a greyed-out reason is whole; a greyed-out item can say why (`No editor set`); a long menu shows half of its last row so you can tell it scrolls, and a tall menu opens at its final height instead of jumping. Short questions open in a narrower dialog, a dialog with no buttons has no empty band at the bottom, dialog corners match the palette's, and `Create` in a name dialog is pressable when the name is empty and says what is missing. Checked on a Mac in light and dark at 1280 and 760 pt in a lab with synthetic data; real popups near the window's edges, hover and motion are not checked in a picture (the Mac screenshot does not draw popups).

- **Tables, file rows and the folder path hold up with real data.** In a narrow Files tab the current folder's name stays whole (`docs`, not `d`): the search field gives way first, and the path folds its middle folders by the names' real widths. A column that leaves a narrow table no longer leaves a sort arrow behind over the next column. The sort arrow sits beside its column's title, only on the sorted column, and the whole title sorts when pressed. An avatar shows at most two letters on one line, and `?` when it has none. Checked on a Mac in light and dark in a lab with synthetic data and the Files tab at five widths; large text and hover are not checked in a picture.

- **Tabs, settings rows and list headings hold up with real data.** With a few tabs in a narrow window, tabs stay full chips while they still fit (four tabs at 760 pt no longer shrink to tiles), and eight fit at 1280. A tab's dot no longer covers its project's letters, and a tab on an offline machine no longer grows and nudges its title. In Settings, a wide control moves under its label instead of squeezing the label to a letter per line, and a turned-off option fades and says why. Folder headings in Changes show large counts as `10,000`, and a list of tabs that does not fit wraps instead of running out of its frame. Checked on a Mac in light and dark at 1280 and 760 pt in a lab with synthetic data; large text, hover and keyboard focus are not checked in a picture.

- Pasted pictures are smaller: scaled to 1,568 px (what the agents read) and kept around 1 MB, so sending one to a remote machine is quick.

- Zooming a photo is smooth: the wheel zooms continuously toward the pointer, and a large photo no longer lags.

- **Files is a tab, not a dialog, and every list of files looks the same.** `Browse files`, a path pressed in a chat or a tool call, quick open and the palette now open a `Files · folder` tab beside what you were reading, so a question waiting in the chat stays in view. The folder is a breadcrumb that is the path, shown once (press a part to go there, the middle folds into `…`; press the empty room after it or `mod+l` to type a path with completion); under it a table with Name, Size and Modified in aligned columns (digits stack, folders first), sorted by a press on a title or from `Folder options`, with Up, Down, Enter, Backspace and typing to find. A folder you cannot read says so and offers the way out. The attach list and the `@` list use the same rows and the same icons. Checked on a Mac in light and dark at 1280 and 760 pt on a synthetic folder; Escape and the arrow keys inside the viewer, clicking a column title and a right-click menu are not checked (the headless runner cannot press them), and the viewer does not yet grow with the tab.

- A picture pasted for an agent that cannot take pictures just goes: it is saved into the project and named by path when you send, with no warning or extra button.

- **Changes opens on what the agent edited, and is readable in a half-window pane.** Pressing `Edited 7 files` in a chat opens the tab on those seven files (a `This session · 7` / `Everything · 877` switch in the header shows the rest); a run's hundreds of new output files wait in one closed `Not in git` section by folder, and a big new data file says `New file · 1.9 MB · 40,000 lines` with `Open anyway` instead of drawing a huge diff. Below 900 pt the file list folds into one bar above the diff (`‹ 3 of 7 ›`, a `Files` button, `Mark reviewed`, the file named whole), so the diff gets the whole pane and its code scrolls sideways instead of breaking into one-character lines; the header no longer cuts its buttons. `Mark reviewed` moves on to the next file nobody has reviewed and says `All reviewed` at the end; the list can sort the biggest change first. Checked on a Mac in light and dark at 480, 640, 760, 900, 1100 and 1400 pt on a synthetic repository; clicking (the sheet, the switch) is only tested headless, and the fixed line-number gutter while scrolling sideways is not done.

- **The sidebar keeps a readable width.** It can no longer be dragged narrower than 240 pt (it was 220, where `New agent session` touched its keycaps and long names lost their tails); a width saved from the old range is brought into the new one instead of being forgotten, the keycaps are left out under the default width, the sidebar clips what does not fit instead of letting it spill, and the edge line thickens to 2 pt (softer) while you hover or drag it. Checked on a Mac at 240, 264, 340 and 420 pt in light and dark; hovering and dragging the edge are not checked (the Mac test host cannot drag), and a sidebar narrower than its content, as in a report, could not be reproduced.

- **Changed files are grouped by folder, and a file name is always whole.** In Review changes the list shows each folder once as a quiet heading (you can fold it) with its files under it, instead of the path repeated beside every name; two files with the same name are told apart by their folder. The `+N −N` counts keep their own column, and only added, deleted, renamed and new files carry a letter. Checked on a Mac in light and dark with the sample repository; not checked with very long folder paths on screen.

- **Tool calls in the chat are calmer.** A run of calls is one clean hairline box instead of ragged cards, the agent's words between calls are plain text without a quote rule, commands read as what they did (`Ran python3 script`, `Ran grep export in lib`), long ones fade out instead of being cut, and the live `Thinking` line lines up with the rows above it.

- **A message with pictures shows them.** In a chat read from a terminal, the pictures you pasted appear as small thumbnails under your words, in place of the `[Image #55]` text; a click opens one in the lightbox. A picture over 16 MiB says `Picture too large to show`, and one that cannot be read has `Try again`. Checked on a Mac in light and dark; not checked with a real large picture.

- **The file preview beside `@` is calm and level with its list.** It is as tall as the list with its top on the list's top, 8 pt away and never over the message box, with a visible hairline edge; the name and size sit on one muted line and the code below shows whole lines only, no blank area. The command description bubble uses the same surface.

- **Pictures open in a quiet lightbox.** A picture fills the window over a dimmed backdrop with its name and place (`shot-2.png · 2 of 5`) at the top left and a `...` menu and `Close` at the top right: about fifteen controls became three. The menu holds Send to the agent, Copy image, Copy path, Open, Reveal and Rotate; arrows appear at the edges only under the pointer; `Left` and `Right`, `+`, `-`, `0`, `1`, `R`, a double click and the wheel move and zoom it. A picture in a chat opens the same way when you click it.

- **Choosing a folder is a field, not a second dialog.** In `New agent session` and `Send to`, the `Folder` field lists the folders under what you type (`Tab` completes one and lists the next level; `Escape` closes the list first, the dialog next). Empty, it offers your projects on that machine, then recent folders. `Browse folders` is gone. Not checked on a remote machine in a real window.

- **The message box's lists no longer jump.** `/` lists command names only (10 rows at most, `Pin` appears on hover, `Type to filter` in the box); what the highlighted command does, and a file's first lines after `@`, show in a bubble beside the list a moment after you stop moving. The lists hang from the box, the keys are one fixed line, and `+` has `Add files or photos`, `Mention a file` and `Slash commands`. Pictures are larger cards inside the box. Checked on macOS in one render each; the bubbles' edges and the `+` menu do not show in that render, and the Linux render was not taken.

- **Pictures open in the Files viewer again.** A pasted or saved picture showed `This picture cannot be shown` in the installed app; it now draws, SVG and animated GIF included. A picture over 16 MB says `too large to show here` and leaves Open and Reveal to you.

- **A real terminal for every agent.** `Terminal` in a chat (or `Ctrl+Shift+M`, `⇧⌘M`) swaps the conversation for the agent's real terminal: herdr's own client, with the whole keyboard and mouse, selection, copy and paste, Option as Meta and links; `Chat` goes back. A shell, or an agent whose log cannot be read, opens as the terminal. Nothing is ever sent for you, a terminal restored after a restart says `Press Return to reconnect` instead of attaching by itself, closing the tab hangs the program up, and `Ctrl+Shift+L` opens the palette from inside a terminal (Ctrl+P is the program's). Remote machines use `herdr --remote` or `ssh -t`. Checked with scripted programs in the test run; not checked against a real herdr session, a remote machine, or key delivery on Linux.

- **Open a second view beside the chat.** The columns button in a chat's header (and `Ctrl+\`, `⌘\`, or `Open beside` in the palette) puts the agent's Changes next to the conversation, or its terminal when the folder is not a git repository, instead of refusing. `Review changes` now opens beside the chat too, so a question waiting in the chat stays in view while you read the diff. `Open to the side` in a row's or a project's menu opens that agent next to what you are looking at, and the palette has `Merge splits` and `Focus the other group`. In a narrow window the views stay one at a time.

- **Tabs are chips.** The open views of an agent sit as rounded chips on the window's background with a small gap: the front one is a raised white card with its title and icon in full colour, the others a faint tint with muted text. The old rule under the strip, the square separators and the coloured underline are gone, and a title that does not fit fades out instead of ending in dots.

- **One thin focus ring.** Every control shows keyboard focus as one crisp 1.5 pt line in the accent colour that follows its rounded corners exactly: fields, selects and outline buttons turn their own edge into it, other controls and rows draw it right at their edge (inside it in lists and the sidebar), with no gap and no glow. A field with an error keeps its red edge. Buttons, checkboxes and switches show it only when you reached them with the keyboard, not after a click.
- **Shortcuts are drawn one key at a time.** `⌘ ⇧ P` is three same-size keys instead of one box that grew with the text, in the palette, menus, the shortcut list, buttons and tooltips. Every row's keys end on the same right edge, so the column lines up whatever the number of keys, and the palette's age and `needs you` now sit at that edge too.
- **Start an agent in a worktree.** New agent session has a `Checkout` choice once the folder is in a git repository: the folder itself, the repository's other checkouts named by folder and branch, or `New worktree…`, which asks for a branch (a name like `worktree/brave-meadow-45e8` is suggested) and makes the worktree through herdr before the session starts in it. A project's menu has `New worktree…` too, and the sidebar names each checkout of a project by its branch. A branch git would refuse is rejected with the reason and nothing is sent; a repository herdr does not trust is shown as such and never trusted for you. If the session does not start, the new worktree stays chosen so Start again does not make a second.
- **Short file names are no longer washed out.** In the Changes list (and any row that fades a cut name) a name that fits showed a faint box over its last letters; the fade now appears only on text that is really cut.
- **Older messages of a terminal's chat load.** A chat read from a terminal opens at the end of the agent's log and now has `Load earlier messages` at the top (and loads by itself as you scroll up). Older turns appear above the ones you are reading, which stay where they are, and each press reads four times more, up to 64 MB of the log.
- **The Changes review says what you are reviewing.** The top line now reads
  `payments · main · by 2 agents` with `8 files +38 −8 0 of 8 reviewed` at the
  right, and shows the project and branch while git is still reading. The
  file list has a letter for each change (M, A, D, R, U), whole file names with
  the folder fading after them, green and red counts, and one fill for the
  selected file instead of a fill and a bar.
- **Spinners no longer keep the app drawing.** A loading spinner or bar used to hold
  the window at full frame rate and a few percent of CPU for as long as it was
  on screen. Spinners now turn in eighths and a skeleton is still; nothing
  animates while the window is hidden.
- **Sidebar text is cut only when it must be.** A project's machine name is
  shown whole or left out, decided from the text's real width, so it is no
  longer cut to `fatm` while the sidebar has room. Agent titles run to the
  row's edge and the `...` comes over a long title's end on hover, without
  moving the text. The pin is in the project's tooltip, and rows sit
  32 pt apart.
- **A toast appears at the top right.** It used to sit over the message box and the answer dock; now it is under the header, where it covers nothing you are answering, and it enters from above.
- **Tooltips stay inside the window, and menus can show a letter.** A tooltip is never cut off at the window's edge: it lines up with its trigger, flips above when there is no room below, and wraps when the window is narrow. Menu items can carry a one-letter key shown at the right; pressing it while the menu is open does the item.
- **A project in the sidebar is one quiet line.** The name with its chevron right after it folds or unfolds the project; no hover boxes. `+` and `...` appear at the right in space kept for them, so the name never moves or re-truncates. `Open project` is the first entry of `...`.
- **A tool call is one quiet line.** Calls read like `Created package.json +48 ›`: no icon, no check, a red `Failed` only when one failed, and a run of calls sits in one hairline box. Opening a call shows its full path, then the diff or output in place. A code block is one surface: a copy icon and a `...` menu (Wrap lines, Line numbers) appear over its corner with no fill or strip, only when the pointer or keyboard is on the block.
- **The message box says things once, and the chat reads easier.** The box no longer repeats its keys under a placeholder that already says how to start; its edge is a quiet hairline until you type in it. Answers use the kit's 1.55 line spacing and tables are single hairlines between rows, with no filled header.
- **Settings is a large dialog over the window.** It opens centered with a list of its pages at the left (Look,
  Notifications, Accessibility, Machines, About) and the page at the right, so the layout behind it does not move.
  Machines lists each computer with its live, stale or offline state; adding or editing one happens in the same
  page, and `Esc` steps back from the form, then closes Settings. A press outside
  it does not close it.
- **Questions are answered where you type.** When an agent asks for
  permission, or a terminal agent shows a menu, its chat shows the question
  and its answers in place of the message box, and the box comes back, with
  what you had typed, once it is answered. After an answer the line `Answer
  sent` offers `Next` when other agents are waiting.
- **`Cmd+J` visits only the agents that wait for you.** Finished agents are
  no longer on the walk, it opens the chat without moving the keyboard into
  it, and with nobody waiting it says `Nothing needs you`.
- **A one-line chat header.** The title, project and branch; the state word
  and the `Details` button are gone. Press the title for the session's facts
  and `End session`.
- Releases are macOS (Apple silicon) only for now and Linux builds are
  paused: the installer on Linux says `no Linux build in this release` and
  points to the source build. `install.sh --edge` installs the newest build of
  `main` (the pre-release `edge`, replaced after every push that builds).
- **Play video and sound, and read any file.** The Files dialog plays mp4, mov, m4v, webm, mkv and ogv video and mp3, m4a, ogg, wav and flac sound with a seek bar, volume, loop and full screen (`Space` plays, `Left` and `Right` seek 5 s, `Shift` 30 s, `Up` and `Down` volume, `M`, `L`, `F`); nothing starts by itself. A file another machine holds is copied first (progress, `Cancel`, a 1 GB cache that never grows past its cap); one this computer cannot play says which codec it is and offers the system's player. Pictures zoom, turn and pan and copy to the clipboard; PDFs are drawn in the app; zip, tar and tar.gz files list their contents; tables show as tables, minified JSON is laid out, a text file of any size is read a page at a time with `Ctrl+F` through all of it, and a binary shows a hex peek and what it is. Every file has `Send to the agent`, `Open`, `Reveal`, `Copy path` and, for text, `Copy contents`. `Space` previews the highlighted file beside the list and `Enter` opens it. Played on this Linux box only; macOS was not run.
- **Calmer lists, popups and tooltips.** Sidebar rows are one line each,
  popups and tooltips have a single light edge instead of an edge and a
  shadow, and the way you answer an agent is unchanged.
- **A thin scroll bar that matches the app.** Lists and chats draw it in
  place of the system's thick one. `Always show scrollbars` in Settings
  keeps it on screen instead of showing it while you scroll.
- **Changes is easier to read.** The list headings stay in view while you
  scroll and the review controls are always visible instead of appearing
  on hover.
- **The media player remembers its volume** between files and sessions.
- **Changes now loads on macOS.** It stayed on its loading placeholder
  when the window opened covered; it now reads once.
- **Checkouts reached through a symlink are found.** On macOS, an agent in
  `/tmp` or another linked folder is now matched to its project and its
  files can be mentioned in the composer.
- Not checked: the TSX passed headless tests only; a few macOS screens
  were looked at by eye, Linux was not.

## [0.1.0-alpha.3] - 2026-11-07

### Jump between agents and projects with the keyboard

`Ctrl+Tab` goes back to the agent you were in, `Ctrl+Shift+Tab` to the
previous project, and each project keeps its own tabs.

> [!TIP]
> Try it: open two agents, press `Ctrl+Tab`, then `Ctrl+E` for the list of
> recent agents and projects (`Shift+Enter` opens one in the workspace you
> are in).

- `Ctrl+[` and `Ctrl+]` go back and forward; `Ctrl+Shift+[` and `]` move to
  the previous and next project. All are in the menus and the palette.
- Opening an agent of another project swaps the whole workspace. A draft you
  had typed in a chat is still there when you come back (kept in memory only).
- Clicking a project's name in the sidebar switches to it; the arrow folds it.

### A palette that finds things

`Ctrl+K` searches projects, agents and chats, actions, settings, machines and
files in one box, with the shortcut next to each result.

> [!TIP]
> Try it: press `Ctrl+K`, type `@` for agents, `>` for actions, `/` for files
> of the open project, or `new session pay` to start a session in a project.

- `Ctrl+K` on a result opens its actions (open in a split, mark reviewed,
  copy the id, close). Dangerous ones ask first.
- `Ctrl+P` jumps to a file of the project.

### Review what an agent changed

`Ctrl+Shift+G` opens `Changes` for a project's folder: the changed files, and
the highlighted diff of the one you pick.

> [!TIP]
> Try it: in a chat, click `Changes` in the header. `J`/`K` change file, `N`/`P`
> change hunk, `X` marks a file reviewed, `C` writes a note, and `Ctrl+Enter`
> sends all notes to the agent after showing you the message.

- A file or one group of changes can be reverted after a confirmation that
  says what is lost, with an `Undo`.
- Reading changes never touches your git index.

### A better message box

Type `@` to pick a file or folder of the project, and paste or drop pictures.

> [!TIP]
> Try it: in a chat, type `@` and a few letters of a file name; `Tab` adds it.
> Copy a screenshot and press `Ctrl+V`.

- Pictures are shrunk to 2,000 px and go to agents that can see them; for
  others the thumbnail says so and can save the picture into the project.
- `Up` in an empty box brings back your last message; `Ctrl+Shift+O` attaches
  files. A very long paste becomes a `Pasted text` chip that is still sent in full.

### Calmer shell

- Tabs are a fixed width, a long title is cut with an ellipsis instead of
  running into the next tab, and the front tab is marked with an underline.
- The sidebar no longer jumps back to the top while agents update.
- A terminal agent's tab is a read-only view with the answer buttons; the
  pretend key row, typing mode and slash list are gone. A real terminal is
  being built and is not in this release.
- `Copy name`, `Copy folder`, `Copy title` and `Copy path` on sidebar rows and tabs.
- One-command install: see the README.

**Not checked**

- Copying selected text out of a chat message is still being repaired and may
  not work yet.
- The message box, the palette and `Changes` were tested without a screen
  reader; the new pictures and file picker ran through scripted tests and one
  Linux display, not on a Mac.
- macOS has still never been run by the author.

## [0.1.0-alpha.2] - 2026-11-07

Second alpha. Chat reads code properly, and the macOS app is signed with the
project's own certificate.

![Home: projects, and what needs you](https://github.com/tuan3w/herdr-desktop/releases/download/v0.1.0-alpha.2/0.1.0-alpha.2-home.png)

### Code reads like code in chat

Code in an agent's answer, a command and its output, an edit and the
permission prompt's command are drawn the same way: highlighted, with the
language in the corner, and edits as diffs.

> [!TIP]
> Try it: in a chat, point at a code block and press `Copy code`.
> `Ctrl+Shift+C` copies the code of the last answer, `Ctrl+Shift+Y` the whole
> answer.

- 25 languages are highlighted. Code longer than 16 lines folds
  (`Show all N lines`); wrap and line numbers are switches on the block.
- An edit shows as a diff with the changed words marked and a `+`/`−` column.
- An answer still being written shows its open code block as it stands.
- Settings > Look has wrap, line numbers, tabs and spaces, and side-by-side
  diffs. The file viewer draws code the same way and finds text with `Ctrl+F`.

![A chat with highlighted code, light](https://github.com/tuan3w/herdr-desktop/releases/download/v0.1.0-alpha.2/0.1.0-alpha.2-chat.png)

![A chat with highlighted code, dark](https://github.com/tuan3w/herdr-desktop/releases/download/v0.1.0-alpha.2/0.1.0-alpha.2-chat-dark.png)

### One signature for every macOS release

The macOS app carries the same certificate in every build, so the keychain
and the permissions macOS remembers survive an update. It is not notarized by
Apple: the first launch needs the `xattr` line in the install steps, or
`Open Anyway` in System Settings > Privacy & Security.

### Install with one command

```sh
curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh
```

It checks `SHA256SUMS` and never uses `sudo`. By hand on macOS:

```sh
unzip Herdr-Desktop-0.1.0-alpha.2-macos-arm64.zip
xattr -dr com.apple.quarantine "Herdr Desktop.app"
```

Linux needs GTK 4.14+, WebKitGTK 6.0 and glibc 2.39+ (Ubuntu 24.04 or later).
You also need `herdr` on the machines you watch.

**Not checked**

- It is an alpha. The author's own herdr (0.9.5) on Linux is the only real
  setup it has been tried against.
- macOS has never been run on a real Mac by the author: it builds, its tests
  pass headlessly and the package is signed, but how it looks and feels is
  not checked. Apple silicon only (no Intel build); notifications are plain,
  with no answer buttons, and a click does not open the agent.
- Linux: screen reader announcements are polite only, and there is no tray
  icon.
- Remote machines need `ssh` keys and `python3`; password logins are not
  supported (run `ssh <machine>` once in a terminal to trust the host).
- Two tests are known to fail now and then in CI (a keyboard walk on macOS, a
  Markdown diagram on Linux). They do not affect the app.

## [0.1.0-alpha.1] - 2026-11-07

### One window for every agent

The first alpha of Herdr Desktop, the desktop companion of the Herdr phone
app, for people who run coding agents under [herdr](https://herdr.dev). The
board groups agents by project and shows what needs you first.

> [!TIP]
> Try it: press `Ctrl+J` (`Cmd+J` on a Mac) to jump to the next agent that
> needs you, or `Answer one by one` to walk the waiting ones, longest first.

- `Needs you` and `To review` come first. One count feeds the status line,
  the window title and the triage list, so they never disagree.
- An agent that needs you is said once: loudly in the `Needs you` inbox, and as
  a small shape and the words `waiting for you` everywhere else. Twenty
  waiting agents are one answer in place and a sentence
  (`19 more waiting · docs 4 · infra 4`), not twenty alarms.
- Text, rows and spacing are larger (15-pt text, 56-pt rows, a 300-pt
  sidebar). Cards, messages and counts move briefly when something changes,
  never with reduced motion.

### Answer a question safely

A permission prompt from a terminal agent becomes buttons that show the exact
command.

- A risky answer takes two presses: the first arms it for four seconds and
  says why.
- A button pressed just as the question changed is ignored, and nothing is
  sent when the pane no longer shows the question you saw.

### Watch a pane, chat with an agent

> [!TIP]
> Try it: open an agent in the sidebar. An agent that speaks ACP (for example
> `omp acp`) opens as a chat; the chat of Claude Code, Codex or omp running in
> a terminal opens with `Show chat`.

- A terminal pane is a live mirror with a message box, a key row, an opt-in
  typing mode with a visible way out, links in the output, slash commands and
  quick phrases learned on your computer.
- A chat is a transcript where a drag selects across paragraphs, lists, code
  blocks and tables (`Copy message` takes a whole answer), a permission dock
  with the same safety rules, questions the agent asks, a queue for messages
  sent while it works, and replay after you close and reopen the app.

### Many machines, files and pages

- This computer plus any machine you can reach with `ssh`: your
  `~/.ssh/config`, agent and jump hosts are used. A changed host key stops
  that machine, and a machine that is out never affects another.
- Browse and view files on a machine (code, Markdown, images), send a file to
  it, and open a page it serves (`localhost:5173`) through a tunnel.
- Notifications are off by default; when on, an agent that needs you while the
  window is away makes at most three, then a summary.
- `Ctrl+K` is the command palette, `F1` lists every shortcut, and
  `Ctrl+Shift+D` opens a developer panel with the time from a pane changing
  to its text being on screen.
- Every control has a name for screen readers, states are shapes and text
  rather than colour, the four themes pass contrast checks, and reduced motion
  and large text are honoured.
- Settings > About asks GitHub once, when Settings opens, whether a newer
  release exists and offers `Open release page`. It sends nothing about you
  and has a switch to turn it off.

### Install

```sh
tar -xzf Herdr-Desktop-0.1.0-alpha.1-linux-x86_64.tar.gz   # Linux: "Herdr Desktop/"
unzip Herdr-Desktop-0.1.0-alpha.1-macos-arm64.zip          # macOS
xattr -dr com.apple.quarantine "Herdr Desktop.app"         # macOS, then drag to Applications
```

On Linux, `local/install.sh` installs it for your user. Linux needs GTK 4.14+,
WebKitGTK 6.0 and glibc 2.39+ (Ubuntu 24.04 or later). macOS blocks a
downloaded copy the first time (the app is signed ad hoc, not by Apple): run
the `xattr` line, or use `Open Anyway` in System Settings > Privacy & Security
(on macOS 14: right-click, `Open`). You also need `herdr` on the machines you
watch and `ssh` keys for remote ones.

**Not checked**

- It is an alpha. The author's own herdr (0.9.5) on Linux is the only real
  setup it was checked against; the rest ran against a scripted stand-in.
- macOS has never been run by the author. Not checked there: how it looks in
  a real window, `Cmd` shortcuts, window sizing, the web pages (`WKWebView`),
  VoiceOver, and whether herdr keeps its socket at `~/.config/herdr/herdr.sock`
  on a Mac (set `HERDR_SOCKET_PATH` if not). Notifications are plain and show
  under Script Editor in System Settings > Notifications. Apple silicon only.
- Linux: announcements for screen readers are polite only, and there is no
  tray icon. A shell profile that preloads jemalloc 5.3.1 crashed GTK 4.22
  whenever a window's widgets changed; the app now restarts itself without
  the preload (`HERDR_DESKTOP_KEEP_PRELOAD=1` keeps it).
- Code in chat is not coloured yet: blocks show as plain monospace text.
- Remote machines need `python3` and `ssh` keys; the update check does not
  offer newer alphas.
- Where keyboard focus lands after closing a dialog or tab, and how it reads
  in Orca or VoiceOver, was checked through the accessibility tree in tests,
  not by listening. Dropping a file on a pane has no automated test.
