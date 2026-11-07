# Forms and dialogs

Fields live in `components/kit/fields.tsx` (`NumberField` in `number-field.tsx`), the dialog in `components/kit/modal.tsx`.

## Which field

| Need | Component |
|---|---|
| free text, one line or `multiline` (`tall`: a long prompt, not a note) | `Field` |
| a password or secret | `Field masked` |
| an address (the address keyboard, no capital, no autocorrect) | `Field address` |
| an identifier (pane id, path, command, host name) | `Field mono` |
| a number (a port, a count, a size) | `NumberField` (`design/inputs.md`) |
| one of a short fixed set (under about 8) | `SelectField` (`small` = the 28pt dense size, as on `Btn`) |
| one of a long or growing set, found by typing | `Combobox` (machine, workspace) |
| text that has likely values: names, paths | `Autocomplete` (host names, working directories) |
| search a list | `SearchField` (icon, clear button) |

`SelectField` is the kit menu's surface (`select.tsx`) with the value ticked: the trigger keeps the keyboard focus, so its ring stays after a choice; Return, Space or Down open it on the value, letters find an option. A `Combobox` is one input: it keeps the focus too, so the ring stays on the field after a pick. A view cannot be focused from code, so a design that moves focus into a popup would lose the ring when it closes.

Use `SelectField` for a short fixed set, `Combobox` once scrolling a menu is slower than typing, `Autocomplete` when the value may be new, `Field` for free text. Do not offer free text for a value with five known options.

**One row, one height.** Controls that share a row share a height: all 32pt, or all `small` (28pt) in a dense row (a prompt box, a dense row, a state select beside an `ActionMenu`). A toolbar of a `SearchField`, a `SelectField` and a `Segmented` is 32pt across; a `small` select beside a default search box is a bug. The prop is `small` everywhere (`Btn`, `SelectField`, `Combobox`); `compact` is only a window width.

## Suggestions and long lists

`Combobox` and `Autocomplete` share one list (`ListPopup` in `components/kit/combo.tsx`, rules in `design/combobox.md`): rows of a title and an optional muted `hint` that is also searched; matching ignores case and accents, needs every word, and puts titles that start with the first word first.

| | `Combobox` | `Autocomplete` |
|---|---|---|
| value | always one of `items` | whatever is typed |
| looks like | a `Field` that shows the chosen title, with a chevron | a `Field` whose list drops under it |
| first row | the chosen one (else the first) is highlighted: Enter picks it | none highlighted: Enter submits the form as typed |
| opens | a press that focuses it, the chevron, typing, or Down | typing, or Down in a focused field |
| closes | pick, Escape (the chosen title comes back), outside press, leaving the field | pick, Escape, outside press, leaving the field |

- Up and Down move the highlight (kept in view) and work while the input keeps the focus; Enter picks the highlighted row. The pointer moves the highlight too; a press picks.
- Names for screen readers: the `Combobox` button and both inputs are `combobox` (the button and the `Autocomplete` input say whether the list is expanded); the list is named with its count (`3 results`); a row says its title, its hint, `selected` when it is the value and `disabled` when it is; the highlighted row is `selected`. The focus stays in the input, so the highlight is how a reader follows Up and Down.
- `Autocomplete` takes `suggestions` (strings, or `{ text, hint }`) and `onPick` for what a pick implies: a known machine fills the host if it is empty.
- A suggestion equal to what is typed is not shown. No match shows nothing in an `Autocomplete` and `No results` in a `Combobox`.
- `limit` keeps the best matches and the list ends with `N more results: type to filter.`; typing narrows it. Rows with a `hint` get a 360pt list (`HINT_WIDTH`), not the field's width, so the hint has room; what still does not fit is a `Clipped`.
- Found on the host: an `autoFocus` input inside a popup closed it at once, and a click on an input reaches only its `onFocus` (a wrapper never hears `onPress`, a second click on a focused field says nothing). So `Combobox` opens on focus when the pointer is over the field (`onMouseEnter`), not when Tab arrives. Pressing a row or the chevron blurs the input first, so both wait 120ms before closing on blur and skip it while a row is held. Only the newest binding of a key runs and it consumes the key: Down is bound by `openOnDown` only while its field is focused and closed. A `Popover` makes its trigger a Tab stop of its own, so the lists of `Combobox` and `Autocomplete` hang from a `Positioner` against the field and their rows are `focusable={false}`: one Tab moves from field to field. `SelectField` and `ActionMenu` bind no Tab either: the trigger's blur closes the list (`closeOnBlur`), so Tab moves on in one press.

## Labels and names

- Every field has a visible label above it (`Labeled`). `Field` also sets `accessibilityLabel` from the label, so a test or a screen reader finds it as `label:Machine *`.
- A placeholder is an example or a format, never the label (`Name or host` under `Machine *`). A field whose heading is a `SectionTitle` right above it passes `label=""` and a placeholder (a notes box); the placeholder becomes its accessible name.
- A bare `Input` in an add-row (a list of paths or hosts) uses `INPUT_CLASS` and sets its own `accessibilityLabel`. A value that cannot be read is not dropped: the row reports it under the input (`Labeled errorInLabel`, announced) and adds nothing until it is fixed or emptied.

## Validation

