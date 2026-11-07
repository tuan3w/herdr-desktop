# Chat parts: the answer dock, questions, new session, past sessions, details

The parts of an agent session (a chat over ACP, `Sessions`) where a mistake costs something or a failure needs words. The transcript and the composer are elsewhere; these are what the chat tab places around them. The answer dock (`components/answer-dock.tsx`) serves a terminal agent's menu too (`design/pane.md`).

## The answer dock (`AnswerDock`, one for both sources)

One component answers a terminal agent's menu (`PromptView`, through its pane) and an ACP session's permission request (`WaitingView`, through its keeper). It takes an `Ask` (`lib/ask.ts`: `fromPrompt`, `fromWaiting`, `sessionAsk`), so the rules below are written once. It sits in the message box's place: a flat block with a hairline above it (`inline` drops that inside a card), shown while the first request of `SessionView.waiting` is a permission or a terminal prompt waits (a terminal agent's chat feeds it from the pane's prompt, `meta(machine, pane).prompt`, because its `waiting` holds only ask-tool forms). It shows what the agent wants to do, in full, and the agent's own answers.

| Part | Rule |
|---|---|
| Heading | What the call is (`Run a command`, `Edit a file`) from the tool kind, or the terminal question; the agent's title under it only when it says more than the command |
| Command box | The subject, through `visibleText` (invisible and bidi characters shown as `‹U+202E›`, runs of blank lines counted). Wrapped, monospace, selectable, never cut; eight rows, then it scrolls inside the box |
| `More below · N lines` | Shown while the end of the command has not been seen; `Show all N lines` lifts the cap inside the dock (the box grows to 24 rows, then scrolls) and counts as having read it; `Show fewer lines` folds it back |
| Before asking | ACP only: the last thing the agent wrote since the person spoke (three lines, the rest on hover), the edits of the call that waits (`PermissionDiff`: one unified diff per file with `+2 −1` as words) and the plan folded to its current step (`PlanSteps`) |
| Second look | The ACP `risk`, or the first reason among a terminal menu's options (`herdr_core::prompt`), with a warning glyph and the words. TSX decides nothing about risk |
| Answers | One chip per option, labelled exactly as the agent sent it, with its key (`1` to `3`, a quiet `Kbd`) unless the label already starts with it. Risky and rejecting are flags of the data (`AskOption.risky`, `reject`), never "the second one". A standing grant wears the warning glyph. With more than five, the last chip is `N more…` and opens every answer in place |
| `Decline and say this` | A quiet field that means deny and say this. It exists only when an option declines without risk (`reject`: `is_negative_reply` for a terminal menu, a `reject_*` kind for ACP) |
| `Cancel request` | ACP only: `Sessions.dismiss`; the agent hears cancelled |
| `Nothing is sent until you choose` | The footer line while nothing was said; it gives way to the last note |
| `N more waiting`, `Next` | Others still waiting. After an answer, `Next` visits the next agent that waits through the same function as `mod+j` (`onNext`); it never answers and the dock never moves on by itself |

