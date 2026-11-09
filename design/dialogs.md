# Dialogs and toasts

`components/kit/modal.tsx` (`Modal`, `confirmDestructive`), `palette-dialog.tsx` (`PaletteDialog`), `notify.tsx` (toasts), and two rule files: `dialog-stack.ts` and `toast-rules.ts`, both pure and unit-tested. They port Base UI's Dialog, AlertDialog and Toast: behavior and contract, not its DOM. `feedback.test.tsx` drives them on the test clock through `feedback-lab.tsx` (a test entry). Every dialog in the app, with its mismatches: inventory.md in the kit batch (not in this repo yet).

## What a dialog is for

A dialog is for **a decision or a short form**: confirm a destructive step, name something, start a session, pick one thing and go. It is never for **browsing or viewing** (a file, a list of past sessions, an agent's details). **Settings is the one exception**, decided by the owner (2026-11-08): it is a short-lived setup surface of many small choices that apply at once, opened for a moment and closed, and a dialog keeps the layout behind it unchanged. Why: a dialog is inert behind a scrim, so everything under it, including a question waiting for the person, is hidden while they read, and a thing people open to look at stays open for minutes.

```
What does the person need?
 ├── To be told something happened ............ a toast (`notify`); an error that needs action: `lasting`
 ├── To undo something cheap ................... a toast with Undo (`mod+z`), no question first
 ├── To choose from a few things beside a control a popover or a menu, anchored (`Popover`)
 ├── To find something by typing, many times a day  the palette (`PaletteDialog`), never a titled dialog
 ├── To answer the agent ....................... the answer dock; many at once: the Board's filtered view
 ├── To look, read, compare, come back to it ... a region (main, inspector) or a tab
 └── To leave with a choice made or a field filled, within about a minute
      ├── "Are you sure" about what cannot be restored → DestructiveConfirm
      ├── Fields → FormDialog (3 steps at most: Wizard)   ├── A path → the Folder field (a list under it)  ├── Files to attach → Picker
      └── A picture the person must see large → Lightbox (pictures only)
```

Decided and built: Settings is a large dialog and Machines a page of it, edited inline (`design/patterns.md`). Decided, not built yet (owner, 2026-11-07): these still open as a `Modal` and move out: the agent's details (the inspector; today a popover under the chat's title, no longer a `Modal`), past sessions and the file viewer (a tab), and the shortcut sheet. Until each moves it keeps the rules below.

Decided and built: the dock has no dialogs, and neither has bulk answering (`BulkAnswer` is a part of the Board's page with a two-press button and a lasting result toast, not a confirm). Triage is gone (the Board's filtered view is the bulk path), `Show all N lines` opens the whole command in the dock and `N more…` opens every answer in it. Proposed, not yet decided (design review of the kit batch): web pages become a tab; the switcher and the links list take the palette's face; the picture viewer is a Lightbox, pictures only (built).

## Rules for every dialog

