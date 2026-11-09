# Changelog

What changed for the person using Herdr Desktop, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `docs/RELEASING.md` (0.1.x, patch bumps). The section of a version is its release notes: write it for the person, not for the commit log, in the format of `.agents/skills/herdr-changelog/SKILL.md` (pictures are assets of the release, never files in git).

## [Unreleased]

## [0.1.0-alpha.12] - 2026-11-09

### Errors the agent recovers from stay quiet

A failed call the agent ran again is no longer red. It reads `Retried`
and is counted on the turn's folded line, so a turn full of fixed errors
reads calmly. A failure that stands is still loud.

> [!TIP]
> Try it: in a chat where the agent's test run failed and it ran it again,
> look at the folded line above its answer.

- The folded line says `Ran 4 commands, edited 1 file · 2 retried`, and
  the failed row inside it reads `Retried` in muted text instead of `Failed`
  in red.
- Nothing about a retried failure is listed under the answer any more.
- A retry is the same command, or the same file, run again later in the
  same stretch of work. A different command is not counted, so when in
  doubt the failure is shown.
- A failure nothing came after stays a line under the answer. A failed
  push, delete or install is never counted as retried: it always stays a
  line.
- Of several failed tries in a row, only the last one is shown.

**Fixed**

- Hovering a subagent card no longer paints its grey over the card's
  rounded corners and outline. The card now clips its header inside its
  border, as the box of calls does.

**Not checked**

- Not tried on a real conversation: the rule was drawn and tested on made-up
  turns. Not run on a Mac; on Linux it was drawn in light and dark at 1280
  and 760 px.
- The hover fix was drawn on Linux only, where the outline already looked
  the same before it; whether it cures what you saw on a Mac is not known.

## [0.1.0-alpha.11] - 2026-11-09

### A message never lands on a question by mistake

Messages to an agent now go through herdr's own check that the agent is
at its prompt. If it is waiting for an answer, nothing is typed and the
message says why.

> [!TIP]
> Try it: in the palette, run `Install herdr hook for Claude Code…`, then
> pick two agents on the board and press `Message`.

- A chat, the board's `Message` and a background stop all use it. A herdr
  too old to know it gets the text and Enter as before, and says nothing.
- The refusal reads as a sentence (`The agent is waiting for an answer, so
  the message wasn't sent. Answer it first.`), never a code.
- Closing a pane, tab or workspace that herdr no longer has counts as
  closed instead of failing.
- Starting a workspace or tab in a folder that does not exist on that
  machine now says so and starts nothing. herdr used to open its own home
  folder and say nothing.
- The palette installs herdr's hook for omp, Claude Code or Codex on a
  machine, after asking: it changes that agent's own settings.

### Name anything, and see what subagents do

A pane, a chat, a tab and a workspace can be renamed, and an empty name
gives the program's own title back. An omp task shows one line for each
of its subagents while they work.

> [!TIP]
> Try it: in a chat that runs several subagents, watch the card.