**Where it stands.** In the chat (`SessionChat`) and the pane tab (`PaneTab`) the dock takes the message box's place: the box is not drawn while the dock or an ask-tool form (`SessionQuestion`) shows, so there is one place to act and no box to type into by mistake. The dock itself stays mounted for the tab's life, because it owns the `Answer sent` line (the note and `Next`) that outlives the question; that line sits above the box, which comes back in the same commit in which the question is gone (the pane's prompt cleared, the session's `waiting` empty). A draft, pictures and the queue survive the swap: the box keeps them in `lib/view-state.ts` and the session queue, and `session-mount.test.tsx` types a draft, lets a real question come and go and finds the draft. The dock never takes the focus by itself and `Next` (and `mod+j`) open an agent without focusing anything. `mod+2` with the dock showing says `Answer the question first. Tab moves to the answers.`: focusing the first answer needs a handle on the dock (unverified: nsh's `ViewRef.focus()` exists, not used yet).

Safety rules, each with a test in `answer-dock.test.tsx`:

1. **Nothing is sent by itself**, by default or on a timer.
2. **A press within 400 ms of a request appearing, changing or an overflow opening is ignored**, and the answers are dimmed meanwhile. The engine refuses an ACP one too (`tooSoon`, on its own clock).
3. **Every answer goes through `ask.send`**, which reads again and sends only if what was shown is still there (`Herdr.answer` with the digest, `Sessions.answerPermission` with the request and digest). A refusal (`changed`) says `The question changed` or `The request changed` on the button that was pressed and sends nothing; any other refusal is shown as the engine words it.
4. **Risky or standing is two presses.** The first arms the answer for 4 s and says why (`Press again to send · pushes to a remote · grants this permanently`), announced politely; the second sends. Focus stays on the button. Rejecting is never risky, except a permanent reject.
5. **An unread long command is read first.** The first press of an allow while the end was not reached scrolls to the end instead of sending (`Read it all, then press again.`); for a risky answer the same press also arms it. Rejecting needs no reading.
6. **The dock never takes the focus.** The digits 1 to 9 answer only while an answer has it (bound then, released with the focus).
7. **The reply never types into a menu.** It presses the decline through rule 3, and only when that reports `sent` does it type the words: into the session for ACP, and for a terminal only once herdr shows the question gone (up to 3 s, else the words stay unsent and the dock says so). If the question changed, neither is sent.
8. **A new request is announced** (`The agent asks: <first line of the command>`) when this dock is the place to answer; a card in the Board is silent. `announce` is polite only (`docs/ACCESSIBILITY.md`).

The timers are `restartable` (`lib/timer.ts`): one per owner, gone with it.

## The question form (`SessionQuestion`)

The first request when it is a question (an elicitation): the message, the schema's description, one control per field, then `Accept` and `Decline`.

- Field kinds: text and number (`Field`), choice (radio buttons up to five, else a `SelectField`), yes or no (radio buttons, 0 is yes), several of many (`CheckRow` each), unsupported (said, and the agent's default stands). A secret is shown like any other and the form says so.
- Validation is Rust's. `Sessions.answerQuestion` refuses a field that does not pass as `<label>: <why>`; `placeRefusal` puts the why under that field and the form stays as typed.
- Enter submits only from inside a text field. `Accept` and `Decline` are disabled for 400 ms after a form appears or changes, and Enter in a field is no way around that.
- What was typed is kept per session and request outside the component, so a permission that takes the dock does not blank the form; it is dropped once the session no longer waits on the question.

## New session (`NewSession`)

A `Modal` (wide: the first message has lines). Machine (enabled ones; a machine that is not connected is listed as such and cannot start), folder (an `Autocomplete` over the last folder, the folders of sessions the keeper holds and where agents run; `~/` is allowed), `Browse folders` (`FolderPicker`: folders only, one level at a time), agent, first message, `Past sessions`, `Cancel`, `Start` (Ctrl+Enter).

- Agents are what `Sessions.probe` says the machine runs; the ones the keeper knows but the machine lacks are listed dimmed `(not installed)` with a line naming them (`agentChoices`).
- A start that fails keeps everything typed and shows the keeper's words, then what to do next (`startFailure`: python3 missing, agent not installed, folder missing, agent failed to start, too many sessions, ssh down).
- The last agent and folder per machine are settings (`lastStart`, `rememberStart`). `project` fills the machine and folder.
- A first message waits for the session to open (a session still `connecting` refuses it); if it still cannot be sent the session is handed over anyway and a toast says so.
- `onStarted` runs after the dialog closed, for a started and for a continued session alike.

## Past sessions (`PastSessions`)

`Sessions.history`: title, folder, age and message count per row, `Continue` per row (`Sessions.resume`). The agent is fixed when the caller knows it, else chosen from the machine's. With a folder it starts there, with `All folders` to widen. An agent that cannot list, or cannot reload a conversation, says so instead of showing an empty list. Listing runs the agent for seconds: skeleton rows, and a failure keeps its reason with `Try again`.

## Details (`SessionOverview`)

A popover under the chat's title (the header's one control, `Session details`), not a dialog. It stays until the inspector replaces it. The facts:

Agent, machine, folder, session id (`Copy id`), state, context used (a `Progress`), every setting with its choices (`SessionOption`), the plan, `End session`. Ending asks first, and only for what the app may end: a session it started, or one whose agent exited. For any other the keeper's own refusal is shown as it is and nothing is confirmed. There is no copy of the transcript: the session API has none.

## Mode and model in the composer (`SessionModeChip`, `SessionModelPicker`)

Small selects for the composer's bottom row, from the session's options by category. A mode that lowers the guard (`lowersGuard`: its risk is higher than the current one) is two steps: picking it shows `Switch to Full access` and what it does for 4 s; the button switches. A mode that is risky now wears the warning glyph. The select is off while a turn runs.

## Decided, not built yet

Owner decisions of 2026-11-07 (prototype: the Herdr Desktop Lab artifact). Each is a cutover: migrate every caller and delete the old drawing in the same change.

- **The second option is the risky one and is two-step**: press, then press again within 4 s. The first press arms and says why; never a timed hold (holds are not accessible).
- **The sidebar row is the only attention mark.** The dock stays neutral and its one loud thing is the primary answer. Said once per agent per view (`design/attention.md`).
- **Answering many at once** is the Board's filtered view (select rows, answer with the count on the button), not this dock. Not built.
- **Details and past sessions are not dialogs.** The facts about the open agent (`SessionOverview`) are an inspector, a right panel; until it exists they are the popover under the title. Browsing past sessions (`PastSessions`) is a region. `NewSession` stays a dialog: it is a short form (`design/dialogs.md`).

## Accessibility

Each part is a `group` with a name (`Permission request`, `Question from the agent`, `Answers`, `Plan`). The armed answer is named `<label>. Press again to send, <reason>` and is `selected`. A refusal is both said on the button and announced. Everything works from the keyboard; no timer sends, none is a hold.

## Tests and labs

`components/chat-parts-lab.tsx` is the entry: `live` (a real keeper and the scripted ACP agent), `synthetic` (a made-up `SessionView` for states the scripted agent cannot reach; an answer is refused by the engine, which is how a test sees that a press went all the way) and the dialogs. Live tests end their sessions (`endSessions`). Screenshots: scenarios `permission`, `permission-armed`, `question`, `new-session`, `new-session-error`, `past-sessions`, `session-overview`.

## Effect classes of a tool call

`ToolItem.effect` (`{ kind: push | delete | install | publish | infra | other, text }`, from `tool_effect` in `herdr_core::prompt`) is the consequence a supervisor must hear after a turn. Only a completed command has one: a failed call is shown as a failure from its status and last `tail` line, and a push that did not finish did not push.

- **External effect** (shown): the kinds `command_risk` knows (pushes, deletes, publishes and merges, infrastructure, `DELETE` requests) and installs (`npm|pnpm|yarn|bun add|install|i`, `pip install`, `cargo install|add`, `brew|apt|apt-get install`, `gem install`, `go install`). A chain takes the most consequential kind in it: publish, push, infrastructure, delete, install.
- **Read-only** (read, search, think, fetch, `ls`, `cat`, `grep`, `git status|log|diff`) and **local write** (edit, move, build, test) have no effect and fold; TSX counts edits from `diffs`.
- **The text is built from the command.** It names a remote and a ref, a package or a count of files only when the command states them plainly; otherwise `Pushed to a remote`, `Deleted files`, `Installed packages`. A URL (it may hold a credential), a glob, a variable or a flag it does not know is never quoted.
- **How TSX shows it** (built): `buildRows` puts failures, then effects, then the edit total into one `effects` row after a finished turn (`design/chat.md`); an effect has an icon by kind (`push` upload, `delete` trash, `install` download, `publish` globe, `infra` monitor, `other` list).
- **When unsure there is no effect.** `--dry-run` (and `--check`, `git push -n`) is none; text inside quotes (`echo 'git push'`) is not a command; `bash -c '...'` is read through. A missed effect is a folded command, a false `Pushed` is a lie.
