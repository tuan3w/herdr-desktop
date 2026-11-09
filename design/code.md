# Code

Code is the one thing in this app that people read closely for correctness, so it has one renderer and one palette. `CodeBlock` (`components/code-block.tsx`) draws text as code, `DiffBlock` (`components/diff-block.tsx`) draws a change, both over native views (`CodeView`, `CodeDiff`, `native/app/src/highlight/view`) whose colours come from the highlighter (`native/app/src/highlight/engine`: tree-sitter queries of ours, a TextMate fallback). nsh's own `TextView` code block, `Editor` and `DiffView` are not used for anything the person reads in a chat; the `Editor` stays as the viewer of a file over 512 KB (below).

## Where code is drawn

| Place | What | How |
|---|---|---|
| A fence in an agent message, a thought, a Markdown page | `CodeBlock` | `splitFences` (`lib/markdown-fences.ts`) cuts the Markdown at top-level fences: prose goes to `TextView`, each fence to its own block, keyed by position so a streamed message keeps every part's view |
| A fence inside a list item or a quote | `CodeBlock` | `TextView`'s `renderCodeBlock` hook; its fold state is its own |
| Inline code | `InlineCode`, `inlineCodeClasses` | a neutral chip (`bg-muted`, mono): never a colour, so a path in prose is not mistaken for a string literal |
| A tool call's command, input, output | `CodeBlock` with `compact` | no header row and no padding of its own; the command is shell, the rest is read from its text |
| An edit in a tool call, the edits a request would make | `DiffBlock` | the file name is a button (`Open <path>`) in the transcript |
| The permission dock's command | `CodeView` inside the dock's own `Scroll` | the dock's rule "read to the end before allowing" needs scroll and layout events a block does not give; `Read all` is a `CodeBlock` |
| A file in the viewer | `CodeBlock` | line numbers fixed on, the linked line marked and scrolled to, `mod+f` finds a line (`PaneFind`); above 512 KB `Editor` (a row per line is too many) |
| A sign-in command | `CodeBlock` with `tools={false}` | the card has its own `Copy command` |
| A board card's last 8 rows | plain `Text` | a preview of a terminal, not code |

Not here: `PaneScreen` (a terminal mirror has its own colours), the diagram source of `MermaidBlock` (an `Editor`).

Code is read on demand, not shown by default: a tool's command and output sit inside a folded step (`design/chat.md`) and appear when the person opens it. Why: a supervisor skims what happened and reads code only to check one thing, so a transcript of open blocks buries the answer.

Decided, not built yet (owner, 2026-11-07): a file opened from a path link in the chat opens in the inspector beside the conversation, not over it. The renderer and its rules do not change, only the place.

## The block

