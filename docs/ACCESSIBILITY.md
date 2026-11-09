# Accessibility

herdr-desktop is accessible first: a screen reader user, a keyboard-only user, someone at 200% text size or with reduced motion supervises agents with the same confidence as anyone else. Each rule below is mechanical enough to check; `design/controls.md` holds the kit-level form of them, `make a11y` the automated gate (AT-SPI tree, no unnamed control) once the harness exists.

## Rules

1. **Every control has a name.** Text buttons carry their label; an icon-only control is `IconButton` with a required `label`; inputs carry `accessibilityLabel` (`Field` sets it); a `Switch` and an `ActionMenu` take a `label`. The name is the thing, never the role: `Close`, not `Close button`; the role comes from nsh's role list (`AccessibilityRole`: `button`, `checkbox`, `switch`, `tab`, `tablist`, `listbox`, `option`, `combobox`, `menuitem`, `radio`, `spinbutton`, `progressbar`, `row`, `header`, `region`, `group`, ...). A glyph (`✕`, `▾`) is never a name: use `Icon`.
2. **State is a state, not a colour.** `accessibilityState` carries `selected`, `expanded`, `checked`, `disabled`, `busy`; where nsh has no state (`required`, `invalid`, `read only`) the kit appends it to `accessibilityHint`. A pressed toggle is `checked` or `selected`, never only a darker fill.
3. **Colour is never the only signal.** Agent status is a shape first, then a word, then a colour:

   | Status | Shape | Word |
   |---|---|---|
   | needs you (`blocked`) | filled circle with a bar | `Needs you` |
   | working | half-filled circle | `Working` |
   | done | check | `Done` |
   | idle | no mark (its slot kept; the quiet state is the absence of a mark, owner 2026-11-09) | `Idle` (the row's name and tooltip) |
   | unknown | dashed ring | `Unknown` |

   An error is a red edge plus an icon plus text. The `Needs you` pill has a shape and text.
4. **Hit targets.** At least 24 x 24 css pt for a pointer (WCAG 2.2 AA, 2.5.8); 44 pt where touch is possible. A control drawn smaller keeps its target through padding or hit slop, so the compact switch and segmented control of Settings are small to the eye and not to the pointer; dense rows are 28 pt or more (sizes: `lib/layout.ts`).
5. **Focus is always visible** (`FOCUS_RING`, `FOCUS_RING_SIDEBAR`, `FOCUS_RING_INSET` from `components/kit/core.ts`, at least 3:1 against what it sits on: `lib/theme/theme.test.ts` checks the pairs). Tab order follows reading order; every popup, menu and dialog is left with Escape or its own close control; nothing traps the keyboard. A view cannot take the focus from code, so popups keep the focus on the trigger and move a highlight that is announced.
6. **Status is spoken.** `announce(message)` is polite, and on Linux that is all nsh 0.4.0 can do (see "No assertive announcement" below). It is for what happens away from the focus: a toast, a result count after a filter, a state change that is not blocking. Something that blocks the person (an agent needs an answer, a link failed for good) is announced and shown as a shape and a word, and the focus moves to the control that resolves it where a view can take it. Never announce on a timer or per output line: the opt-in `Announce agent output` setting speaks at most once per two seconds.
7. **Reduced motion.** `reduceMotion()` (from GTK's `gtk-enable-animations`) switches every transition off through `lib/motion.ts`; classes that move carry `motion-reduce:`. An app at rest draws nothing.
8. **Large text.** Layouts survive `fontScale()` 2.0 (from `gtk-xft-dpi`): nothing is clipped, nothing overlaps, rows grow, columns drop. A pane view scales its own font to fit and scrolls sideways rather than shrinking below a readable size.
9. **Contrast.** 4.5:1 for body text, 3:1 for UI components and focus rings, in all four themes and both appearances: `lib/theme/theme.test.ts` fails the build otherwise. Terminal colours (`term-*`) reach 4.5:1 on `term-bg` except the four remapped slots (black and bright black on dark panes, white and bright white on light ones), which the pane component moves to the nearest passing colour at render time.
10. **Keyboard first.** Every function has a key path. Drag has a command twin. Global shortcuts always carry `mod`, never `alt` (AltGr is Ctrl+Alt); `Escape` is never global, because agents need it so a program in a terminal can have it. They live once in `lib/shortcuts.ts`, are listed by `Ctrl+/` or `F1`, and `lib/shortcuts.test.ts` enforces the rules.

## What nsh gives on Linux (0.4.0)

- The backend is GTK 4: roles, labels, descriptions, values and states reach AT-SPI through `GtkAccessible`; `testID` is the widget name; `accessibilityElementsHidden` hides a subtree.
- Live regions are emulated with `gtk_accessible_announce`: `announce()` speaks, a changing region is not read by itself.
- **No assertive announcement (host limit, what was tried).** `announce(message)` has no priority argument and the Linux host sends it at GTK's `Medium` priority: `dbus-monitor` on the AT-SPI bus shows `org.a11y.atspi.Event.Object.Announcement` with `detail1` 1 (polite). `accessibilityLiveRegion="assertive"` would become GTK's `High` (`access.rs` `priority` in `nsh-platform-linux`), but it is an Android-only prop: nsh sends only the current platform's `android={{…}}` object (`docs/dev/js-modules.md`), so the Linux code never receives it. A view with `role="alert"` that mounts with its text does reach the tree as an `alert`, but an AT-SPI listener on `object:state-changed:showing`, `object:announcement` and `object:children-changed` saw no `showing` event for it (only a name change and `ChildrenChanged`), and `showing` of an alert is what Orca presents (`event_manager.py` lists `ALERT` in `showing_roles`). So nothing here interrupts a screen reader: a request or the sign-in card is a polite `announce`, plus the shape and word in the header (`Needs you`, `Sign in needed`). Revisit when nsh gives `announce` a priority or applies `accessibilityLiveRegion` on GTK.
- **Not supported:** `accessible` grouping (children stay separate elements) and custom `accessibilityActions` (GTK has none). Nothing may depend on either: a grouped name goes in the label of the container, an action is a real button.
- `Ctrl+Q` and `F11` cannot be bound (nsh reserves them). `AltGr` layouts type with Ctrl+Alt, hence rule 10.
- Environment signals come from GTK and the XDG settings portal: font scale, reduce motion, colour scheme, and AT-SPI's `ScreenReaderEnabled`.

## Decided, not built yet

Owner decisions of 2026-11-07 and the accessibility each one carries, so the cutover does not lose it. Unverified until built and run under `make a11y`.

- **The answer dock replaces the message box** while a request waits. It is a `group` with a name; the command is a code group read as written and never cut; the options are buttons named as the agent worded them, with keys 1 to 3 shown on them; the risky one arms for 4 s, is `selected` while armed and says why. The dock never takes the focus, a new request is announced once (polite) with the command's first line, and the line "Nothing is sent until you choose" is real text, not a placeholder. Why the box is gone: a focused text field next to a pending question invites an answer typed into the wrong place.
- **`mod+j` moves between waiting agents** and announces whose conversation opened. It never answers and never advances by itself after an answer.
- **A folded line is a `Disclosure`** (`expanded`), named by its text (`Read 8 files, ran 4 commands`). An effect or failure line is plain text whose word carries the meaning (`Pushed 4 commits`, `make perf-check failed`) plus an icon; colour is never the only signal. The one live line is announced at most once per two seconds and only with `Announce agent output`; a finished turn announces nothing of its own.
- **Settings in the main region** is a page with a nav named `Settings sections` whose current page is `selected`; every switch carries its row's label, every segmented control is a radio group with that label, and `Always on` is text, not a disabled switch. The sidebar stays in the tree and in the Tab order, so a waiting question is reachable from Settings.
- **A dialog is for a decision or a short form** (`design/dialogs.md`); what the person reads or browses is a region, so the screen reader's cursor is never inside a modal for a long read.

## Files, viewers, diagrams and pages

Checked against the AT-SPI tree of the `files`, `file-code`, `file-markdown`, `file-diagram`, `photo` and `send-files` scenarios (`make a11y`).

- **Browser.** The list is a listbox (`Command`); each row's name is the whole sentence (`notes.txt, file, 168 bytes, 4 min ago, no permission`), so a screen reader gets size, age and refusal without leaving the row. Every control has a name (`Up one folder`, `Folder`, `Folder options`, `Find in this folder`); a folder that cannot be opened is a panel with the reason and two buttons, not a silent empty list. Opening a folder announces `<name> folder, 6 items`; opening a file announces `<name>, read only` and any cut notice. Escape steps back one level.
- **Viewer.** A group named `<file>, read only` holds the code block (`Code, Rust, 27 lines`, one text per line); read-only text is selectable and copyable, nothing types into it, and `mod+f` opens the find bar (`Text to find in the file`, the count is announced `3 of 12`). A file over 512 KB is the read-only `Editor`, named the same. Binary says `Not a text file` with its size.
- **Pictures.** The file name is the alt text (`<name>, picture`); Left and Right and two named buttons walk the folder's pictures; `Photo 2 of 3` is announced on every step. The tools are named buttons and keys (`design/media.md`).
- **Video and sound.** Every control is named (Play or Pause, `Position`, `Volume`, Mute, Loop, Full screen); each state change is announced politely (`Playing`, `Paused`, `1:05 of 4:20`); nothing autoplays. Unverified with a screen reader.
- **Diagrams (decision with evidence).** A diagram is drawn in a web view and stays accessible: the tree has `grouping 'Diagram: <title>'` > `document web` > `image 'Diagram: <title>'`, a heading above it with the same words, and `Show source` / `Open diagram` buttons. The web view is one focusable stop; the page has no focusable element, so Tab leaves it (a trap is not observed; Orca is unverified). The **source is the text alternative**, one press away, read only and copyable. A diagram that cannot be drawn is shown as its source with the reason, announced as an alert. No colour carries meaning: the diagram's own labels are text.
- **Send a file.** A drop is the pointer's way in; the keyboard's is the same dialog's `Send` after the folder field, and a drop from a keyboard-only session does not exist, so nothing here is only reachable by dragging (`Browse files` shows the result). Progress is a `progressbar` with a value and a text (`4 KB of 12 MB`); the result is a sentence in the row and an announcement (`Sent 2 files`). `Replace` is a separate, named button per file and never the default.
- **Pages and the side panel.** The panel is a region named `Opened link`. A file's or a picture's title is a header named by the title and the whole path (also its tooltip). A page's line is a toolbar `Page controls`: `Back`, `Forward`, `Reload` or `Stop loading`, the `Address` field (its hint is the page's title), `Copy link`, `Open in browser`, `Close`; a control that cannot act is disabled, not hidden. `Page <address>` names the web view; the loading line is a busy `progressbar` named `Loading <host>`; a failure says `Couldn't load <host>` with `Try again` and is announced. A short link's mark is a link named by the whole address; a thumbnail is a button `Picture <name> · <w> × <h>`.

## Agent session requests and dialogs

- **Permission dock.** A `group` named `Permission request`: the command is a code group (`Code, Shell, 3 lines`: selectable, read as written, invisible characters shown as `‹U+202E›`), the answers a `group` named `Answers`. An answer is a button named exactly as the agent worded it; a risky one is spoken as needing a second press, and once armed is `selected` and named `<label>. Press again to send, <reason>`. A refusal is on the button (`The request changed`) and announced. A new request is announced with its command's first line; the focus is never moved and the digits 1 to 9 answer only while an answer has the focus. A long command says `More below · N lines`; `Read all` opens the whole text.
- **Sign-in card.** A `group` named `Sign in to <agent>` replaces the conversation and the message box while the agent refuses the session. Its title is a heading inside an `alert` and is announced politely when the card appears (`<Agent> needs you to sign in`). Each way the app carries out is a button named as the agent names it, with the agent's description under it; the one that is running is named `<name>, busy` and the others are disabled. A way done in a terminal is a heading, the arguments (selectable text, quoted for a shell), `Copy command, <way>` and `I did it, try again`. A refusal is text in an `alert` under the buttons, which stay. The keyboard moves to the first button once when the tab is in front (`setAccessibilityFocus`, which is `grab_focus` on GTK: not verified with a real key press, the AT-SPI audit cannot see focus), and back to a button that was busy.
- **Question form.** A `group` named `Question from the agent`; every field has its label (a required one ends in `*`), its help and its error under it; radio groups and checkbox groups carry the field's label. `Accept` and `Decline` are disabled for 400 ms after the form appears; Enter submits only inside a text field.
- **New session, past sessions, details.** The first field of New session has the focus; a failed start is text with the reason and a next step, announced; probing is a spinner with words; an agent the machine lacks is a disabled option named `<label> (not installed)`. Past sessions rows are groups named `<title>, <agent>, <folder>, <age>`; Continue is named `Continue <title>`. Details end a session only after a confirm dialog, and show the keeper's refusal as text.

## The tab bar

- **A tab is a `page tab`** in a `page tab list`, named `<title>, <state>, tab 3 of 8` (`tabLabel`; the board and Changes have no state): the whole title even when the tab cuts it with an ellipsis. Its cross is hidden from the tree (`mod+w` and the palette close a tab) and is not a Tab stop. Checked on the AT-SPI tree of the `tabs-many` scenario (`make a11y`).
- **Not observed:** no Tab press reached a tab on GTK (twenty presses over three open tabs walked the sidebar, the page and the message box and never a tab), so a tab's focus ring (`FOCUS_RING_INSET`) cannot be seen; tabs are reached with `mod+shift+1`..`9`, `mod+j`, `mod+e` and the palette. Orca on the strip is unverified.

## Code in the chat

- **A block is a group** named `Code, <language>, N lines` (`codeLabel`; `Code, 3 lines` when the language is unknown) whose children are the text of each line, so arrow-key review reads the code as written. Its tools are real buttons named by what they do: `Wrap lines`, `Line numbers` (both `selected` when on), `Copy code`, and when it is folded `Show all N lines` / `Show fewer lines`. The tools are drawn on hover or keyboard focus and are always in the tree.
- **Copy** announces `Copied` politely and the button's name becomes `Copied` for 1.6 s. The shortcuts `Copy code` (`mod+shift+c`) and `Copy the agent's last answer` (`mod+shift+y`) toast and announce `Code copied` / `Answer copied`, or say `No code in the last answer`; they work from the message box.
- **A diff is a group** named `Diff of src/auth.ts, 2 added, 1 removed`. `Previous change` and `Next change` are buttons that move through the groups of changes and say `Change 2 of 5`; folded stretches are buttons (`Show 7 unchanged lines`). Colour is never the only signal: every changed line has `+` or `−` in a column of its own and a bar at its edge. In a tool row the file name is a button `Open <path>`.
- **Contrast** of every code role on every surface is a test (`lib/theme/code-theme.test.ts`: 4.5:1, punctuation 3:1). Reduced motion: a block's fold and fade do not animate.
- **Unverified:** how Orca reads a block's lines (the AT-SPI tree has them as text; the reading was not heard).

## Checks

| What | How |
|---|---|
| Names, roles, states | `nsh test` asserts `label:` selectors; end-to-end tests find controls only by accessibility label |
| Contrast | `lib/theme/theme.test.ts` (UI pairs and the terminal palette) |
| Shortcut rules | `lib/shortcuts.test.ts` |
| Keyboard behaviour of the kit | `components/*.test.tsx` drive the controls with `keyboard.press` |
| AT-SPI tree, no unnamed control | `make a11y`: `scripts/atspi_audit.py` opens every scenario of `.shots/scenarios.ts` in a real GTK window under Xvfb, reads the tree over AT-SPI, writes it to `.scratch/a11y/<scenario>.txt` and fails on a push button, toggle button, check box, radio button, menu item, page tab, combo box, slider, list item or text input with no name |
| Real screen reader | the Orca checklist below, by hand, with a display |

## Manual Orca checklist

Run with `orca` under a real session (`GTK_A11Y=atspi`, the default) before a release and after changing a screen's structure.

1. Start the app with Orca running: the window title is read, including the count in `(N) Herdr Desktop` when agents need you.
2. Tab through the window once: every stop is announced with a name and a role; no stop says `unlabelled`, `button` alone, or a glyph.
3. Open the command palette: the field and the result list are announced, the count is read, arrows move through results with their names, Enter runs one, Escape closes and the focus returns to where it was.
4. Board: each project is read as name, machine and what it needs (`2 need you, 1 working`); each agent as name, agent, status word, project, machine and age; the `Needs you` inbox comes first; reviewing an agent announces the change and an Undo. The rail of project tiles reads the same phrases, and a tile's popover lists the project's agents.
5. A blocking prompt: when an agent starts to need you, Orca announces `<agent> needs you: <question>` without moving the focus; the answer dock reads the exact option labels and the full command; a risky option says what pressing again will do before it sends.
6. Pane tab: the read-only view is a group named `Terminal, <agent> on <machine>`; rows are readable with the review keys; the header says `Read-only view`; the message box and `Stop` have names.
7. Sign-in card (an agent that wants a login, `chat-signin`): the group name is read, then the title, the buttons by the agent's own names with their descriptions, the arguments of a terminal way; `Copy command` copies them and says so; a refusal is read under the buttons.
8. Dialogs: the title is read on open, the focus lands inside, Tab cycles inside and Escape leaves.
9. At 200% text size (`gsettings set org.gnome.desktop.interface text-scaling-factor 2.0`) nothing is clipped; with animations off (`gsettings set org.gnome.desktop.interface enable-animations false`) nothing moves.
10. Switch all four themes in light and dark: focus ring and `Needs you` are visible in each.

## What the AT-SPI audit found about nsh 0.4.0 on GTK

- **Focus is not reported.** Only the menu bar's items carry the `FOCUSABLE` state; nsh's own controls never report `FOCUSED`, so a screen reader that follows `focus:` events (Orca) may not announce Tab moves. The keyboard itself works: real X key events (`--tabs 12 --keep` sends Tab through XTEST and photographs the window) move a visible focus ring. Orca behaviour is unverified until the manual checklist above has been run on a display.
- **The audit counts a showing button as a way in for the keyboard.** GTK buttons are Tab stops but carry no `FOCUSABLE` state, so a screen made only of buttons (the sign-in card) has no focusable element to find. `scripts/atspi_audit.py` accepts `button` for that rule. Its unnamed-control rule still lists `push button`, which at-spi 2.60 calls `button`: unnamed buttons are not flagged by the script, and the tree dumps in `.scratch/a11y/` are read by eye (finding, not yet fixed).
- **A text input is named by its group.** GTK shows `grouping 'Message payments review'` around an unnamed `text`; the audit accepts a text input inside a named group.
- **Controls nsh draws itself with no name.** `scripts/atspi_audit.py` allows these exact counts (`HOST_UNNAMED`) and fails on any other unnamed control: two buttons inside the read-only `Editor` of the code viewer (`file-code`), and the unchecked task-list box of rendered Markdown (`file-markdown`; a checked one is named `✓`). Both belong to nsh's `Editor`/`TextView`; a fix is an upstream one.
- **Dialogs are part of the frame's tree** (palette, settings, machines): no separate window to find.

## Keyboard-only walk-through

Everything below is covered by `App.test.tsx` (headless) except the answer chip, which the headless harness cannot reach with Tab; chips take the digits `1`..`9` while one has focus.

1. `Ctrl+J` focuses the next agent that needs you (a blocked one, longest waiting first) and opens its pane tab; `Ctrl+Shift+J` goes back.
2. The answer dock sits under the mirror. Tab reaches its chips; pressing one sends only if the question is still the one shown. A risky chip says `Press again to send` and arms for 4 s; the second press sends. Nothing is sent by `Enter` in an empty message box while the dock shows (`Pick an answer above`).
3. `Ctrl+2` puts the focus in the pane area, `Ctrl+0` in the sidebar, `Ctrl+1` shows the board, `Ctrl+Shift+1`..`9` select a tab, `Ctrl+W` closes a tab (never the pane).
4. `Ctrl+Shift+K` starts typing into the pane: a bar reads `Typing into <agent>` and the same keys leave it. `Escape` goes to the pane, it does not leave, and neither does any plain Ctrl chord (Ctrl+K reaches the pane here): `Ctrl+Shift+P` is the palette while typing.
5. `Ctrl+P` opens every action by name, `F1` or `Ctrl+/` lists the shortcuts.
6. `Ctrl+Tab` goes to the agent visited before this one and `Ctrl+Shift+Tab` to the previous project (taps: a second tap comes back), `Ctrl+[` and `Ctrl+]` go back and forward through the places visited by command, `Ctrl+Shift+[` and `Ctrl+Shift+]` step through the projects. `Ctrl+E` opens the Switcher over the places visited last: the highlight starts on the way back, `Ctrl+E` moves down, `Ctrl+Shift+E` up, `Enter` opens, `Escape` leaves things where they were; a screen reader hears each row whole with its place (`2 of 5`). Orca behaviour of the Switcher is unverified until run on a display.
