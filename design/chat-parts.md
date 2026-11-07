# Chat parts: the permission dock, questions, new session, past sessions, details

The parts of an agent session (a chat over ACP, `Sessions`) where a mistake costs something or a failure needs words. The transcript and the composer are elsewhere; these are what the chat tab places around them. Every rule here is the same rule as the terminal prompt's answer dock (`design/pane.md`, `components/answer-dock.tsx`), adapted to what a session offers.

## The permission dock (`PermissionDock`)

Above the composer while the first request of `SessionView.waiting` is a permission. It shows what the agent wants to do, in full, and the agent's own answers.

| Part | Rule |
|---|---|
| Heading | What the call is (`Run a command`, `Edit a file`) from the tool kind; the agent's title under it only when it says more than the command |
| Command box | `WaitingView.subject`, else the title, through `visibleText` (invisible and bidi characters shown as `‹U+202E›`, runs of blank lines counted). Wrapped, monospace, selectable, never cut; eight rows, then it scrolls inside the box |
| `More below · N lines` | Shown while the end of the command has not been seen; `Read all` opens the whole text in a dialog and counts as having read it |
| Before asking | The last thing the agent wrote since the person spoke (three lines, the rest on hover), the edits of the call that waits (`PermissionDiff`: one unified diff per file with `+2 −1` as words) and the plan folded to its current step (`PlanSteps`) |
| Second look | `WaitingView.risk` (the same rules as the terminal prompts, `herdr_core::prompt`), with a warning glyph and the words. TSX decides nothing about risk |
| Answers | One `AskChip` per `PermissionChoiceView`, labelled exactly as the agent sent it. A standing grant (`PermissionChoiceView.standing`) wears the warning glyph |
| `Cancel request` | `Sessions.dismiss`: the agent hears cancelled |
| `N more waiting` | Requests behind this one; only the first can be answered |

Safety rules, each with a test in `permission-dock.test.tsx`:

1. **Nothing is sent by itself**, by default or on a timer.
2. **A press within 400 ms of a request appearing or changing is ignored**, and the answers are dimmed meanwhile. The engine refuses it too (`tooSoon`, on its own clock).
3. **Every answer goes through `Sessions.answerPermission`** with the request and digest on screen. A refusal (`changed`: it was answered elsewhere or the request moved on) says `The request changed` on the button that was pressed and sends nothing; any other refusal is shown as the engine words it.
4. **Risky or standing is two presses.** The first arms the answer for 4 s and says why (`Press again to send · pushes to a remote · grants this permanently`), announced politely; the second sends. Focus stays on the button. Rejecting is never risky, except a permanent reject.
5. **An unread long command is read first.** The first press of an allow while the end was not reached scrolls to the end instead of sending (`Read it all, then press again.`); for a risky answer the same press also arms it. Rejecting needs no reading.
6. **The dock never takes the focus.** The digits 1 to 9 answer only while an answer has it (bound then, released with the focus).
7. **A new request is announced** (`The agent asks: <first line of the command>`). `announce` is polite only (`docs/ACCESSIBILITY.md`).

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

Agent, machine, folder, session id (`Copy id`), state, context used (a `Progress`), every setting with its choices (`SessionOption`), the plan, `End session`. Ending asks first, and only for what the app may end: a session it started, or one whose agent exited. For any other the keeper's own refusal is shown as it is and nothing is confirmed. There is no copy of the transcript: the session API has none.

## Mode and model in the composer (`SessionModeChip`, `SessionModelPicker`)

Small selects for the composer's bottom row, from the session's options by category. A mode that lowers the guard (`lowersGuard`: its risk is higher than the current one) is two steps: picking it shows `Switch to Full access` and what it does for 4 s; the button switches. A mode that is risky now wears the warning glyph. The select is off while a turn runs.

## Decided, not built yet

Owner decisions of 2026-11-07 (prototype: the Herdr Desktop Lab artifact). Each is a cutover: migrate every caller and delete the old drawing in the same change.

- **One answer dock, in the composer's place.** A question is answered in the agent's own conversation, so there is no second list to answer from. The dock replaces the message box while a request waits and shows: the whole command (never cut), the risk line, three options with the keys 1 to 3, a line "Nothing is sent until you choose", and a quiet reply field for "tell it what to do instead". Why one place: two ways to answer is a second set of safety rules to keep equal. Today the permission dock sits above the box and the digits answer only while an answer has the focus.
- **The second option is the risky one and is two-step**: press, then press again within 4 s. The first press arms and says why; never a timed hold (holds are not accessible).
- **The sidebar row is the only attention mark.** The dock stays neutral and its one loud thing is the primary answer. Said once per agent per view (`design/attention.md`).
- **Moving between waiting agents.** `nextAttention` (`mod+j`) opens the next agent that waits, in any project. It never answers and never advances by itself after an answer, so nothing slides under the hand. After an answer the dock says how many still wait and offers Next. Answering many at once is the Board's filtered view (select rows, answer with the count on the button), not this dock.
- **Details, past sessions and `Read all` are not dialogs.** Facts about the open agent (`SessionOverview`: machine, folder, context used, settings, plan) are an inspector. Browsing past sessions (`PastSessions`) is a region, and reading a long command whole is the dock's own scroll. `NewSession` stays a dialog: it is a short form (`design/dialogs.md`).

## Accessibility

Each part is a `group` with a name (`Permission request`, `Question from the agent`, `Answers`, `Plan`). The armed answer is named `<label>. Press again to send, <reason>` and is `selected`. A refusal is both said on the button and announced. Everything works from the keyboard; no timer sends, none is a hold.

## Tests and labs

`components/chat-parts-lab.tsx` is the entry: `live` (a real keeper and the scripted ACP agent), `synthetic` (a made-up `SessionView` for states the scripted agent cannot reach; an answer is refused by the engine, which is how a test sees that a press went all the way) and the dialogs. Live tests end their sessions (`endSessions`). Screenshots: scenarios `permission`, `permission-armed`, `question`, `new-session`, `new-session-error`, `past-sessions`, `session-overview`.
