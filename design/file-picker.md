# Files: browse, pick, view

One family of parts does three jobs. **Browse** looks at what an agent touched or what is there, **pick** chooses files or a folder to attach, send or start a session in, **view** reads one file. Today these are `FilesTab` (a tab of the dock, `design/files.md`), `FolderField` (the folder path field with its list; the folder-picker dialog is gone), `SendFiles`, `FileViewer` (pictures are drawn by `ImageView`; video, sound and PDF are in `design/media.md`); this page is the decided shape (owner, 2026-11-07: "since we have remote file picker, I want a great viewer"). `design/files.md` keeps the facts about the code that exists; the design system cards FileBrowser, FilePicker, FolderPicker, FileViewer, RemoteStates and QuickOpen render this page. Sizes are in `lib/layout.ts` (`ROW`, `CONTROL`, `ICON`, `SPACE`, `TYPE`), never restated here.

## Where each job lives

| Job | Surface | Why |
|---|---|---|
| Browse, changed files | Files tab of the inspector, `Changed` first, `All` second | the question is "what did it touch", asked beside the chat, never instead of it |
| View | a tab beside Chat (tabs are drawn only with two or more, `design/tabs.md`) | a file is read for minutes and compared with the chat; a dialog hides a waiting question |
| Find | quick open, a transient palette on `mod+p` (`quickOpen`, `QuickSearch`) | a name is known; walking folders to it is slower than typing |
| Pick files | a short dialog that ends in one decision (`Send`, `Attach`) | the person leaves with a choice made within a minute, `design/dialogs.md` |
| Pick a folder | a popover from its trigger, a list and a breadcrumb | one question, one answer; a window for it hides the form it belongs to |

The three jobs share the list, the row, the breadcrumb, the machine rules and the keys below. Two lists for one job is a migration to one (principle 6).

## Remote first

- **The machine is part of every path and is said once**: the first crumb is the project root with its machine, `build-box / payments / lib`; this computer is the default and says nothing. Never the absolute path as a label (it is `Copy path`). Why: the supervisor's question is "which copy of which project", and the project already names the machine (`AGENTS.md`).
- **Honest states, each in place of the list, never a spinner over a blank:**
  - connecting: the first crumb is dim and the list holds the shape of its rows (`Skeleton`).
  - a listing slower than 400 ms: a skeleton that holds the row shape; after about 2 s one quiet line under the crumb, `build-box is slow`, with `Cancel`. The UI thread never waits: `RemoteFiles` runs on a `herdr-core` thread and the list is told "revision N".
  - stale (decided, not built yet, see below): a cached listing is drawn with `Listed 14 min ago · build-box is not answering`, `Retry`. Never drawn as live.
  - offline or failed: what happened and what to do, one sentence from `FileErrorKind` (`Unreachable`: `build-box did not answer. Check the connection, then Retry`; `Unsupported`: `build-box has no python3, which the file list needs`). The crumb stays, so the way up still works.
  - permission denied: the row is dimmed, says `no permission` to a screen reader, and still opens to explain; it is not hidden.
  - capped: `Showing the first 5000 of this folder. Type to find a file.` (`LIST_MAX`), above the list, once.
  - too big: the first part and a sentence, `Showing the first 4 MB of 18 MB` (`TEXT_CAP`); a picture over `IMAGE_CAP` says its size and offers `Copy path`.
- **Reading only.** No editing, no saving, no delete, no rename. The one write is `Send`.
- **What leaves a machine says its direction**: `Send to this computer` from build-box reads `from build-box to this computer`, always with both names. `Reveal` and `Open` exist for this computer's files only; on a remote file they are not disabled, they are absent (a disabled control invites a hunt for why).
- **Recent and pinned places are per machine** (decided, not built yet): the breadcrumb's root menu lists the machine's pinned folders, then the last five.

## Browse