- A pane's rename dialog says `Leave empty to show the program's own
  title`; the `Rename…` action of a chat names it on this computer only.
- A terminal tab is titled by the pane's name, else a tab you named, else
  the program's own; the tooltip adds the workspace and tab you named.
- Starting an agent has an optional `Name`; left empty, herdr names it by
  its kind. A machine whose herdr lists the agents it can start offers
  only those.
- A hook's title names an agent on the board, after a name you gave it
  and before the terminal's title.
- Each subagent line has a mark, its name, the tool it is in, its tool
  count and its time. When all are done the card folds to
  `3 subagents, 2m 10s`.
- The palette's `Remove worktree…` closes a linked worktree's workspace
  after asking; it never forces and never touches a main checkout.
- A chat read from a terminal has no queue: the box says `Send to the
  terminal`.
- Messages waiting behind a turn are kept when the connection drops,
  held with `The connection dropped`; `Send now` lets them go. A chat
  with messages waiting is no longer closed for lingering.
- A popup's scroll bar no longer covers a field at its right edge.

**Fixed**

- The install command installs the highest release again. After
  `0.1.0-alpha.10` it installed `0.1.0-alpha.9`, because GitHub lists
  `alpha.10` after `alpha.5`.
- On Ubuntu (Yaru theme), the window's title bar no longer loses its
  background: its title and window buttons floated over whatever was behind
  the window, and the menu row looked empty. The app now names your GTK theme
  itself at start, so GTK keeps it. A `GTK_THEME` you set is left alone.

**Not checked**

- Never run against a live herdr: messages, hooks, closing and worktree
  removal are tested against a scripted herdr only.
- Not run on a Mac. On Linux the new screens were drawn in light and dark
  at 1280, 960 and 760 px; large text and reduced motion were not.
- Not built yet: a hook's state label and tokens on the board, and a
  `Not running` row for a pane herdr could not restore.

## [0.1.0-alpha.10] - 2026-11-09

### Chats open where you left them

A chat you come back to shows its conversation at once, then catches up with
the machine. Closing its tab no longer drops the connection.

> [!TIP]
> Try it: in a chat, close its tab, then open the same agent again.

- The app keeps the last conversation of every agent you opened, in its own
  folder on this computer. Opening the chat paints that copy first, with a
  line saying when it was saved, then asks the machine only for what happened
  since. Nothing can be sent or answered while the copy is shown.
- A chat you close or switch away from stays connected for ten minutes (90
  seconds while the window is hidden), so coming back costs nothing and the
  window no longer waits for the connection to close. A chat you left gives
  its place up when you open another on a machine that is full.
- The sidebar shows the agents of every machine as they were when you last
  looked, marked as not live, before the connections come up.
- Changes and Files show what they showed last time at once and correct it
  when the machine answers. Reverting waits until Changes has read git again.
- The events of a remote machine travel compressed as one stream.
- Over ssh to one machine, a 30-turn conversation took 22,977 bytes to open
  and takes 1,499 when the app has a copy; the last 192 KB of an agent's log
  took 70,230 bytes and takes 10.

### Storage you can see and clear

Settings has a Storage page: what the app keeps on this computer, a switch to
stop keeping it, and `Clear`.

> [!TIP]
> Try it: press `Ctrl+,` (`Cmd+,` on a Mac) and choose `Storage`.

- A machine you remove takes its saved conversations and board with it.

![The Storage page of Settings with its switch and the Clear button](https://github.com/tuan3w/herdr-desktop/releases/download/v0.1.0-alpha.10/0.1.0-alpha.10-storage-page.png)

**Not checked**

- The line over a saved conversation and the Storage page at narrow widths and
  large text were not looked at in a window.
- Opening a chat did not get faster in seconds over ssh in the one test
  machine: only the bytes dropped; the saved copy is what shows at once.
- Not run on a Mac, nor against a machine busy with many agents.

## [0.1.0-alpha.9] - 2026-11-09

### Links that open without closing the app

> [!WARNING]
> On some Linux desktops pressing a link closed the app at once
> ("Could not create GBM EGL display"). Pages in the side panel now draw
> without the GPU path that failed.

- Pressing a link on a Linux desktop where WebKit cannot use the graphics card
  no longer closes the app: pages are drawn in memory instead. Set
  `WEBKIT_DISABLE_DMABUF_RENDERER=0` to go back to the GPU path.
- Links in the chat show their whole address again, in the text colour, with
  nothing shortened or highlighted.
## [0.1.0-alpha.8] - 2026-11-09

### Paths that open, skills that complete, a browser beside the chat

A path the agent names opens wherever it appears, your skills show in the
`/` list, and a link opens in a small browser you can use. Settings and
picture zoom no longer flicker.

> [!TIP]
> Try it: in a chat, type `/` and part of a skill's name, such as `/herdr`.

- In an omp chat read from the terminal, the `/` list offers the project's
  and your skills as omp runs them (`/skill:herdr-design`), with their
  descriptions; type part of the name, such as `/herdr`. A Claude Code chat
  lists its skills before the first message too.
- A long command on the working line now ends in … at the edge of the
  conversation, with the time still beside it.
- The install script waits out GitHub's short download outages (it gave up
  after four quick 504 errors).
- The sidebar no longer shows a column of pick boxes over agent names. Pick an
  agent from its `...` menu, or with Ctrl+click (Cmd+click on a Mac);
  Shift+click picks a range. A picked agent shows a check mark.
- Settings › About now finds the newest alpha (it only ever looked for a
  stable release), says when you are up to date or why it could not check,
  and copies the install command that updates the app.
- Choosing a page in Settings switches at once: the dialog no longer
  vanishes and fades back in on every press.
- A page opened from a link is now a small browser: go back and forward,
  reload, and type an address (Ctrl+L, Cmd+L on a Mac). Copy link and Open in
  browser sit in its one bar; a page that cannot load says why and offers to
  try again.
- Zooming a picture with the wheel or touchpad goes straight to the new size:
  the picture no longer jumps up or down for a moment on every step.
- A path the agent names relative to its folder (`.scratch/shot.png`,
  `../notes.txt`, `main.rs:3`) now opens when you press it, in a message or
  in a tool call, instead of saying "A path must start with / or ~/". It is
  looked for in the session's folder, then its checkout and project; a file
  that is not there says which folder it is not in. Files in tool calls open
  in the side panel like links in messages.
- A picture you attached to a terminal agent's chat shows as a thumbnail in
  your message, and other files as small chips, instead of the raw
  `@.herdr-desktop/attachments/…` text. Press one to open it beside the chat.

## [0.1.0-alpha.7] - 2026-11-09

### Pictures and links you can check without leaving the chat

Pictures an agent mentions show in its answer, and any link opens in a panel
beside the conversation, so you can check a page, a file or a screenshot and
keep reading.

> [!TIP]
> Try it: press a link in an agent's answer. Hold `Ctrl` (`Cmd` on a Mac)
> while pressing to open it in the browser as before.

- A machine in the sidebar now reads as a machine: a computer icon, its name
  in the text colour and a line above it, so it is never mistaken for a
  project.
- Pictures in an agent's answer now show as thumbnails with their name and
  size, read from the agent's machine; a press shows them large beside the
  chat. Pictures on the web are never loaded until you open them.
- Links in the chat open in a panel beside the conversation: web pages, a
  file at the line the agent named, a picture, and a remote machine's dev
  server. Hold Ctrl (⌘ on a Mac) while pressing to open in the browser or a
  tab as before. Bare web addresses read short: the site, then the path.
- In the chat of a terminal agent the `/` list now offers the agent's own
  built-in commands, such as Claude Code's `/clear`, `/compact`, `/context`
  and `/model`, omp's `/new` and Codex's `/diff`, next to its skills. Commands
  that only open a menu in the terminal are left out.
- While an agent works, the line at the end of its chat says how long the
  current step has run (`Running pnpm test · 12s`, `Thinking · 1m 04s`) and
  its half ring turns slowly while the agent is being heard from. It stands
  still once nothing has arrived for a minute, next to `Quiet for 1m`, and
  under Reduce motion.
- A subagent's assignment, the first message of its conversation in the
  Activity panel, is shown formatted: lists, code, bold and links.

## [0.1.0-alpha.6] - 2026-11-09

### A sidebar by machine and a message box that works with terminal agents

The sidebar is in sections, Pinned, This computer, then each other machine,
and projects where nothing is going on fold into one quiet line. The
message box keeps your words on top and its controls in one row inside it.

> [!TIP]
> Try it: open a project's `...` menu in the sidebar and choose `Move up`,
> or press `Ctrl+Shift+Up` (`Cmd+Shift+Up` on a Mac) on its header.

- Agent names start at the left edge with their state at the right end of
  the row, so a quiet list has no gap; a pinned project sits in `Pinned`
  only.
- In the message box the `/` and `@` lists open as the box's own top, at
  its width. The `/` list shows commands and skills under their own
  headings, and a file's preview sits inside the `@` list.

**Fixed**

- A picture or file sent to a terminal agent's chat no longer fails with
  "Attach files in the terminal": it goes as its path in your words, as on
  the phone.
- A terminal agent's chat follows `/clear`, `/new` and `/resume` to the new
  session within seconds instead of staying on the old conversation; after
  Claude Code's `/clear` one line says "The conversation was cleared".
- Claude Code's skills stay in the `/` list of a long session; they were
  missing once the session outgrew the first read of its log.
- A slash command typed into a terminal agent's chat (`/clear`, omp's
  `/compact`) no longer warns that the terminal may not have taken it.
- Typing a command's whole name and pressing Enter keeps that command
  instead of picking a longer one that starts the same way.

**Not checked**

- Known: typing Vietnamese with ibus in the message box can repeat a word
  (`thông thông`); not fixed yet.
- Seen on Linux only, on made-up data with one machine; several machines,
  a pinned project and hover were not looked at.

## [0.1.0-alpha.5] - 2026-11-09

### A quieter window, everything on one edge

On macOS the system title bar is gone and the traffic lights sit in the
sidebar's first line; that line, the tabs and a chat's header share one
height and centre. Titles, labels and messages start on the same edges, so
the window reads as one page.

> [!TIP]
> Try it: in the sidebar, click `Search` (the magnifier at the top) or press
> `Cmd+0` (`Ctrl+0` on Linux) and type part of a project or agent name.

- Under a row of tabs, a chat's header no longer repeats its title; its
  details open from `...` at the end, and `Changes` shows once, as a tab or
  a button.
- The sidebar is quieter: no app name row or key hints, idle agents carry no
  mark, and a worktree is one label, its branch.
- While an agent works, the message box says `Queue a message` instead of a
  help line under it, and Stop is a quiet ring, so the agent that waits for
  you stays the one loud thing on screen.
- A tab can be wider before its title is cut.
- Linux builds are back: the release has a Linux x86_64 archive again, and
  the install command picks it on Linux.

**Not checked**

- Seen on Linux only. On macOS the room left for the traffic lights and
  dragging the window by its top line have not been looked at.
- The Linux archive is built by the release, not tested by it.

## [0.1.0-alpha.4] - 2026-11-08

### A calmer window you can keep open all day

Every list, menu, dialog and field was checked against real-world data (long
names, empty lists, a thousand rows, narrow windows), so nothing jumps, nothing
is cut mid-word, and the one agent that needs you is the one orange mark on the
screen.

> [!TIP]
> Try it: let an agent wait for an answer. Its row in the sidebar turns orange,
> `Cmd+J` takes you to it, and the question waits in its chat with the exact
> command and `Nothing is sent until you choose`.

- Menus are narrower, their keys are plain text, and a menu letter works even
  while the message box has the keyboard; a greyed-out item says why.
- Dialogs close when you click outside them, unless you would lose what you
  typed. `Settings` opens as a large dialog with its pages at the left.
- A disabled button keeps its look and fades; a long label ends in `…`.
- Tabs stay full chips while they fit, and a tab never grows when its machine
  goes offline.

### See what an agent changed, not the whole folder

`Edited 7 files` in a chat opens `Changes` on those seven files, readable even
in half the window.

> [!TIP]
> Try it: press `Edited N files` under an agent's answer, then `Mark reviewed`:
> it moves on to the next file. `This session` and `Everything` switch between
> the agent's files and every change in the folder.

- Files are grouped by folder, and a name is always whole.
- Hundreds of generated output files wait folded in `Not in git`; a big data
  file says `New file · 1.9 MB · 40,000 lines` instead of drawing a huge diff.
- In a narrow pane the list folds into one bar (`‹ 3 of 7 ›`, `Files`) and code
  scrolls sideways instead of breaking into one letter per line.

### Subagents beside the chat, and you can read their conversations

A chat with a terminal agent has `Activity` at the right: what runs now and for
how long, what failed, and what finished, folded to one line.

> [!TIP]
> Try it: in a chat whose agent started subagents, press `Cmd+Shift+I`, then a
> subagent's row to read its own conversation. `Back` returns to the list.

- Background commands read as what they do (`pnpm test --watch`), not
  `cd /path && …`. A long-running one asks for a second press to stop.
- The chat keeps one quiet line, `2 subagents running · Show`, while the panel
  is closed.

### Files and pictures

- `Files` is a tab, not a dialog: a breadcrumb path (`Cmd+L` to type one), and
  `Name`, `Size` and `Modified` columns that line up and sort.
- A message with pasted pictures shows them, in place of `[Image #55]`.
- Pasting a picture for an agent that cannot take pictures just works: it is
  saved into the project and named by path when you send.
- Pasted pictures are scaled to 1,568 px and kept around 1 MB, so sending one to
  another machine is quick.
- Photos open in a quiet lightbox, and zooming is smooth, toward the pointer.
- Choosing a folder in `New agent session` is a field that suggests folders
  (`Tab` completes one), not a second dialog.

### Everything else

- Tool calls fold into one quiet line per turn; a run of calls is one hairline
  box, and commands read as what they did (`Ran python3 script`).
- `/` shows each command with what it does on its row, and nothing flickers as
  you move through it.
- A long chat scrolls more steadily: PageUp and PageDown glide, and the scroll
  bar no longer shrinks and jumps.
- `Load earlier messages` reads older turns of a terminal agent's chat.
- `New agent session` can start an agent in another checkout or a new worktree.
- One thin focus ring, keys drawn one at a time, spinners that no longer keep
  the app drawing, and toasts at the top right where they cover nothing.

**Fixed**

- A dialog with a list, like the folder field, sometimes ignored `Down`: every
  dialog was built twice and the hidden copy took the keys.
- Pictures showed `This picture cannot be shown` in the installed app.
- `Changes` stayed on its loading placeholder when the window opened covered.
- An agent in a linked folder such as `/tmp` was not matched to its project.

**Not checked**

- The terminal tab is off by default (`Settings`,
  `Terminal tab (experimental)`): with one open, going to the Board could make
  the app spin.
- Trackpad scrolling feel, hover states and large text were not checked by eye;
  most screens were checked in screenshots on a Mac.
- Subagent conversations were tested with Claude Code logs; Codex and omp only
  by their file rules. Linux builds are paused.

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
