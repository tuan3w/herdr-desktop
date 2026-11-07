# The chat tab

`components/session-tab.tsx` (`SessionTab`) and its parts: `session-header.tsx`, `session-transcript.tsx`, `session-item.tsx`, `session-tool.tsx`, `session-plan.tsx`, `session-activity.tsx`, `session-composer.tsx`, `session-queue.tsx`, `session-attach.tsx`, `session-signin.tsx`. The rules are in `lib/session.ts` (data and the model), `lib/session-rows.ts` (turns into rows), `lib/session-text.ts` (words), `lib/session-compose.ts` (the message box) and `lib/session-pictures.ts`; all pure ones have tests. The permission dock, question form, overview and the mode and model pickers are `design/chat-parts.md`. `session-tab.test.tsx` drives it through `session-lab.tsx`.

## What it is

The primary way to work with an agent: a conversation, not a terminal. One tab is either a keeper's ACP session (`id` is the keeper's) or a terminal agent read from its log (`id` is `pane:<paneId>`, with `Show terminal` one press away). The tab opens itself (`Sessions.attach` or `Sessions.observe`) and lets go when it closes; a session that cannot be opened says why and offers `Try again`, and `Continue` for one whose agent exited and kept its conversation. Top to bottom: `SessionHeader`, a banner when the connection is lost (`Reconnect`), `SessionActivity` (a terminal agent's subagents and background tasks), `SessionPlan`, the conversation, the open request (`PermissionDock` or `SessionQuestion`), `SessionComposer`.

## The conversation reads like a chat

- **You** are a rounded bubble on the right. **The agent** is Markdown on the page, never a bubble (`MarkdownText`: lists, tables, links through `openLink`, pictures as chips, and every fence a `CodeBlock`: highlighted, its language in the corner, `Copy code`, folded past 16 lines; `design/code.md`). Nothing is cut; an agent message is one selectable area (a drag crosses paragraphs, lists, code and tables, in the recycled list cell too), and every finished message has `Copy message`, which copies its whole Markdown. `copyReply` (`mod+shift+y`) copies the last answer and `copyCode` (`mod+shift+c`) the block under the pointer or else the last one of it, from anywhere in the tab, the message box included. A host that dies when a chat is replaced or closed is the allocator preloaded into the process, not the text view: `preload_guard` (`docs/upstream/nsh-selectable-textview-in-list.md`); the `chat-swap` scenario of `make shots` fails if the host dies again.
- **Work folds.** A run of tool calls and thoughts between two messages is one *group*: `Worked for 4s › 3 commands · 1 file changed`. The group the agent is working in is open while the turn runs (`Working · 6s`), every earlier one is folded, and the person's own choice wins either way. Narration between calls stays visible and splits the groups. Times come from what this window watched; a replayed turn says `Worked` and no time, because inventing one is lying.
- **A call is one quiet line**: the kind's icon, a verb and what it acted on in monospace (`Read src/main.rs`, `Edited CHANGELOG.md +6 −2`, `Running pnpm test`), a state shape (waiting dashed ring, running half ring, done a muted check, failed a cross). A press opens its details (`ToolDetails`): the command whole as shell, each edit as a `DiffBlock` (its file name a link to the file, `+2 −1`, changed words marked), the output (a few lines, `Show all N lines`, and `N lines not kept` where the machine dropped the middle), each in a quiet block of its own with `Copy code` on hover.
- **A subagent stands outside the fold** as its own bordered line (`SubagentRow`; a call of kind `task`, `subagent` or `agent`), because what it hands back is a result, not a step. A terminal agent's subagents and background tasks also have their own groups under the header (`SessionActivity`).
- **Thoughts** are one collapsed line (`Thought for 12s`) inside a group; a press opens them.
- **Notices** are quiet centred lines: `Earlier messages are no longer kept`, the app's notes, and the turn's summary (`Done in 41s · 1 file +3 −1`, in the failure colour when the turn ended on a failed call).
- Text from an agent goes through `visibleText`: direction overrides and control characters become `‹U+202E›`, because a command written backwards reads as another command.
- A kind of row the app does not know is a quiet generic line, never a crash.

## Signing in

An agent can refuse a session until the person signs in (`SessionView.phase` is `authRequired`, `acp.auth` lists the ways). `SessionSignin` then stands in for the conversation, the request docks and the message box, under the same header (`Sign in needed`): a calm full-width card, `<Agent> needs you to sign in`, and one block per way the agent offers.

- **A way the app carries out** is a button named as the agent names it, with the agent's description under it. It calls `Sessions.authenticate` (through the port, `SessionPort.authenticate`); while the agent decides the button is busy and the others wait. When the agent accepts, the session opens and the card goes.
- **A way done in a terminal** (`terminalArgs`) shows the arguments the agent gave, quoted for a shell (`shellLine`) in a `CodeBlock`, `Copy command` and `I did it, try again` (`Sessions.reopen`). The app never runs it, and nothing opens a browser or a terminal by itself. The agent's message does not carry its program name, so the line is the arguments only and the card says to start the agent's program with them.
- **A refusal or failure** is the agent's own words under the buttons, which stay; `I did it, try again` that finds the agent still asking says so. What was said lives in `createSignin` (per chat), because the card is gone while the agent reopens the session and comes back if it still wants a sign-in.
- The keyboard goes to the first button once, when the tab is in front, and back to a button that was busy when the answer arrives.
- **Not here:** a way that needs a URL (`AuthMethodView` has no URL: the card never invents one), and `Sign out` (`AcpView.canLogout` is exposed, the `Sessions` module has no logout call).

## Following the end

The list is bottom aligned and virtual: only the rows near the window exist, each reads its row and keeps no state (what is open lives in the model, by row key). It follows the end while the person is at the end (64 pt counts as at it). Scrolled away it holds still and a pill says what is new: `3 new messages`, `Needs you` while a request waits, else `Jump to latest`. Sending a message jumps to the end. PageUp and PageDown scroll a page from anywhere in the tab (also from the message box), Home and End when no text box has the focus. There is no `j`/`k`. Streaming rebuilds the last unit only (`createSessionModel` builds the rows before it once), so a 5,000-row conversation opens at its end and streams without a layout jump.

## The message box

A rounded card: text on top; under it `+` (attach), the mode chip and model picker (`session-config.tsx`), and one round button. It is `Send`, `Queue message` while the agent works, and `Stop` while a turn runs with nothing typed; a Stop that just appeared ignores presses for 400 ms so the second press of a double press on Send cannot stop the turn it started.

- Enter sends, Shift+Enter is a new line. While the agent works a send is queued; the queue shows above the box and its cross takes a message back into the box (`Take back`), so nothing is thrown away. A held queue says why and `Send now` lets it go.
- `/` at the start lists the agent's own commands (`SessionView.commands`); `@` lists files and folders of the session's folder over the caret, and pictures can be pasted or dropped: all of it is `design/composer.md`.
- Escape stops the turn only from the box, while a turn runs and no list or dialog wants it.
- Files: `+` opens the system file dialog or the machine's folder (`AttachPicker`), or drop files on the tab. The agent reads paths on its own machine, so a file of this computer for a remote session is first sent (`Send a file`).
- What was typed survives a refusal: it comes back with the reason. A message the agent refused comes back by itself.
- Off, the box says why (`Opening the session…`, `Session ended: …`, `Not connected…`).

## Accessibility

The conversation is a list named `Conversation`; every row is labelled `You: …`, `Agent: …` (first 200 characters), `Tool: Ran ls, done`, `Thought`, `Subagent: …`. Folds are buttons with `expanded` (`Disclosure`; a plain `Button` has `selected`, which would read as "selected"). When an agent message finishes its first 200 characters are announced politely, once; streamed text is announced only with `Announce agent output`, at most once per two seconds; a request that arrives is announced and the header's state word becomes an alert. The keyboard goes to the message box when the tab opens and nowhere else by itself (`mod+2` brings it back). Status is a shape first everywhere. The sign-in card is told politely when it appears and its title is an `alert`; nsh 0.4.0 has no assertive announcement (`docs/ACCESSIBILITY.md`). Not verifiable headless: announcements (`announce` cannot be read) and the look under a real renderer.

## Not here

Editing a message already sent, and a transcript search (`mod+f` belongs to the terminal mirror).