- **A list of one folder with a breadcrumb, not a tree.** Why: a tree over ssh is a round trip per expansion and a re-sort under the pointer; indentation spends a 336 pt inspector's width on emptiness; and a person who knows a name uses quick open. Right enters, Left goes up: the keys of a tree on a list that never shifts. `All` is that list; `Changed` is a flat list of the files the agent changed, newest first, each with its folder in muted text.
- **One row for every list of files** (`components/file-row.tsx`, built): `FileName`, `FileSize`, `FileModified`, `FileRow` draw the Files tab, the attach list and the `@` list; the glyph is `fileGlyph`, also quick open's. A folder after the name only in a search result.
- **A grid with fixed columns**, so digits stack: name (cut before the extension, `session-service-fact….ts`, so the kind stays readable; the full name in the `Clipped` bubble), an optional muted folder (flat results only), then size right-aligned in tabular figures (`Changed` swaps it for `+12 −3`). One unit only: `897 B`, `8 KB`, `1.2 MB` (`sizeText`). The size column is as wide as its widest value, never as the name is long. Why: the screenshot's columns started at a different x on every row.
- **Age is not in every row.** Why: "6 d ago" on 24 rows is one fact said 24 times. It appears in a row's hover bubble, in the viewer header, and as a column only in a flat search result (`modifiedText`).
- **Glyphs by kind**, one icon family, 1.5 stroke, grey: folder, code, text, picture, PDF, sound, video, archive, other. The kind is also in the row's label, so the glyph is never the only signal.
- **Changed files** carry a status letter (`M`, `A`, `D`, `R`, `?`) in text and `+12 −3` in the diff colours; both are words or numbers, not only colour (`design/changes.md`).
- **Rows are one line** at the compact tier (`ROW.agentCompact`), folders first, then files. Hidden files are off (`showHidden`); sort is name, modified or size in the `Folder options` menu (`fileSort`, `ActionMenu`), name by default.
- **A quiet filter field** above the list finds as you type, folds accents (`fold`), no border until focused; it filters the open folder, and Down moves into the list. `mod+p` is the project-wide fuzzy find, recent first.
- **Keys** (the list takes focus on open): Up, Down, Home, End; Right enters a folder; Left goes up; Enter opens; Space previews the row as Quick Look does (a peek that Space or Escape closes, no tab made); typing a letter jumps to the next name that starts with it, a `/` starts the filter. Escape leaves the preview, then clears the filter, then closes nothing.

## Pick

- **Single or multiple.** Multiple adds a leading checkbox column, shown on hover and always once anything is selected. Why: a column of empty boxes on every row is noise before the choice starts. Click selects one; `mod`+click toggles; Shift+click and Shift+Down select a range; Space toggles the row; `mod+a` selects every file of the folder.
- **One selection bar**, below the list, replaces the footer: the count, the total size and the one primary action, `Send 3 files · 4.2 MB to build-box:/srv/app`. Nothing is sent before that button; there is no timer and no default (principle 2). `Clear` is a ghost button beside it.
- **Limits are shown before they bite**: a folder row's checkbox is absent with `Folders are not sent`; a file over the cap is dimmed with its cap; when the total is over a limit or a collision is unanswered, the bar says why in a sentence and the button stays disabled and described by it.
- **Collisions are asked per file**, in the row: `A file with this name is already there`, `Replace` or `Skip` (today's `SendFiles`). A `Replace` makes `Send` two-step: the first press says `Replace 1 and send: press again`, the second within 4 s sends (principle 2).
- **Drag from the OS** onto a tab or the picker draws a dashed `Drop to send to build-box: /srv/app`; the drop opens the dialog, it never sends.
- **Folder field** (`components/folder-field.tsx`, built; rules in `lib/folder-suggest.ts`): no dialog over a dialog. The `Folder` field of New session and Send is a path `Autocomplete`. Typing lists the subfolders of the nearest folder that exists whose names match what follows it (prefix before substring, case and accents folded, hidden only after a `.`), 32 pt rows, ten at most; `Tab` or Enter on a highlighted row completes a folder with `/` so the next level lists; Enter with nothing highlighted is the form's; Escape closes the list, the next one the dialog. A name that is not there is one muted line (`No folder named x in /w/`), never red before submit. An empty field lists `Projects` (the board's, on that machine) then `Recent`. A failure of the listing (denied, machine unreachable) is `Couldn't list <path>: <reason>` and the field is untouched; while a folder loads the list is one blank row, no spinner. `~/` lists the machine's home. No folder icon yet (the kit row has none). `New folder` and a remembered choice are not built.

