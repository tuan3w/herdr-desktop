# Dialogs and toasts

`components/kit/modal.tsx` (`Modal`, `confirmDestructive`), `notify.tsx` (toasts), and two rule files: `dialog-stack.ts` and `toast-rules.ts`, both pure and unit-tested. They port Base UI's Dialog, AlertDialog and Toast: behavior and contract, not its DOM. `feedback.test.tsx` drives them on the test clock through `feedback-lab.tsx` (a test entry, not part of the app).

## Dialog

`Modal` is controlled: `open`, `onClose(change)`. Escape and a press on the scrim only **ask**; `change.reason` is `escape-key` or `outside-press` (`OpenReason`, `createOpenState`). The owner closes by setting `open` false and refuses by leaving it true (a prompt dialog asks before it closes with unsent text). nsh's own `closeOn*` flags are off and its backdrop is not used: its cancel carries no reason and cannot be vetoed after the fact, so the scrim is the dialog's own `View` (`testID` `dialog-scrim`).

- `disablePointerDismissal`: a press on the scrim asks nothing. For a dialog that holds what the user typed. Escape still asks.
- `onOpenChangeComplete(open)`: after the enter (`onOpen`) and after the exit fade (`onClose`), never for a state that did not finish.
- **Nesting.** `dialog-stack.ts` keeps the open dialogs in order (`trackDialog` adds one while open, removes it on close and when its owner is disposed while open). `dialogDepth()` counts them; `topDialog()` is the one that answers. A lower dialog ignores Escape and its scrim.
- **Popups.** A dialog is a root view and covers the app: it holds its own `PopupRoot` (tooltips, popups made inside it), and they die with it. A popup of the app that is open when a dialog opens must close itself when `dialogDepth()` rises (menus, selects, popovers do), so none floats under the scrim.
- **Toasts.** `ToastHost` draws in the root view that is on top: the dialog's when one is open, else the app's. Never both: a toast is neither drawn nor read twice, and one raised inside a dialog is not hidden by its scrim.
- **Scrims.** Each dialog has its own, so nested ones dim twice: the parent sits under a darker veil.
- **Body.** The title and the actions stay; only the content scrolls, with a hairline while it overflows (`BODY_PAD` in `modal.tsx`).
- **Screen readers.** Opening announces the title and description. No announcement on close: the toast or the screen that follows speaks.
- **Behind the dialog.** Modal means inert. Pointer and Tab are held by nsh's layer. `undoLast` does nothing while a dialog is open. App shortcuts still reach `keymap`: guarding them with `dialogDepth()` is the app root's call.
- Not ported: `modal={false}` (a non-modal dialog is a popover here), triggers, handles, `keepMounted`, initial and final focus props (a view cannot take focus from code; the first `autoFocus` field gets it), scroll lock (nothing scrolls behind a layer), Drawer gestures.

## confirmDestructive

The system alert, as AlertDialog: `Cancel` first, the action by its verb (destructive), never closed by a press outside, Escape is `Cancel`. **One at a time**: a second call while one is open answers `false` at once, so a double press cannot stack alerts or confirm twice. True only for the destructive action.

## Toasts

`notify(text, options)` returns the toast's id. The model is Base UI's manager (`createToasts`, no timers inside: every call takes `now`):

| Rule | Decision |
|---|---|
| `timeout` | 3.5 s plain, 10 s with `undo`, 30 s `lasting`; `0` stays until closed. A `loading` toast has no timer. Running time only. |
| Pause | Stack hovered or touched (`hover`), a toast's button focused (`focus`), the region shortcut (`region`). Resume continues with the time left, any number of times. A toast added while paused starts paused. The reasons are cleared when the last toast goes. |
| Window inactive | Not ported: the host gives JS no window-active signal. |
| `limit` | 3 show. The rest are `limited`: kept, timers running, back as newer ones go (as Base UI). `high` priority takes a place before any `low`. At most 30 are kept (`keep`): a loop that raises thousands loses its oldest hidden ones, who hear `onClose` and `onRemove`, never a warning. |
| `priority` | `lasting` is `high` (warning icon). nsh's `announce` has one urgency, so `high` is "never pushed out by the limit", not louder speech. |
| De-duplication | The same `id` is one toast: updated in place, time restarted. A plain text is its own id. A toast that is closing is replaced by a new one without a `onRemove`. |
| Callbacks | `onClose` once when it begins to close (any cause); `onRemove` after the exit (0 under reduced motion). |
| `update` | `updateToast` restarts the time; a closing or removed toast is never reopened. |
| `promise` | `notifyPromise(promise, { loading, success, error })`: one toast, `loading` then its result, with its own time. If the user closed it meanwhile, a success stays unsaid and a failure (`type: "error"` or `lasting`) shows again. A phase returning nothing closes it. Use it for work the user waits on (starting an agent, sending a prompt). |

**Undo.** The `Undo` button runs the undo once and closes the toast. The undo shortcut (`mod+z`; `undoLast`) runs the newest undo whose toast is on screen **or whose time has not run out** (`newestUndo`): Escape, the close button, a swipe and the limit hide a toast but do not take the way back. After its time, both are gone.

**Keyboard.** A view cannot take focus from code, so the way to the region is `focusToasts` (proposed key `mod+shift+t`, to go in `lib/shortcuts.ts` and `App.tsx`): the timers stop, the screen reader reads the toasts newest first and its cursor goes to the newest, Escape closes the newest, the same key lets go. The toast's buttons are plain pressable views (`ToastButton`), not `Btn`: nsh's `Button` reports no focus, and a focused button holds the time. Sighted keyboard users undo with that shortcut, which the button's keycap teaches. Toasts never take Escape unless this mode is on.

**Motion.** `ToastStack` springs lay out, stack (collapsed layers, expanded on hover) and swipe; reduced motion lands without moving and removes closed toasts at once. Screen-reader order: announced once when raised (`notify` calls `announce`: the text, then `Undo: ⌘Z`); the stack holds them oldest first, so reading by cursor goes old to new.

**Cost.** No toast: no view, no timer. With toasts: one `setTimeout`, set to the next deadline (never an interval), cleared on every change.

## Tests

`toast-rules.test.ts` (timers, pause arithmetic, limit, priority, de-duplication, late answers, undo reach), `dialog-stack.test.ts` (nesting), `feedback.test.tsx` (the above end to end, the test clock moves time).
