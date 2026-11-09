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

- Opens where a word could start (`mentionAt`: start, after whitespace, a bracket or a quote; `me@host` is an address). The list is an `Overlay` hung from the box's top edge at the box's width and drawn as the box's own top (`ComposerPicker`), so nothing moves when it opens. It opens at once, with no entrance: a key opens it, and a list a keyboard opens never animates.
- Rust ranks (`Compose.mentions`): files and folders from the quick-open index, words all match, name beats path, a hot file (mentioned lately: `lib/mention.ts` `recentFiles`; changed: `Git.status`) wins a near tie and never a poor match, one typo in a name is forgiven when fewer than 3 match, ignored files are never offered (an `.env` is not for a prompt). A bare `@` lists hot files, the top-level folders, then the newest files. Rows stay until the next answer arrives, so the list never flashes empty.
- Rows: a shape per kind (`fileGlyph`), the name with the matched letters bold, the folder muted (it fades first, the name never), a word (`changed`, `recent`) where lifted. Under the rows one fixed 24 pt line of keys. The highlighted row's preview (`Compose.peek`: name, size, first 12 lines in mono 12 pt, or the item count, or a thumbnail) is a 360 pt column inside the list behind a hairline when the box leaves the rows at least 320 pt (the list then is at least the preview's least height, `PEEK_MIN`), else a bubble beside the list as tall as it; either way a late answer fills it and moves nothing: the name and size on one muted line, then as many whole code lines as fit (`peekLines`), no blank area.
- Keys: Up and Down, Tab or Enter add, Right opens a folder, Escape closes and keeps the typed words. Moving says `src/main.rs, 2 of 8`; a new answer says `3 results, src/main.rs, 1 of 3`.
- `/` at the start opens the agent's commands in the same shell (`CommandList`): the commands, then the skills, each under a muted heading when both are there, the group of the best match first so the first row (what Enter picks) is still the best (`byKind`).

## Pictures

`mod+v` with a picture, a drop, or the file dialog (`+` menu, `attachFiles`, `mod+shift+o`) prepares the picture in Rust off the UI thread (`Compose.preparePicture`): turned upright, scaled to 1,568 px on the long side (what Claude's vision reads; Settings: original), all metadata dropped by the re-encode, aiming at 1 MB (`TARGET_BYTES`): a screenshot heavier than that as a PNG goes as a JPEG at quality 85, then 75, then smaller; transparency stays a PNG; the original setting only keeps the hard 5 MB cap. Why: a picture often crosses ssh to a remote machine (owner, 2026-11-08: "must compress"). Text wins a mixed clipboard. The strip shows 56 pt thumbnails with a cross, type and size on hover, and the name `Image 1 of 3, PNG, 1.2 MB`. Adding and removing are announced. A picture is never text in the box: a sentence cannot point at "#2" inline (the cost of not showing a second copy of what the strip shows); the order of the thumbnails is the order the agent gets them. Pictures leave the box when a send starts and come back with the words when it is refused, so a second Enter cannot send them twice.

An agent that cannot see (`SessionView.acceptsPictures`) gets its pictures as files, as herdr-mobile does, with nothing to read or press: the thumbnails look as they do for any agent, and Send first writes each picture to `.herdr-desktop/attachments/` on the session's machine (`Compose.saveToProject`, over ssh for a remote one), puts its `@path` at the end of the words, then sends. The folder ignores itself (`.herdr-desktop/.gitignore` holds `*`), so the project's own `.gitignore` is never asked to change. A picture that cannot be saved refuses the send and keeps the box as it was (owner, 2026-11-08: "when paste image, we want it just works"). Files of this computer for a remote session are sent first (`Send a file`), as before.

## The rest

- Grows to 12 lines (`COMPOSER_INPUT`) then scrolls. **Two tiers in one box** (owner, 2026-11-09, chosen from a rendered prototype): the words on top (pictures, chips, the field and an alert, all on the box's 12-pt text edge), then one row of controls inside the box (attach, the mode, the model, then the round button at the right). Nothing hangs under the box. A neutral hairline at rest (`border-border`, radius xl); the primary border appears only while the field has focus, and the box squares its top corners while a list is its top. The box says each thing once: the placeholder says how to start (`Ask anything · @ for files · / for commands`; `Ask anything` alone in a box under 320 pt, where the long one wrapped), and while the agent works it says where a message goes (`Queue a message`); the keys live in the keyboard sheet. Under the words, inside the box, a line only when there is an alert (a failure, up to three lines) or the typed command's arguments (the command, `takes`, what it takes). The field is one line high (28 pt, `COMPOSER_INPUT.min`) and grows with its text.
- Enter sends, Shift+Enter is a new line; Settings `enterNewline` turns it round (`mod+Enter` sends). Nothing sends while an input method composes.
- Up in an empty box brings the last message back, Down goes forward, Escape on a recalled message gives back the draft. Escape never clears the box (`mod+z` stays native). History is memory only.
- `quoteCopied` (`mod+shift+q`) quotes the copied text with `> `: nsh gives an app no way to read a selection out of the conversation.
- Drafts (words, files, chips) survive tab and project switches (`lib/view-state.ts`).

## Decided and built

Owner decisions of 2026-11-07.

- **Low at rest**: the field one line, growing with the text up to the limit above, and the controls' row under it inside the box. Why the second row (2026-11-09): with attach, mode and model beside the field or under the box the box had three text edges (chips, `+`, text) and a row outside its surface; the owner chose the two-tier box from a prototype.
- **Help is the placeholder, not a line** (owner, 2026-11-09, after a rendered prototype: "clean like Linear and the Claude app"). The line under the words holds only an alert or the command's arguments; where a message goes while the agent works is the placeholder, and that Escape stops the turn is the Stop button's tooltip (with `Esc`) and the keyboard sheet. Why: a note under the box repeated what the button already said, on every turn (`design/taste.md`, say it once).
- **Stop is a muted ring**: the same 32 pt round button with a hairline `border-border` edge, no fill, and a `foreground` square; Send stays filled `primary` when it can send and `muted` when it cannot. Why: while the agent works nothing needs the person, and a filled Stop was the loudest thing on screen (`design/taste.md`, hierarchy by subtraction; a blind critique of the render measured it).
- **A picture is a thumbnail and one inline notice, with no `[Image #n]` text** (see Pictures for the cost).
- **Popups never resize with the highlight** (owner, 2026-11-08: "preview in select causing jumping screen"). A list is whole 32 pt rows (a heading is a row too), at most 10 (`lib/composer-popup.ts`), hangs from the box's top edge (not the caret) at the box's width so only its top edge moves when the count changes; its keys are one fixed row under the rows. A command row says what it does on the row itself (the name, then the description muted and faded at the edge): no bubble, because a bubble that follows the highlight flickered as the keys ran through rows (owner, 2026-11-08).
- **Pin** is an icon in a reserved right slot of a command row (hover or focus-within; a pinned command shows its glyph at rest and leads the list, also for a typed word). While the list is open the placeholder is `Type to filter`.
- **The `+` menu** (`Attach`): `Add files or photos` (with the `attachFiles` key), the project's files, `Mention a file` (inserts `@`), `Slash commands` (inserts `/`, only in an empty box).
- **Pictures are 72 pt cards inside the box**, on its 12-pt text edge, the remove cross reserved at the card's top right and shown on hover or focus.

## Not here

A chip drawn inside the text (it would need nsh's rich editor, which documents no screen-reader text), audio, a folder of this computer for a remote session, picture bytes of a restored message (a restored picture is prepared again from its file).