- Inside a step's card a block has no surface at all: the page's own colour in a hairline box, 8 pt radius (`flat` on `CodeBlock` and `DiffBlock`, native `CodeView` and `CodeDiff`; the Claude desktop app draws its commands and diffs so, owner 2026-11-09 "no background, white"). The edge fades follow it.
- A surface one shade off the page (`code-bg`), 8 pt radius, the language in the corner (`TypeScript`, or the fence's `title="…"`). On hover or keyboard focus (`CodeTools`, `components/code-tools.tsx`) two icon buttons appear over the corner with no fill at rest and no strip behind them: `Copy code` and `Code options`, a `...` menu of checks (`Wrap lines`, `Line numbers`). They stay in the accessibility tree and pressable; the copy icon becomes a check, named `Copied`, for 1.6 s and announces politely. The tooltip belongs to icon-only controls only; the kit places it below the control (not yet movable to the side). The options are in Settings > Look (`codeWrap`, `codeLineNumbers`, `codeWhitespace`, `diffSplit` in `lib/settings.ts`) and persist.
- Past 16 lines (`CODE_COLLAPSED_LINES`) it folds with a fade and `Show all N lines`; open, it scrolls inside itself at `CODE_MAX_HEIGHT`. The fold of a block in a chat row is a choice the model keeps by key (`SessionModel.chosen`), because the list recycles the cell that draws it. A block that is being written never folds and follows its end.
- A long line scrolls sideways with a fade at the edge that appears only when there is more, or wraps.
- Selection works across lines and across the whole message: `MarkdownText` is one selectable area, and the gutter and signs are not selectable.
- The group is named by `codeLabel` (`Code, TypeScript, 41 lines`) and holds the text of each line; the tools are named by what they do (`Code options`, `Copy code`, `Show all 41 lines`).
- Language: the fence's first word, else the path, else a shebang, else a sniff that fires only on near-certain shapes (a diff header, a JSON document of several lines, `<?php`, a `$ ` prompt). `text`, `plain`, `output` and `log` mean "do not colour", and a word nobody has a grammar for is plain: a wrong guess colours prose.
- A here-document in a shell block is read in the language of the program it feeds (`python3 - <<'EOF'`, `node`, `sqlite3`, `ruby`, `php`, `lua`, `sh`), or of the file `cat` or `tee` writes (`cat > run.py <<EOF`); for any other program (`git commit -F -`) its body stays a string (owner, 2026-11-10, a Python script in a command was one green string).
- Text goes through `safeCode` (`lib/visible-text.ts`): direction overrides and control characters become `‹U+202E›`, and everything else stays as written, because it is also what `Copy code` copies.

## Streaming

`MarkdownText` marks only the open fence `streaming`. It is a view of its own that follows its end, highlighted as it stands from the spans of what it grew from, so a chunk recolours the last lines and not the block; when the fence closes the finished block replaces it, starting at the top and folded. While the opening line is still being typed (no line break yet) the language is not read, so a half-typed word does not flash a label. `warmCode` compiles the usual grammars on a background thread at start so the first block of a language does not pay for it.

## Diffs

A change is `+`/`−` in a column of its own, a tint and a 2 pt bar on the line: three signals, because green and red tints are near the same luminance. Token text on a changed line keeps its syntax colours. Words that changed inside a line are on a stronger tint; a line that changed almost entirely gets none. Long unchanged stretches fold (`7 unchanged lines`, a button). The header says `+2 −1`; the group says `Diff of src/auth.ts, 2 added, 1 removed`; `Previous change` and `Next change` step through the groups and `Change 2 of 5` says where you are; the arrows and `Diff options` (`Side by side`, `Wrap lines`) are icons in the header that show on hover or focus. Side by side is `diffSplit`. A new file (`created`) is the exception: one number column and none of the three signals, as plain code (`layout="code"`, `DiffLayout::Code`), because every row saying "added" says nothing; the header says `new file` once. `showPath={false}` leaves the path out of the header for a screen that names the file already (Changes).

## Colour

Tokens are `code-*` (`lib/theme/code.ts`, generated into `theme.json`): one per `CODE_ROLES` entry plus the surfaces (`code-bg`, `code-line-bg`, `code-add-bg`, `code-remove-bg`, `code-hunk-bg`) and `code-gutter`. `nsh` classes cannot name them, so TSX writes `token("code-bg")` in `style`; Rust reads them from the theme, so a theme or appearance switch restyles without highlighting again.

- Identifiers stay the text colour; colour is for what is rare (strings, numbers, types, definitions, tags). Italics are off; the `CODE_MEDIUM` roles are Medium weight, a second channel next to colour.
- Every role reaches `CODE_MIN_CONTRAST` (4.5:1) on every surface it can sit on, punctuation `PUNCTUATION_MIN_CONTRAST` (3:1): `lib/theme/code-theme.test.ts` fails and names the pair.
- IBM Plex Mono, ligatures off: `!=` and `=>` must read as typed.

## Keyboard

`copyCode` (`mod+shift+c`) copies the block under the pointer or focus, else the last block of the last answer; `copyReply` (`mod+shift+y`) copies the last answer as Markdown. Both are in the palette and the shortcut list, and fire in the message box too (`always` in `lib/shortcuts.ts`: nsh gives a text field the copy chords unless a binding says otherwise).

## Rules

1. Never name a colour, a class string of the block, or its tools in a screen: use the component.
2. A new place that shows code uses `CodeBlock`; a reason not to goes in the table above.
3. Nothing in a recycled list cell keeps a block's state in a signal: pass `open` and `onOpenChange`.
4. Test what a person notices: the label, the copied text, the folded count, the streamed result equal to the whole.