- **Title always**, sentence case, 16 pt (`text-lg`), naming the object or the outcome ("Close 3 agents?", "Add machine"), never "Confirm" or "Warning". **Description** when the title does not say what happens, with numbers ("stops 3 agents, discards 2 unsent prompts"). Why: it is read aloud once on opening and is the only text a screen reader gets before the buttons.
- **Footer**: right-aligned, **Cancel first** (`ghost`), the one `primary` last, the outcome as a verb with its object ("Start agent", "Close 3 agents"), never OK, Yes or Submit. A helper action (Copy message, Test connection) sits before Cancel as `ghost` or plain. A destructive extra inside a form (Remove machine) is not in the footer: it goes at the end of the body, apart. Why: proximity reads as equivalence, and the last button is where Enter and the eye go.
- **Primary is not disabled for a missing field**: pressing it shows the error under the field and moves focus there (`design/forms.md`). Disabled only while busy (`loading`) or when nothing can be done (no target). Why: a dead button cannot say what is wrong.
- **Sizes** (`Modal`): `size="small"` 400 pt for Confirm, Alert and Info, so a short question is not a wide empty card; 560 pt default; `wide` 760 pt only for text the user writes; `huge` 1000 pt only for the Lightbox; the large size (`DIALOG_LARGE`, 880 x 640, a header with the title and `Close`, no footer, content fills it) only for Settings; max 94% of the window. Radius `xl` 16 (`RADIUS`: dialog 16 minus 8 of padding is a row's 8), like the palette. A dialog with no `actions` has no footer band: the body ends at the 24 pt edge padding.
- **Focus**: the first field has the focus (`autoFocus`); a text-free dialog has none from code (a view cannot take focus: unverified which button nsh's alert focuses), so Enter and Escape must be safe there. Tab is trapped by nsh's layer, Escape asks. Focus is not returned to the opener by us (`docs/ACCESSIBILITY.md`).
- **Escape and the scrim**: Escape always asks (Cancel). A scrim press asks, except while text the person typed would be lost, a task runs or a question is destructive (`disablePointerDismissal`, set from the dialog's own draft: Settings refuses only while a machine form is open, New session while a prompt is typed or a start runs, a name dialog once the name changed). Why: a mis-click must never lose work or leave an alert.
- **Motion**: the popup scales from `DIALOG_SCALE` (0.97) to 1 and back over `DURATION.dialog` (200 ms) with nsh's layer fade, which is a fixed 200 ms: the one exit that is not quicker, so scale and scrim end together. It animates even when a shortcut opened it: dialogs are rare and the origin is the window's center. The palette is the exception (`paletteEnter`, 120 ms, instant close) because it opens many times a day. Reduced motion: no scale.
- **Never**: a dialog for browsing; two open at once except a confirm over its parent (depth 2, then the parent is under a darker veil); a dialog at launch or from an agent event (a question arrives in the dock); a timer that closes or answers one.

## The kinds

| Kind | Use | Not | Buttons, focus, Esc |
|---|---|---|---|
| Confirm | A plain choice with an outcome ("Send 3 notes to api-fix?") | Anything that loses data | `Cancel`, verb. First field or none. Esc = Cancel |
| DestructiveConfirm | What an Undo toast cannot restore: `confirmDestructive`, `BulkConfirm` | Cheap reversible steps (Undo toast); a second confirm after a press-twice | `Cancel`, then the danger verb **with the count**. Esc = Cancel, scrim ignored |
| Alert | A blocking failure the person must act on, what happened and what to do | Inline form errors (stay in the dialog, under the field); anything a toast can say | One button naming the next step. Announced as an alert. Esc closes |
| FormDialog | 1 to 5 fields: name, machine, start | lists to manage | Enter submits; `mod+↵` in a text area; error on blur and submit; typed text kept on failure; `disablePointerDismissal` |
| Wizard | Steps that depend on the previous one | Anything one form can hold: remember the last choices instead | Step list, `Back`, at most 3, `Next` then the verb on the last |
| Picker | Files on a machine, as a decision | Browsing a tree for minutes; choosing a folder (that is the `Folder` path field, never a second dialog over the form) | `Cancel`, "Attach 3"; the count is in the button |
| Progress | The person must wait (checking, stopping) | A long copy: a `loading` toast with Stop lets them look away | `Stop` while running; never closes on error, lists what failed |
| Lightbox | A picture | Files (a tab), text, pages | Built (`components/lightbox-view.tsx`): its own dimmed layer, no card, no title; name line `2 of 5`, `...` and `Close`; Left and Right walk; Esc closes |
| Sheet | Inspector overlay in a window under about 1000 pt | Browsing pages | Covers the conversation: scrim, Esc, focus held |
| Palette | Search many times a day | A list that needs a title | `PaletteDialog`, no title, instant close |
| Info | A glance under one screen with no scroll (About) | A reference longer than a screen | A `Close` with its Esc hint; scrim closes |
| Approval | The agent asks | A dialog: the dock answers, and its overflow opens inside it | Whole command, risk line, keys 1 to 3, press twice for a risky one, nothing sent by time |

- **Cost ladder** for a step: undoable for 10 s and by `mod+z`, a toast. Cheap to redo by hand, a toast. Not restorable, or stops something running, a DestructiveConfirm. Never both an Undo and a question for one action, and never a confirm after a press-twice. The confirm names the object and the consequence with numbers.
- **Two-step**: the dialog is the second step of a risky action; a risky approval has no dialog, so it is press, then press again within 4 s (`design/attention.md`). One confirmation per action.
- **Wizard**: not wanted today. New session stays one form with the last machine, folder and agent preselected.
- **Progress**: finishing well closes the dialog and a toast says what happened; any failure stays, with the reason per item and a way to retry.

## Dialog

`Modal` is controlled: `open`, `onClose(change)`. Escape and a press on the scrim only **ask**; `change.reason` is `escape-key` or `outside-press` (`OpenReason`, `createOpenState`). The owner closes by setting `open` false and refuses by leaving it true. nsh's own `closeOn*` flags are off: its cancel carries no reason and cannot be vetoed, so the scrim is the dialog's own `View` (`testID` `dialog-scrim`).

- `disablePointerDismissal`: a press on the scrim asks nothing. Escape still asks. `onOpenChangeComplete(open)` runs after the enter and after the exit fade.
- **Open is a boolean that changes, not an expression that re-runs.** nsh's `Dialog` deletes its native window and builds everything in it again each time its `open` is evaluated, even to the same `true`, so `Modal` reads the owner's `open` through one `computed` and only a change of the boolean reaches the layer. Why: Settings is open while `settingsPage()` is set, and every page change rebuilt the whole dialog; the person saw the content go away and come back (owner, 2026-11-09). A page switch inside a dialog is instant, with no motion (`components/kit/modal.test.tsx`).
- **Nesting.** `dialog-stack.ts` keeps the open dialogs in order (`trackDialog`); `dialogDepth()` counts them; `topDialog()` answers. A lower dialog ignores Escape and its scrim. Each has its own scrim, so a parent sits under a darker veil.
- **Popups.** A dialog is a root view: it holds its own `PopupRoot`; a popup of the app that is open when one opens closes itself when `dialogDepth()` rises. `ToastHost` draws in the root on top, never both.
- **Body.** The title and the actions stay; only the content scrolls, with a hairline while it overflows (`BODY_PAD`).
- **Screen readers.** Opening announces the title and description once per opening, not on close. `PaletteDialog` has no title: `label` names it (default "Command palette").
- **Escape and toasts.** While the toast region is held, Escape closes the newest toast and the dialog stays (`escapeIsToasts`). Behind the dialog: Pointer and Tab are held by nsh's layer; `undoLast` does nothing while one is open.
- Not ported: `modal={false}` (a popover here), triggers, `keepMounted`, focus props, scroll lock, Drawer gestures.

## confirmDestructive

The system alert, as AlertDialog: `Cancel` first, the action by its verb (destructive), never closed by a press outside, Escape is `Cancel`. **One at a time**: a second call while one is open answers `false` at once. True only for the destructive action. The alert covers the toasts, so their time is held (`coverToasts`): an Undo toast must not expire under the question about it.

## Toasts

`notify(text, options)` returns the toast's id; the model is Base UI's manager (`createToasts`, no timers inside).

| Rule | Decision |
|---|---|
| `timeout` | 3.5 s plain (60 ms a character past 58, at most 12 s: `plainTimeout`), 10 s with `undo`, 30 s `lasting` and `type: "error"`; `0` stays. Running time only. |
| Pause | Stack hovered or touched (`hover`), a button focused (`focus`), the region shortcut (`region`), covered by an alert (`covered`). A toast added while paused starts paused. |
| `limit` | 3 show; the rest are `limited`, kept, back as newer ones go. `high` priority first; at most 30 kept (`keep`). `lasting` is `high`. |
| De-duplication | The same `id` is one toast: updated in place, time restarted. |
| `promise` | `notifyPromise(promise, { loading, success, error })`: one toast, `loading` then its result. Use it for work the user waits on. |

**Undo.** The `Undo` button runs the undo once and closes the toast. `mod+z` (`undoLast`) runs the newest undo whose toast is on screen or whose time has not run out (`newestUndo`): Escape, the close button and the limit hide a toast but do not take the way back.

**Keyboard.** A view cannot take focus from code, so the way to the region is `focusToasts` (proposed key `mod+shift+t`): the timers stop, the screen reader reads the toasts newest first, Escape closes the newest, the same key lets go. `ToastButton`s are plain pressable views (nsh's `Button` reports no focus).

**Look.** A toast is a small transient surface: radius `lg` 12, `EDGE.md` (not `lg`: it floats 400 pt wide and a dialog-sized shadow would outweigh a line of text), text `sm` 13, 400 pt wide. Its buttons are one language (`ToastButton`: ghost, no border, radius `sm` 4 = 12 minus the 8 pt of padding); the Undo shortcut is plain muted text (`Keys` `bare`), as in a menu. A dialog and the palette use `EDGE.lg`.

**Motion.** `ToastStack` springs lay out, stack and swipe; reduced motion lands without moving. Announced once when raised (`announce`: the text, then `Undo: ⌘Z`). **Cost.** No toast: no view, no timer; with toasts one `setTimeout` to the next deadline.

## Tests

`toast-rules.test.ts` (timers, pause, limit, priority, de-duplication, undo reach), `dialog-stack.test.ts` (nesting), `feedback.test.tsx` (end to end on the test clock).
- **Where a toast is drawn**: top right under the header, never at the bottom: the composer and the answer dock live there and a toast must not cover what a question waiting for the person needs. It enters from above.