Validate on blur or on submit, never on the first keystroke. Once an error shows, clear it the moment it is fixed.

- An error is three signals: red border (`border-destructive`), the `alert` icon, and the message, under its field, never in a summary. `Labeled` draws the icon and message when you pass `error`.
- `reserve` keeps the message line's height (16pt) when empty, so a required field in a dialog does not shift the dialog when its error appears. Use it for any field whose error can appear after layout is settled.
- Dialog pattern: a signal (called attempted here) turns true on blur or on a submit attempt; `error` is `attempted() && missing() ? "Choose a machine to start the agent." : undefined`.
- `errorInLabel` puts the message on the label line instead of below the field: below it, the extra line pushes its input out of line in a row of bottom-aligned fields.
- The primary button of a form is `disabled` while the form cannot be submitted, and the first field says why once the user tries (Enter on an empty machine shows the error).

```tsx
// Correct
<Field autoFocus label="Machine *" reserve value={draft().machine} onChange={...} onSubmit={start}
  onBlur={() => attempted.set(true)} error={attempted() && missingMachine() ? "Choose a machine to start the agent." : undefined} />

// Incorrect: error on the first keystroke, summary at the top, color-only
<Text class="text-destructive">Please fill in every field</Text>
```

## Submitting and focus

- Enter in a single-line field submits (`onSubmit`, which sets `submitBehavior="submit"` so focus stays). Every single-line field of a dialog gets `onSubmit`.
- A multiline field cannot use Enter. Submit with Cmd+Enter: bind `keymap.bind("mod+enter", send, { when: "always" })` in the component and show it as the button's `hint`.
- `autoFocus` the first field of a dialog, and the text box of a prompt opened by its shortcut. Not in a tab that merely became visible.
- Tab order follows visual order; do not reorder with layout tricks.

## Modal

`Modal` is for rare, user-invoked tasks (start an agent). Props: `open`, `onClose`, `title`, optional `description`, `children`, `actions`, `wide` (760pt, for text the user writes, a prompt).

- Popup is 560pt wide, scales in from 0.97 (`enterScale`), scrim `bg-black/40` fades with it. Escape and a scrim press call `onClose`.
- `actions` are right-aligned: a `ghost` `Cancel` first, then the one `primary`. Two filled buttons in a footer have no hierarchy.
- Taller than the window: the popup stops at 94% of its height, the title and `actions` stay in view, and only the content scrolls, under a hairline on the title and over the actions (transparent while nothing overflows, so nothing shifts). The content has its own 24pt side padding inside the scroll view so a focus outline is not clipped at the edge.
- Rows of labelled fields use `flex-row items-end gap-3`, so inputs align at the bottom when a label wraps. A field that sits alone goes in a `FieldRow`: `Labeled` grows with `flex-1` to share a row's width, and in a column that has to scroll the same `flex-1` shrinks the field to nothing and lets its input paint over the next one (found in a prompt dialog on the host: a missing label, blank gaps, a hint over the text).
- Anything quick and reversible does not need a dialog: edit it inline and toast an Undo.

```tsx
// Correct
<Modal open={newAgentOpen()} onClose={close} title="New agent"
  actions={<><Btn variant="ghost" label="Cancel" onPress={close} /><Btn variant="primary" label="Start agent" hint="↵" onPress={start} disabled={missingMachine()} /></>}>

// Incorrect: a hand-rolled Dialog with its own scrim and class string
<Dialog open={open} backdropClass="bg-black/50" class="rounded-xl bg-white p-6 shadow-2xl">
```

## confirmDestructive

For what an `Undo` toast cannot restore. It shows the system alert: a title naming the object, a description naming the consequence with numbers, and the action by its verb. Resolves `true` only for the destructive button; Escape and `Cancel` resolve `false`.

```tsx
const confirmed = await confirmDestructive({
  title: `Close pane ${pane}?`,
  description: `The agent in it stops and ${unsent} unsent prompts are discarded. The workspace stays. This cannot be undone.`,
  action: "Close pane",
});
```

## Machine form, start form, name dialog

- The machine form (`components/machine-form.tsx`) has no password or key field: `ssh` signs in with its own config, keys and agent. It says so, and says to run `ssh <destination>` once in a terminal for a new host. A secret never appears in a field, a log or a fixture.
- A destination reaches `ssh` and a remote shell, so `lib/machine-rules.ts` mirrors the whitelist of `native/core/src/ssh/validate.rs` (`destinationError`, `sessionError`, `portError`). It shows on blur and on submit; Rust checks again and its message (`fieldOfRejection`) shows under its field, or as a line of its own. Typed text survives a failed save and a failed test; an edit retires the old test result.
- `Test connection` needs a destination (an empty one would test this computer), shows `Connected · herdr <version> · N workspaces` or the classified failure, and announces it politely; a result that arrives after the form closed is dropped.
- `StartAgent` takes an absolute folder (`folderError`: the machine's home is not known here, so `~` is not offered) and the agent from `AGENT_KINDS`, which a test keeps equal to herdr's schema. A start that fails keeps the dialog and the typed folder.
- `NameDialog` trims; the confirm button is off while the name is empty or unchanged; Enter on an empty name says why; `onSubmit` runs, then `onClose`.

