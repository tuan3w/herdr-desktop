# The chat's message box

`components/session-composer.tsx` (`SessionComposer`) draws a model, `lib/composer.ts` (`createComposer`); the pure rules are `lib/composer-refs.ts` (tokens, chips, Up history) and `lib/mention.ts` (what `@` asks). The rest of the chat is `design/chat.md`.

## One native field, chips beside it

The text is one `Input` (IME, undo, the screen reader's text and the system paste stay native). Nothing is drawn inside it, so a file or a paste is a **token in the words** and a **chip above the box**; a picture is a thumbnail only:

| Thing | Token | Goes out as |
|---|---|---|
| file, folder | `@src/main.rs` (`@"my notes.md"`) | the words keep `@path`; a `resource_link`, or an embedded `resource` when the agent takes embedded context and the text file is at most 32 KB |
| picture | none (a thumbnail above the box) | the words as one text block, then for each picture in the order they were added (`outgoing` sorts by number; `attach.rs` `blocks` keeps file order) a text block `[Image #n]` and its `image` block; a `resource_link` for an agent that cannot see |
| long paste (over 5,000 characters) | `[Pasted text #1 +480 lines]` | the whole text in place of the token |

A file is inside the project when `relativeIn` says so: the project and the file's folder go through `Git.canonicalPath` first, so a link to the project (`/var/x` for `/private/var/x`) still gives a relative `@path`, and git's changed files are listed the same way. A remote machine's paths stay as given.

A chip is *active* while its token is in the words (`activeRefs`), a picture while it is in the box (it has no token: `refKey` tells pictures apart, `removeRef` takes one off): delete the words and a file chip goes, type them or undo and it is back. Backspace into a token takes all of it (`keepAtomic`). Taking a chip off removes its words (`withoutRef`). Numbers are never reused in one box. A chip is a button: a file opens in the viewer, a folder in the browser, a paste goes back into the box, a picture opens the viewer. Limits: 20 files and folders, 10 pictures (`Compose.limits`).

## `@`

- Opens where a word could start (`mentionAt`: start, after whitespace, a bracket or a quote; `me@host` is an address). The list is an `Overlay` hung over the caret (`ComposerPicker`), so nothing moves when it opens. It opens at once, with no entrance: a key opens it, and a list a keyboard opens never animates.
- Rust ranks (`Compose.mentions`): files and folders from the quick-open index, words all match, name beats path, a hot file (mentioned lately: `lib/mention.ts` `recentFiles`; changed: `Git.status`) wins a near tie and never a poor match, one typo in a name is forgiven when fewer than 3 match, ignored files are never offered (an `.env` is not for a prompt). A bare `@` lists hot files, the top-level folders, then the newest files. Rows stay until the next answer arrives, so the list never flashes empty.
- Rows: a shape per kind (`fileGlyph`), the name with the matched letters bold, the folder muted, a word (`changed`, `recent`) where lifted. Under the list: the highlighted row's first lines, a thumbnail or the item count (`Compose.peek`), and the keys.
- Keys: Up and Down, Tab or Enter add, Right opens a folder, Escape closes and keeps the typed words. Moving says `src/main.rs, 2 of 8`; a new answer says `3 results, src/main.rs, 1 of 3`.
- `/` at the start opens the agent's commands in the same shell (`CommandList`).

## Pictures

`mod+v` with a picture, a drop, or the file dialog (`+` menu, `attachFiles`, `mod+shift+o`) prepares the picture in Rust off the UI thread (`Compose.preparePicture`): turned upright, scaled to 2,000 px on the long side (Settings: original), all metadata dropped by the re-encode, at most 5 MB (a photograph stays a JPEG, transparency stays a PNG). Text wins a mixed clipboard. The strip shows 56 pt thumbnails with a cross, type and size on hover, and the name `Image 1 of 3, PNG, 1.2 MB`. Adding and removing are announced. A picture is never text in the box: a sentence cannot point at "#2" inline (the cost of not showing a second copy of what the strip shows); the order of the thumbnails is the order the agent gets them. Pictures leave the box when a send starts and come back with the words when it is refused, so a second Enter cannot send them twice.

An agent that cannot see (`SessionView.acceptsPictures`) is told on the thumbnails (dashed edge and a line under them) and `Save to the project and mention the path` writes the file to `.herdr-desktop/attachments/` on the session's machine (`Compose.saveToProject`, over ssh for a remote one), once warns about `.gitignore`, and swaps each picture for an `@path` at the end of the words. Without it a send is refused for another machine's agent and is a link for this computer's: never silently dropped. Files of this computer for a remote session are sent first (`Send a file`), as before.

## The rest

- Grows to 12 lines (`COMPOSER_INPUT`) then scrolls. One calm focus border. Help is one status line in the bottom row of the box, between the mode and the model (error, command arguments, what a send will do, or the keys on focus): one line cut with an ellipsis, an error up to three. The field is one line high (28 pt, `COMPOSER_INPUT.min`) and grows with its text.
- Enter sends, Shift+Enter is a new line; Settings `enterNewline` turns it round (`mod+Enter` sends). Nothing sends while an input method composes.
- Up in an empty box brings the last message back, Down goes forward, Escape on a recalled message gives back the draft. Escape never clears the box (`mod+z` stays native). History is memory only.
- `quoteCopied` (`mod+shift+q`) quotes the copied text with `> `: nsh gives an app no way to read a selection out of the conversation.
- Drafts (words, files, chips) survive tab and project switches (`lib/view-state.ts`).

## Decided and built

Owner decisions of 2026-11-07.

- **One line high at rest**, growing with the text up to the limit above. Under the field one row: attach, the mode, the help line, the model and the send button. Why: a box several lines tall for one line of text takes the conversation's room all day.
- **Help text lives inside the box**, in that row, never as a line outside it. Why: text outside the card reads as part of the page and is cut off first when the window is short.
- **A picture is a thumbnail and one inline notice, with no `[Image #n]` text** (see Pictures for the cost).
- **The slash menu says what the highlighted command does in full**, in a footer of fixed height under the rows (`CommandFooter`, two lines), not in a hover: the rows stay one line and 32 high, so the list never changes size and the reveal arithmetic holds. A bare name (`btw`) cannot be judged without trying it, and a hover is unreachable from the keyboard.

## Not here

A chip drawn inside the text (it would need nsh's rich editor, which documents no screen-reader text), audio, a folder of this computer for a remote session, picture bytes of a restored message (a restored picture is prepared again from its file).
