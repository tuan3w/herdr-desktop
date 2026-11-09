# Overlays: tooltip, preview card, popover

Three popups that hang from a trigger, built on Base UI's behavior and nsh's `Overlay`. Menus and selects are in `design/menus.md`, the combobox list in `design/combobox.md`, dialogs in `design/dialogs.md`. What each one is for:

| Popup | Opens | Holds | Never |
|---|---|---|---|
| `Tipped`, `Clipped` (tooltip) | pointer rest, keyboard focus | an icon button's name or an action's outcome, one line, no controls | the only place a fact lives |
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

- `"close"` (the default, and the only one for tooltip and preview card): the popup ends (`anchor-moved`) when the edge nearest the anchor moves more than half a point between two placements. A change of size or a flip to the other side is not movement (`anchorMoved`): nsh keeps a popup that fits on neither side inside its area, so its corner moves with its own height while the anchor stands still, and a popover whose content grew (an async result, an error line) must not close itself.
- `"follow"` (`Popover`'s `anchorPolicy`, opt-in): for a trigger nothing scrolls (a header button). The host does not say when a scroll view clips the anchor, so a followed anchor that scrolls away is never noticed.

A bubble ended by a scroll, a press or Escape does not start a group: the next trigger waits its turn.

## Tooltip

**Look.** A small inverted pill (`BUBBLE`): the ink colour (`foreground`) as the fill, the page colour (`background`) as the text, 12 pt (`text-xs`) regular weight, padding 8 x 4, radius `md` 8, at most 240 pt wide (`max-w-60`), 6 pt below its anchor. No border, no shadow, no ring: the fill is 13.6:1 against the light page and 14.6:1 against the dark one, so nothing has to lift it (a ring is for a surface that is close to its ground), and a bordered card with a shadow reads as a miniature popover, which a tooltip is not. Wrapping text is not balanced: the host has no balance, and one line is the aim. The shortcut is `Keys` in the `tip` tone inside the same bubble (`TipContent`): one 20 pt cap per key, a chip of the page colour at 15%, text at 80%, 8 pt of gap from the label, written as the platform writes it (`Ctrl+N` on Linux and Windows, `keyLabel`). Text inside a bubble is `TipText` or `TipContent`, never a `popover-foreground` class: that colour is dark on the dark pill. Placement (`placeBubble`, pure): the bubble never leaves the window, 8 pt from every edge: `side` (`top` or `bottom`, default bottom) flips when it lacks room, `align` (`start`, `center`, `end`) gives way to the edge it would run over, the position is clamped and the width narrowed to the window so the text wraps. Use `side: "top"` where below is the next interactive row. No arrow: a 6 pt offset pill points at its anchor by nearness, and an arrow is a second shape to place and to flip on every edge. No motion: it opens and closes at once (`motion.md`, the frequency rule).

**Content.**
- It names an icon button's name or an action's outcome ("Ask a quick side question without adding to the session"), in sentence case, with no full stop.
- It never repeats the visible label of its own control: a button that says Save needs no tooltip that says Save.
- It never holds a fact that exists nowhere else: the accessible name carries it too, because a tooltip is invisible to touch and to anyone who does not rest the pointer.
- It shows the shortcut when the action has one.
- Cut text (`Clipped`) shows in full as plain text in the same bubble, wrapping at the maximum width.
- No controls and no links inside: that is a `PreviewCard` or a `Popover`.
- One line when it can be.

- Delay `REST_MS` (500) on the first (Base UI waits 600; a toolbar that wants less passes `delay` on its triggers), `GROUP_MS` (400) of warmth after one closed by the pointer leaving; while one is open the next shows at once. `PopupRoot`'s `tooltip` prop sets `delay`, `closeDelay`, `timeout`, `onOpenChange` (`TooltipTiming`).
- Per trigger (`TooltipOptions`, and the same props on `Tipped`): `disabled`, `delay`, `closeDelay`, `closeOnClick` (default true: a press on the trigger ends the bubble and cancels a pending one).
- Closes on leave, any press, Escape (when it is the top overlay: one Escape ends the bubble, the next the popup under it), the trigger going away, the anchor moving, `disabled` turning true.
- `Clipped` is disabled while its text fits.
- **Keyboard**: a trigger that takes the keyboard focus shows its bubble at once and closes it on blur (WCAG 1.4.13). nsh sends a focus event only to the view that takes it, and only to a view with `onPress`; `Tipped`'s wrapper never has it and nsh's `Button` has no focus prop. A control built as `<View role="button" onPress={…} {...useTriggerFocus()}>` inside `Tipped` takes part (`popups.fixture.tsx`); `IconButton` is built that way, so its label and shortcut reach keyboard users too. A focus within `POINTER_FOCUS_MS` of a press is the press's, and does not count.
- Not taken: waiting for the pointer to rest (`onMouseMove` per frame per text), a hoverable bubble, cursor following, animation: a tooltip, like a menu or a select, is opened many times a day and opens and closes at once (`motion.md`, the frequency rule).

## Preview card

Opens after `CARD_DELAY_MS` (600), closes `CARD_CLOSE_MS` (300) after the pointer left the trigger and the card. **Safe zone**: once the pointer leaves the trigger, the card stays while the pointer is over it, in the gap, or inside the triangle from where it left to the card's near edge (`inSafeZone`); the root's hover move supplies positions only while that wait lasts. Leaving the zone closes it at once (after `closeDelay`), stopping inside it for `TRANSIT_MS` too. A press on the card does not close it; any other press, Escape, the anchor moving and a dialog above it do. `card` is built on each opening. One card per root: moving to another trigger moves it.

## Popover

`<Popover trigger={(t) => …}>`: `t` is `PopoverTrigger` (`onPress`, `onFocus`, `onBlur`, `expanded`, `disabled`) to wire to the control; `children` are built only while open. `open`, `defaultOpen`, `onOpenChange(open, change)` as `createOpenState`.

- Closes on: a press on the trigger, a press outside, Escape (a popover inside a popover closes first), the keyboard focus leaving trigger and popup (`focus-out`), the anchor moving, `disabled`, a dialog above it, `PopoverClose` (`item-press`), `usePopover().close`.
- Focus-out: nsh cannot move the focus into a view and an `Overlay` reports no focus, so a control inside that is a `View` with `onPress` spreads `usePopover().focus`; `FOCUS_SETTLE_MS` after a blur with no control focused, the popover closes. A press (inside or outside) never counts as leaving.
- Keyboard reaches the content (UNVERIFIED: the headless harness does not Tab into a popup, its next stop is the control after the trigger, so only the close on leaving is tested): Tab walks from the trigger into the popup, and every control there must report its focus or the popover closes under the user (nsh's `Button`, so a `Btn`, reports none). A control of the content is a `View` with `onPress` that spreads `usePopover().focus` (`RailShow`, `RailAgent`), never a `Btn`.
- Height: the popup is never taller than the room on the side it was placed, which `onPosition` reports as `available`; taller content scrolls inside it under the same edge (`EDGE`, `design/foundations.md`: one edge, the shadow ring in light and a hairline in dark; every popup, menu, popover and preview card uses it). Otherwise nsh clamps a tall popup into the window and a rail tile of a project with 40 agents ran off the screen.
- Scroll bar room: the popup pads top, bottom and left (`py-3 pl-3`) and its `Scroll` pads the right (`pr-3`), so nsh's overlay bar (drawn over the viewport's right edge, never taking layout room) sits in the 12 pt gutter and never covers a field, a select or a progress bar that ends at the edge. Before this the popup padded all four sides itself and the bar lay over the last 12 pt of the content (the chat overview's selects ran under the thumb).
- Screen readers: the popup is named by `PopoverTitle` (or `label`), hinted by `PopoverDescription`; the trigger reports `expanded`.
- `openOnHover`: opens after `delay` (300), closes `closeDelay` (0) after the pointer left, which may cross to the popup. A click within `PATIENT_CLICK_MS` (500) of a hover opening keeps it open; a click-opened popover never closes because the pointer left.
- Motion: it is occasional and pointer-opened, so it animates both ways (`popupPresence`, `POPOVER_LOOK`): fade and scale from 0.96 in 160 ms, out in 120 ms. The scale grows from the edge at the trigger (`popupOrigin`) on the side it was placed (`onPosition`'s `placement`), not the side asked for, so a flipped popover is right. nsh's own popups keep a closing popup built with starting and ending classes (nsh-base `popup.rs`), but this popover is an `Overlay` of ours, so it keeps itself built for the exit instead (`createPresence`): the closing popup takes no presses and a reopen cancels the unbuild. Limit: for those 120 ms the overlay is still the top one for Escape. None, and no wait, under reduced motion.
- Not taken: `modal` (use `Modal`), focus trap, return focus (the focus never left the trigger), backdrop, arrow.

## Labs

The window screenshot draws no overlay, so `TipPreview`, `PopoverPreview`, `CardPreview`, `ToastPreview` and `MenuPreview` draw each surface in place for `components/kit-lab-overlays.tsx` (`kit-overlays-*` scenarios), captioned as not the real popup; `edges` places tooltips with `placeBubble` near every edge. Real placement, hover, motion and the shadow ring stay unverified in pictures.

## Tests

`hover.test.ts` (timing, group, nesting, focus, press, safe zone, reasons, dialogs), `positioner.test.ts` (`anchorMoved`, `inSafeZone` on all four sides), `tooltip.test.ts`, `preview-card.test.ts`; `popups.test.tsx` drives `popups.fixture.tsx` headless (press, Escape, nesting, title, keyboard tooltip, inside a dialog). Hover, the safe zone and scroll under a still pointer cannot be driven headless: check them with a screenshot.
