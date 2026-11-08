# Motion recipes, with this app's exemplars

Each recipe names the helper in `lib/motion.ts` and one file that already uses it (found by grep when this was written: re-check, the code moves). Values are in `lib/motion.ts` and `design/motion.md`; do not copy numbers here.

| I want | Helper | Exemplar | Notes |
|---|---|---|---|
| A control that eases its colour on hover or press | `hoverTransition()`, `pressTransition()` as `style` | `components/settings.tsx`, `session-header.tsx`, `changes-list.tsx` | `transitionProperty` is `"colors"`. None under reduced motion. |
| A control that scales while pressed | `pressFeedback()` (`style`, `down`, `up`) | `components/kit/button.tsx` | Starts from the live scale, so a release mid-press glides back. `Button`'s `activeStyle` transform is ignored on the host. |
| A part that slides or turns (switch knob, chevron) | `moveTransition()`, `trackTransition()` | `components/kit/switch.tsx`, `kit/collapsible.tsx`, `sidebar.tsx` | `transform`, `EASE_MOVE`. |
| A popover that enters and leaves | `popupPresence(open, look)` with `POPOVER_LOOK`, `popupOrigin()` for the scale origin | `components/kit/popover.tsx` | Stays built through its exit, `closing()` takes no presses, a reopen turns around. Menus, selects, tooltips and comboboxes do not use it: they open and close at once. |
| A dialog | `enterScale(open)` bound to the popup | `components/kit/modal.tsx` | Only the scale: nsh fades the layer and scrim for a fixed 200 ms with no prop. |
| The command palette | `paletteEnter(open)` | `components/kit/palette-dialog.tsx` | Fades in, closing is instant. |
| A toast | `toastLook()` as the toast's classes | `components/kit/notify.tsx` | Swiping stops the transition. Empty under reduced motion. |
| A thing that arrives (a card, a row, a tab face) | `appear(key, "rise" or "fade")` | `components/board.tsx`, `board-card.tsx`, `tab-face.tsx` | Only the first build of a key after `motionReady`, not after a key press, not under reduced motion. Call while building; `undefined` means it just is there. |
| A line that arrives in a virtual list | `arrivals()` and `arriving(isNew)`, `show(key)` | `components/session-item.tsx`, `markdown.tsx` | Animates the content, never the recycled cell; the first look at a conversation settles for `SETTLE_MS` so opening a chat does not perform. |
| A pill with an exit | `leaving(value)` (a function returning the value or `null`) | `components/session-transcript.tsx`, `sidebar.tsx` | `value()` is the last non-null value until the exit has played. |
| A fold, an inbox, a dock appearing | `animateLayout()` before the state change | `components/answer-dock.tsx`, `kit/collapsible.tsx` | Inserted fades in, moved glides, removed fades out. Not for a virtual list. |
| A number or word that changed | `swapped()` (`style`, `changed()`) or the kit's `Swap` | `components/kit/swap.tsx`, `lib/dock.ts` | Not again within `SWAP_QUIET_MS`; a ticking count shows only the first. |
| An agent's state glyph changed | `glyphChanged()` | `components/status-glyph.tsx` | One pop. Never an endless turn for "working". |
| A project shown in place of another by the pointer | `contextEnter()` on the workspace wrapper | `components/workspace.tsx` | Only the incoming side; skipped for repeats and after a key. |
| A shortcut's result should not animate | call `markKeyboard()` first | `App.tsx` | Everything keyed on `arrived()` or `contextEnter()` honours `KEY_WINDOW_MS`. |
| A mount that must wait for its exit | `createPresence(open, exitMs)` + `presenceMotion(look)` | `lib/motion.ts` | Pure state plus a `motionClock` timer: testable without the real clock. |

## Testing a motion

- `lib/motion.test.ts` pins the reduced-motion paths, `appear`, `arrivals`, `contextEnter`, `swapped`, `createPresence` and `popupOrigin` with a fake `motionClock`. Add a case there for a new helper.
- For the whole app: `open("./App.tsx", { ...DESKTOP, reducedMotion: true })` and assert nothing is left mounted for an exit.
- Mid-flight: `await app.clock!.runFor(ms)` then `await app.screenshot(".scratch/x.png")` (Linux target, `GSK_RENDERER=cairo`); `nsh test --trace` shows the ops. Never `app.wait` on the real clock to "let it finish".
- At rest: `bun scripts/perf.mjs` (Linux) must still show no frames idle (`docs/PERFORMANCE.md`).