## View

- **Header**: the name, then one muted line (`812 KB · 4 min ago · build-box`), then actions in one button language with the key inside the button: `Copy path`, `Open` or `Reveal` (this computer), `Send to…`, `Show diff` for a changed file. A changed file opens with a `Changed` / `File` switch: the diff, or the whole file.
- **Text**: a `CodeBlock`, line numbers, find (`mod+f`), a link's line marked and scrolled to, no wrap with a `Wrap` toggle. **Markdown**: a `Preview` / `Source` switch. **Picture**: a checkerboard ground, `Fit` and `100%`, no zoom. **PDF**: page count and scrolling. **Sound and video**: the player; Space plays, Left and Right seek, Up and Down set the volume, `m` mutes, `f` is full screen, speed in a menu; controls hide while it plays and return on pointer or key; the volume is remembered. **Binary**: a hex peek. **Archive**: a listing, not extraction. **Too big**: paged by lines.
- **Errors in place** with the reason and the next step, in the viewer's own area, never a toast (`design/dialogs.md`).
- **The tab** shows the project-relative path cut at the front (`…/auth/session.ts`), a pin and a close; it reopens where the reader left it (scroll, line, view).

## Accessibility and keys

- The list is one listbox (`option`) in all three jobs: `selected` means checked when picking and is absent when browsing; every row's label is the sentence `entryLabel` builds and adds kind, size, status and `no permission` (`notes.ts, file, 168 bytes, modified, no permission`). A query never matches that sentence (filter on the name).
- The count and selection are announced: `12 files`, `3 selected, 4.2 MB`; a state that replaces the list (slow, stale, offline) is announced once, when it appears.
- Focus order: breadcrumb, filter, list, selection bar. The selection bar's button is a Tab stop and is named with the whole sentence. Focus is `FOCUS_RING_INSET` inside rows.
- Hit targets are `CONTROL.small`; the checkbox's target is the whole row cell. Reduced motion removes every fade; nothing here moves for any other reason.

## Motion

None for list navigation, selection or a state replacing the list. A tab opened by a click fades in for 120 ms (none when opened by key). A skeleton appears only after 400 ms and never pulses (a still shape). Quick Look opens without animation.

## Today vs decided

| Today (screenshot) | Decided |
|---|---|
| a full-window dialog titled 28 pt hides the chat | an inspector tab and a tab beside Chat |
| the path three times (field, crumbs, up arrow) | one breadcrumb, the machine as its first crumb; absolute path only in `Copy path` |
| crumbs with no separators or hierarchy | chevron-separated crumbs, the last one is text, each earlier one a button |
| a bordered search field touching the list | a quiet filter with its own row of air |
| 52 pt rows at 20 pt, 8 of 24 files visible | one line at the compact tier, a dozen or more visible at 336 pt wide |
| size and age start at a different x per row | fixed columns, size right-aligned in tabular figures |
| `400 bytes` next to `8 KB` | one unit: `400 B`, `8 KB` |
| every row says `6 d ago` | age in the hover and the viewer; a column in flat results only |
| one generic icon | glyphs by kind, one family |
| blue-grey selected tint | the `accent` fill like every other list; focus ring inset |
| bordered `Close` and a filled `Esc` chip | no Close (it is a tab or an inspector); Escape leaves the viewer, then the filter |
| `24 items` floats below | the count is announced and shown in the filter's placeholder; the footer is the selection bar when picking |

## Decided, not built yet

Everything above that has no code today: the inspector and tab placement, the grid columns and glyphs by kind, Space preview, the multi-select column and selection bar, per-machine recent and pinned places, a stale cached listing with its age and `Retry`, a visible `Cancel` for a slow read, the remembered folder per machine, `New folder`, the viewer's `Changed` / `File` switch, the `Wrap` toggle and the tab's pin and remembered place. The latest viewer (sound, video, PDF, hex peek, archives, paged lines) is on origin/main and is not in this tree yet.
