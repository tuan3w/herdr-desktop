# Overlays: tooltip, preview card, popover

Three popups that hang from a trigger, built on Base UI's behavior and nsh's `Overlay`. Menus and selects are in `design/menus.md`, the combobox list in `design/combobox.md`, dialogs in `design/dialogs.md`. What each one is for:

| Popup | Opens | Holds | Never |
|---|---|---|---|
| `Tipped`, `Clipped` (tooltip) | pointer rest, keyboard focus | one line, no controls | the only place a fact lives |
| `PreviewCard` | pointer rest (600ms), keyboard focus | what a reference points at; the pointer may enter it | for screen readers, or the only place a fact lives |
| `Popover` | press (or `openOnHover`) | a few controls, a title | a form that needs Save (use `Modal`) |

## The root

`PopupRoot` wraps the app and the content of every `Modal` (a dialog is a root view of its own, and an overlay is placed in the root of its anchor). It holds the one tooltip bubble and the one preview card of that root, closes them on any press (`onTouchStartCapture`), and feeds the pointer's path to a card that waits to close. A `Popover` needs no host: its overlay sits next to its trigger, so inside a dialog it is in the dialog. Outside a `PopupRoot` a trigger is a plain wrapper and nothing opens.

A popup that lives in the app root closes when a dialog opens above it (`dialogDepth` rose since it opened), so no popup is left under the scrim.

## Where the logic lives

- `hover.ts` (`createHover`): the engine for tooltip, card and a hover-opened popover. Delays, the delay group, nested triggers, focus, press, Escape, the safe zone. It holds no view; it drives a `createOpenState` (`popup.ts`), so every change has an `OpenReason` and the owner may `cancel()` it.
- `positioner.tsx`: `Positioner` (an `Overlay` with `side`, `align`, `offset`, `margin`, the anchor policy), `anchorMoved`, `inSafeZone`.
- `tooltip.tsx`, `preview-card.tsx`, `popover.tsx`: skins. `popup-root.tsx`: the root.
- One popup for many triggers (Base UI's handle and payload): a trigger registers a few functions with the root's engine and carries only `ref` and two hover handlers. A row of a long list costs a trigger object, not an overlay. Nothing runs while closed: the popup, its keys and the root's `onMouseMove` exist only while a popup is open or waiting to close.

## Anchor policy

An `Overlay` follows its anchor natively, and it is drawn over everything. A popup carried along with an anchor that scrolled out of its list would sit over the header or the next row, and a recycled list cell is another record by the time it is placed again. So:

- `"close"` (the default, and the only one for tooltip and preview card): the popup ends (`anchor-moved`) when the edge nearest the anchor moves more than half a point between two placements. A change of size or a flip to the other side is not movement (`anchorMoved`).
- `"follow"` (`Popover`'s `anchorPolicy`, opt-in): for a trigger nothing scrolls (a header button). The host does not say when a scroll view clips the anchor, so a followed anchor that scrolls away is never noticed.

A bubble ended by a scroll, a press or Escape does not start a group: the next trigger waits its turn.

## Tooltip

- Delay `REST_MS` (500) on the first, `GROUP_MS` (400) of warmth after one closed by the pointer leaving; while one is open the next shows at once. `PopupRoot`'s `tooltip` prop sets `delay`, `closeDelay`, `timeout`, `onOpenChange` (`TooltipTiming`).
- Per trigger (`TooltipOptions`, and the same props on `Tipped`): `disabled`, `delay`, `closeDelay`, `closeOnClick` (default true: a press on the trigger ends the bubble and cancels a pending one).
- Closes on leave, any press, Escape (when it is the top overlay: one Escape ends the bubble, the next the popup under it), the trigger going away, the anchor moving, `disabled` turning true.
- `Clipped` is disabled while its text fits.
- **Keyboard**: a trigger that takes the keyboard focus shows its bubble at once and closes it on blur (WCAG 1.4.13). nsh sends a focus event only to the view that takes it, and only to a view with `onPress`; `Tipped`'s wrapper never has it and nsh's `Button` has no focus prop. A control built as `<View role="button" onPress={…} {...useTriggerFocus()}>` inside `Tipped` takes part (`popups.fixture.tsx`). A focus within `POINTER_FOCUS_MS` of a press is the press's, and does not count.
- Not taken: waiting for the pointer to rest (`onMouseMove` per frame per text), a hoverable bubble, cursor following, animation (`motion.md`).

## Preview card

Opens after `CARD_DELAY_MS` (600), closes `CARD_CLOSE_MS` (300) after the pointer left the trigger and the card. **Safe zone**: once the pointer leaves the trigger, the card stays while the pointer is over it, in the gap, or inside the triangle from where it left to the card's near edge (`inSafeZone`); the root's hover move supplies positions only while that wait lasts. Leaving the zone closes it at once (after `closeDelay`), stopping inside it for `TRANSIT_MS` too. A press on the card does not close it; any other press, Escape, the anchor moving and a dialog above it do. `card` is built on each opening. One card per root: moving to another trigger moves it.

## Popover

`<Popover trigger={(t) => …}>`: `t` is `PopoverTrigger` (`onPress`, `onFocus`, `onBlur`, `expanded`, `disabled`) to wire to the control; `children` are built only while open. `open`, `defaultOpen`, `onOpenChange(open, change)` as `createOpenState`.

- Closes on: a press on the trigger, a press outside, Escape (a popover inside a popover closes first), the keyboard focus leaving trigger and popup (`focus-out`), the anchor moving, `disabled`, a dialog above it, `PopoverClose` (`item-press`), `usePopover().close`.
- Focus-out: nsh cannot move the focus into a view and an `Overlay` reports no focus, so a control inside that is a `View` with `onPress` spreads `usePopover().focus`; `FOCUS_SETTLE_MS` after a blur with no control focused, the popover closes. A press (inside or outside) never counts as leaving.
- Screen readers: the popup is named by `PopoverTitle` (or `label`), hinted by `PopoverDescription`; the trigger reports `expanded`.
- `openOnHover`: opens after `delay` (300), closes `closeDelay` (0) after the pointer left, which may cross to the popup. A click within `PATIENT_CLICK_MS` (500) of a hover opening keeps it open; a click-opened popover never closes because the pointer left.
- Not taken: `modal` (use `Modal`), focus trap, return focus (the focus never left the trigger), backdrop, arrow.

## Tests

`hover.test.ts` (timing, group, nesting, focus, press, safe zone, reasons, dialogs), `positioner.test.ts` (`anchorMoved`, `inSafeZone` on all four sides), `tooltip.test.ts`, `preview-card.test.ts`; `popups.test.tsx` drives `popups.fixture.tsx` headless (press, Escape, nesting, title, keyboard tooltip, inside a dialog). Hover, the safe zone and scroll under a still pointer cannot be driven headless: check them with a screenshot.
