# Files, viewers, diagrams and pages

`components/files.tsx` (`Files`: the browser, with `FileViewer` in `file-viewer.tsx`), `design/media.md` (the player and every other viewer), `markdown.tsx` (`Markdown`), `mermaid-block.tsx` (`MermaidBlock`), `web-page.tsx` (`WebPage`), `send-files.tsx` (`SendFiles`). The state and rules are `lib/files.ts` and `lib/mermaid.ts` (pure, with tests); the work is Rust (`herdr_core::files`, the `Files`, `Pages` and `Diagrams` modules). `files.test.tsx` and `pane-files.test.tsx` drive it against `fixtures/files/project`, a synthetic folder the test seam (`Files.testTree`) copies; the shots and the audit use the same folder through `files-lab.tsx`.

## What it is for

The question while supervising is "what did it just touch?". Everything here is **read only** except `Send a file`, and nothing here is a second editor: no typing into a file, no save. Doors in, all through `browsing` (`lib/files.ts`): the Files tab of the inspector (the pane's folder on the pane's machine), the palette entry `Browse files…`, and a path pressed in a pane or in Markdown (`openLink`, which finds it in the pane's folder and the two above it, as `candidates` orders them).

## Decided, not built yet: Files is an inspector tab

Owner decision 2026-11-07. Why: a full-window dialog hid the conversation and any question waiting in it, and "what did it touch" is consulted beside the chat, not instead of it.

- **Files and Changes are tabs of the inspector.** There is no full-window dialog and no `Browse files` button in a header. Opening a file adds a tab beside Chat in the main region (tabs are drawn only when two or more exist, `design/tabs.md`), so the conversation is one click away.
- **Changed first.** The tab opens on the files the agent changed, newest first, with the status letter and `+12 −3`; the whole tree is one switch away. Why: the person arrives with "what did it touch", not "where is X".
- **The breadcrumb is relative to the project root** (`payments / src / auth`), never an absolute path: the root is the context, and the machine is already named by the project. Each part is a button; the absolute path is `Copy path`.
- **A grid, not a list of sentences**: name, then size right-aligned in tabular figures so digits stack. Folders come first, then files, each sorted by name. No age column by default: a modified time answers a question the Changed-first view already answers; it is one choice away in the options (modified, size).
- **Escape leaves the viewer first**, then the tab's folder, and never closes the window.

Today's code is still the dialog below (`Modal huge`, `Files`), with the same list rules. It is replaced in one change.

## The browser (today)

One dialog with two steps: the folder, then a file. **Escape leaves the viewer first and closes the dialog second**; `Close` always closes.

- The list is nsh's `Command`: virtualized, Up and Down, Enter, a listbox for screen readers. Filtering is ours (`filterable={false}`, `fold`) because a row's label is the whole sentence `entryLabel` (`notes.txt, file, 168 bytes, 4 min ago, no permission`), which a screen reader needs and a query must not match. Folders come first under a `Folders` heading, files under `Files`; `arrange` orders them (`fileSort`: name, modified newest first, size largest first) and hides dotfiles unless `showHidden`; both live in `Folder options`.
- Above the list: `Up one folder`, the `Folder` field (a path to type; Enter goes), a breadcrumb of buttons, then `Find in this folder`. Below: `6 items · 1 hidden`, and the limits as sentences (only the first 5000 entries, names that are not text).
- A folder that cannot be opened (missing, no permission, machine unreachable) is a panel with the reason, `Try again` and `Up one folder`, never an empty list. The way up is from the folder that failed.
- An entry nobody can read is dimmed, says `No permission`, and still opens to explain.

## The viewer

`FileViewer`: `Back to the folder`, name, `812 KB · 4 min ago · devbox`, then by kind (`ViewKind`, decided by the core from the name and the first bytes):

- **Text**: a `CodeBlock` (`design/code.md`) with the language its name says, line numbers fixed on, and for a link that names a line (`main.rs:12`) that line marked and scrolled to (`goTo`, `CodeView.goToLine`). It selects and copies, and `mod+f` opens `PaneFind` over the file's lines (Enter and Shift+Enter step, the current line is marked and brought into view); it never changes the file, and is named `<file>, read only`. Decided with evidence: the `Editor` was kept for the one thing the view cannot do, a file of any size: above 512 KB (`CODE_VIEW_LIMIT`) the viewer is the read-only `Editor`, whose own find and caret keys then apply, because the code view builds a row per line.
- **Markdown**: `Markdown` with a `Preview`/`Source` switch (`Source` is the editor).
- **Everything else** (pictures, video and sound, PDF, archives, tables, JSON, big text, binaries): `design/media.md`.
- `Reveal` and `Open` act on a file of this computer only (`reveal_path`, `open_path`: Rust-only in nsh 0.4.0, so no `fs` capability is needed); `Copy path` works everywhere. A file that changes on disk is not followed: go back and open it again.

## Pictures

A picture opens in the same viewer as every other file (`ImageView`: zoom, fit, pan, rotate, `Copy image`); `Left` and `Right` walk the folder's pictures, `Photo 3 of 12`. A remote picture is copied once into the cache (`files_cache`, emptied at start) up to `IMAGE_CAP` (40 MB).

## Markdown and diagrams

`Markdown` is nsh's `TextView` (selectable, tables, task lists) with its fences drawn by `CodeBlock`, plus: only `http` and `https` links open (in the browser); a relative path opens in the viewer, found like a pane link; an image is never fetched, it is a chip `Image: <alt>` that opens the picture when its address is a path.

**Diagrams are drawn.** A closed ` ```mermaid ` fence is a custom node (`extensions`) shown by `MermaidBlock`: the bundled mermaid in a web view, no network. Decided with evidence (the GTK shot and the AT-SPI tree of the `file-diagram` scenario), because the plan allowed the fallback of a code block:

- The web view is in the accessibility tree as `grouping 'Diagram: sequence diagram'` holding `document web` holding `image 'Diagram: sequence diagram'` (the page's own `role="img"` and `aria-label`). It is named, and one Tab stop at most (the page has nothing focusable, so Tab moves on).
- The **text alternative is the source**: `Show source` toggles it under the diagram (an `Editor`, read only, copyable), and the label above is a heading `Diagram: <title>` (`diagramTitle`: front-matter title, a `title` line, else the kind). `Open diagram` shows it larger in a dialog.
- A source mermaid cannot draw stays text with one line saying why (`Couldn't draw this diagram · … · showing the source`): a wrong diagram never replaces readable text.
- **No network.** The page's policy (`diagramPage`) is `default-src 'none'` with the one script origin and inline script and style, `securityLevel: "strict"`; the source reaches the page as escaped text, never as script (`mermaid.test.ts` has the injection test). The script (`assets/mermaid.min.js`, 11.12.0, MIT, `NOTICE`) is served once from a loopback listener of this process (`Diagrams.origin`: `GET /mermaid.min.js` and nothing else, `127.0.0.1` only) because a web view may load `http` addresses of the hosts `nsh.json` lists and not `file:` ones; the web view's cache then serves every later diagram.
- Cost: one web view per diagram on screen (they exist only while a document with diagrams is open). A diagram taller than 360 pt scrolls inside its frame; `Open diagram` gives 480.

## Send a file

Files dropped on a pane tab (`onFileDrop`, shown by a dashed `Drop to send to <machine>: <folder>` while dragging) open `SendFiles`: the folder (the pane's, editable, must be a folder on the machine) and `Send`. **Nothing is sent before `Send`.** A name that is already there is never overwritten: that file's row says `A file with this name is already there` and offers `Replace` or `Skip`. Rows show `4 KB of 12 MB` with a bar, `Stop` while running, and say what happened; a stopped or failed upload leaves nothing behind (the data goes to a hidden `.name.herdr-part` next to the destination and moves with an atomic link only when whole). Only files from this computer are accepted (`Files.pathFromUri`); anything else is refused with a sentence. Folders are not sent.

## Pages from a machine

A `http://localhost:5173` link in a pane of a **remote** machine opens `WebPage`: `Pages.open` forwards a free port of `127.0.0.1` to the machine's `localhost` port over its shared ssh connection (`ssh -O forward`, bound to the loopback address only), the dialog shows `127.0.0.1:<port>` and says so (`through ssh, only from this computer`), `Back`, `Reload`, `Copy link` (the address on the machine), `Open in browser` (the tunnelled address, works while the dialog stays open). Closing removes the forward (`-O cancel`); an app that is closed takes the connection with it. On **this** computer a localhost link opens in the browser (`routeLink`): there is nothing to tunnel. The web view may show `127.0.0.1` only (`capabilities.webview.hosts` in `nsh.json`), so a link out of the page goes nowhere by itself; failures say why (`Couldn't open this page`, `Try again`).

## Machines other than this one

`RemoteFiles` runs `fs.py` (`ls`, `stat`, `read`, `put`, `commit`, `discard`) through the machine's `SshClient`, so no new login and no SFTP stack; it needs `python3` on the machine and says so when it is missing. Every path is validated (`validate_path`: absolute or `~/`, no NUL, at most 4096 bytes) and travels as one argument that the generated command quotes with `shq`; `files.rs` tests run hostile names (`$(…)`, backticks, newlines, `; touch`) through the real quoting and find nothing executed.
