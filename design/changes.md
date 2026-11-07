# Changes

The Changes tab (`components/changes.tsx`) is where a person reads what the agents changed in a checkout, answers it, and takes a change back. It is a dock tab of the project (`changes:<machine>/<folder>`, `changesKey` in `lib/dock.ts`), opened by `Review changes` (`mod+shift+g`, `reviewChanges` in `lib/changes.ts`), which means the checkout of the focused tab, else of the project in view.

## What it shows

- **Left, the files** (`ChangesList`): a filter and the changed files in groups, in this order: `Merge conflicts`, `Modified`, `Added`, `Deleted`, `Renamed`, `Untracked` (`SECTIONS`). A heading folds its group. A row is the name, the folder in grey, `+12 −3` as words and a check once reviewed; its accessible name is `src/auth.ts, modified, +12 −3, reviewed` (`fileLabel`). The list is a virtual `List`: 500 files draw a screenful.
- **Right, the change** (`ChangesDiff`): the selected file as a `DiffBlock` (highlighted, words that changed marked, unchanged stretches folded, unified or split by `diffSplit`), a row of what can be done, the notes written on the file and the one being written. A binary file, a file with merge conflicts, a nested repository and a file whose only change is its mode each say so instead of drawing nothing.
- **A very big change** opens cut at 6,000 lines (`DIFF_LINES`) and says so; `Show all` lifts it to 200,000 and 32 MB. The 20 MB case is cut where git runs, not here.
- **Narrow windows** (`narrow()`) show the list or the change, one at a time, with `Back to the files`.
- **Calm**: no signal colour (a change is `+`/`−` in its own column, never only a tint), nothing moves at rest, and nothing is drawn for a tab that is not in front.

## Reading git

All of it is `herdr_core::git` (`native/core/src/git`), reached through the `Git` module (`native/app/src/git.rs`). The rules are in its module doc and each has a test in `native/core/tests/git.rs`:

1. **A read takes no lock the agent could collide with.** `status` runs with `GIT_OPTIONAL_LOCKS=0`; tracked patches use `diff-index`, because the porcelain `diff` rewrites the index (and takes `index.lock`) when a timestamp moved.
2. **A repository's own config runs nothing**: no fsmonitor, textconv or external diff; paths are literal (`GIT_LITERAL_PATHSPECS`), so a file called `*` is a file.
3. **Output is bounded where git runs** (locally by killing our own child by PID, remotely inside `git.py`).
4. **A remote machine** runs `git.py` over the machine's shared ssh connection: every path is one argument, validated by `validate_dir` and `validate_rel` first.

The tab reads when it comes to the front, every `POLL_MS` (5 s, stretched to four times a slow read) while it is in front and the window is `active`, and `TURN_MS` after an agent of the checkout changes state. A hidden tab, or a window that is away, reads nothing.

## Reviewing

- `j` and `k` move between files (Up and Down too while the list has the keyboard), `n` and `p` between the changes of a file, `Enter` shows more unchanged lines (3, 12, the whole file: `CONTEXTS`), `x` marks the file reviewed, `r` reads again, `c` writes a note on the change in view.
- **Reviewed** marks are saved per checkout (`changes.reviewed.v1` in the settings file) against the file's `fingerprint`, a hash of its working-tree content: an edit since, even one that keeps the line counts, takes the mark back.
- **A note** is on a group of changed lines (the unit `n` and `p` step through: the diff view reports no finer focus), one per group. It is kept with its `path:line`, the changed lines it is about and the person's words. Notes live in memory for as long as the app runs, per tab, so a project switch keeps them.

## Sending notes to the agent

`mod+Enter` opens a preview (`SendNotes`) with the whole message, exactly as the agent will get it (`notesMessage`: a line saying what it is, then per note `path:line`, the quoted lines, the words), and the agent to send it to: a radio group when several work in the checkout, nothing chosen until the person chooses. `Send` is the only thing that sends. A chat goes through `Sessions.send`, a terminal agent through `Herdr.sendInput`; a terminal agent that is waiting on a question is listed and cannot be chosen, because text typed there would answer it. With no agent in the folder the message can be copied. A note on a file that changed after it was written says so.

## Taking a change back

`Revert this file…` and `Revert this change…` (the file's menu) go through `confirmDestructive` that names what is lost, then `Git.revertFile` or `Git.revertGroup`, then a toast with `Undo`. Before anything is removed its patch is saved for ten minutes (`UndoStore`); a change too big to save (`BACKUP_CAP`) is refused. A change is reverted only if the diff is still the one the person saw (`fingerprint`) and `git apply -R --check` accepts the reverse patch. A file with merge conflicts, a new or deleted file (as a piece) and another repository are refused with the reason. The revert is on the working tree and the index of that file; the app never stages or commits.

## Accessibility

The list is `Changed files`; each file's change is a group named `Change to <path>`; the diff is named by `diffLabel`. Selecting a file, adding or removing a note, marking reviewed, a revert and a refresh each announce. A field that closes gives the keyboard back to `Add note`. Every control has a name and a key hint.

## Tests

`lib/changes.test.ts` (the rules), `components/changes.test.tsx` (the tab against a repository the test seam builds with the real git: `Git.testRepo`, `testWrite`, `testRead`), `native/core/tests/git.rs` (git itself, locally and through `git.py`).
