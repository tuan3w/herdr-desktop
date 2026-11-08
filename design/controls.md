# Controls

Checkbox, switch, radio, segmented, tabs, collapsible, accordion, progress, avatar: ports of Base UI's behavior and contract in the app's look (`components/kit/`). What differs from Base UI is always the host: the host cannot move the keyboard focus to a view from code (`focus()` is for inputs), and its `Tabs`/`RadioGroup` have no arrow keys. Where a component below says "one stop of Tab", that is how it is built.

## One stop of Tab, a highlight that moves

`RadioGroup` (and so `Segmented`; a press on an item does not give the container the focus: a view cannot take the focus from code, so Right after a click may do nothing until Tab arrives) and `TabBar` are one focusable container whose items are `focusable={false}` views (they still take pointer and screen-reader presses). While the container has the focus `createRoving` (`roving.ts`) holds the keys; the focus never leaves the container, a virtual highlight moves, its ring is drawn on the item (`RING`: `FOCUS_RING` without `focus-visible:`) and every step is announced (`announce`: name, "selected", "unavailable"). The keys are bound in an effect only while the container has the focus, so a group costs nothing otherwise, and only the axis it lays out along is bound: the other arrows still scroll the page.

| Group | Keys | Reaching an item |
|---|---|---|
| `RadioGroup` | all four arrows (`orientation` narrows them), loops, skips disabled; Space | chooses it (arrows), a press on the chosen item reports nothing; Return never chooses |
| `TabBar` | Left/Right (`vertical`: Up/Down), Home, End, loops (`loop={false}` stops); Space or Return | moves the highlight only; `activateOnFocus` chooses as it goes |

`stepIndex` and `keysOf` are the pure rules (`roving.test.ts`).

## CheckRow

A raw `View` (`role="checkbox"`), not nsh's `Checkbox`: that one gives no `onFocus`, which Return handling needs.
- `indeterminate`: a dash, "mixed" to a screen reader, a press asks `true`. Wins over `checked`.
- Space toggles; Return does not (a held `keymap` binding consumes it, bound on focus, released on blur and with the row). `Switch` toggles with both, as Base UI's.
- `readOnly`: focusable, never changes. `disabled`: out of Tab, `disabled:opacity-50`. `required` and `invalid` ride `accessibilityHint` (`stateHint`: nsh has no state for them); `invalid` reddens the box.
- `CheckRow`, `Switch` and `RadioGroup` are fields of their own (`useChoiceControl`): `name` is where the value goes in a `Form`, and `required` is a rule, so an unticked required box or an unchosen required group stops the submit and says why ("Tick this box to continue.", announced, because a box cannot take the focus from code). Under a `FieldRoot` the field announces. There is no hidden input.
- `label` may be left out of a `CheckRow` with a text child. Pressed is `active:opacity-80` on all three.

## Looks and sizes

Sizes come from the tiers in `lib/layout.ts` (`CONTROL`: small, default and the Large hit targets target); a control may be drawn smaller than its target and keeps the target through padding (emil-touch-and-accessibility). Every control reads `largeTargets` from `lib/settings.ts` and nothing else decides a 44.

- **`Segmented`**: a recessed track (`muted`), a raised chosen segment (`card` with the `sm` shadow of `lib/layout.ts`: a hairline ring and two soft layers, not a coloured fill; in dark, where a shadow cannot be seen, a hairline border and the `accent` fill). Radii nest: the track's radius minus its 2-pt padding is the segment's. Segments are the pointer target tall, labels body size at regular weight, muted until chosen and never bolder, no border between segments, an unchosen one lightens on hover.
- **`Switch`**: a small track and knob (see the file for the numbers) inside a pressable padded to the target. The off track is `muted-foreground` at high opacity so its edge reaches 3:1 against the surface in both appearances (about 3.3 and 3.6: unverified until measured; the old 40% tint was near 1.6). On is the primary fill and the knob at the other end, so the state is a position and a role, not a colour. The knob moves on `transform` only, ease-out, none under reduced motion.
- **`CheckRow`**: a 16-pt box in a row at least the target tall, the label 8 pt from the box. Press feedback is the colour and the tick's pop.
- Disabled is the control itself at 50% (`Btn` of every variant, the text inputs, `SelectField`, `Combobox`, `CheckRow`, `Switch`; WCAG exempts it from contrast). Why: `Btn` once used a muted fill, which turned a disabled ghost `Cancel` and a disabled `danger` into the same grey filled button. A `Btn` keeps its keycaps while disabled, so its width does not change when a form becomes valid. Read-only is recessed and still: a `bg-muted/50` fill and no hover (`inputLook` in `fields.tsx`, `SelectField`).
- Narrower than its content, nothing runs past its container: a `Btn` shrinks and its label is one line cut with an ellipsis (whole in a bubble); a `CheckRow` label wraps with its box on the first line (the box's column is one line of the label's text tall); a `Segmented` stops at its container and each label is cut the same way (`components/kit-lab-inputs.tsx` draws every case).

## Select all: `createCheckGroup`

One array of selected values (`value` controlled, or `defaultValue`), `has(v)`, `toggle(v, checked)`, and `parent` (`checked()`, `indeterminate()`, `press()`) for a header `CheckRow`. `onValueChange` may `cancel()`. The parent follows Base UI: from none or all it flips; from a hand-picked set it goes to all, then none, then back to that set; a child press restarts the cycle; disabled children keep their state; a cancelled press does not advance the cycle. `pressParent` is pure and linear (a list of 6,000 is 2 ms: `check-group.test.ts`). Not wired to a screen yet: no list selects in bulk.

```tsx
const picked = createCheckGroup({ all: () => ids() });
<CheckRow label="Select all" checked={picked.parent.checked()} indeterminate={picked.parent.indeterminate()} onChange={() => picked.parent.press()} />
<CheckRow label={title} checked={picked.has(id)} onChange={(on) => picked.toggle(id, on)} />   // in a List row: read id as an accessor
```

## Tabs

`TabItem` keeps `label`, `selected`, `onSelect`, `count`, `spoken` and adds `disabled` (reachable by the highlight, never chosen: Base UI's focusable-when-disabled). `TabPanel` is the content (with `label`, the name of its tab, it is a `region`; nsh cannot link a panel to its tab, so the name is the link; whether the GTK host exposes `region` is unverified): unmounted while not selected (a hidden view costs nothing), `keepMounted` keeps it built and `hidden` for a view that holds state (a half-typed field). The selected fill eases color (`hoverTransition`); a sliding indicator is not built: it needs every tab's measured frame and `design/motion.md` keeps tab changes instant.

## Collapsible and Accordion

`Collapsible` (`open`/`defaultOpen`/`onOpenChange` with a reason and `cancel()` through `createOpenState`, `disabled`), `CollapsibleTrigger` (`role="button"`, `accessibilityState.expanded`, `label`, `chevron`), `CollapsiblePanel` (`keepMounted`). The panel appears at once: animating height is layout, forbidden by `design/motion.md`; the only motion is the chevron turning on `transform` (`moveTransition`). Use it where an item folds; a controlled one lets its owner decide the default fold.

`Accordion`/`AccordionItem` share the same trigger and panel: `value` (open items) or `defaultValue`, `multiple` (else opening closes the others, and the open one can be closed), `disabled`, `keepMounted`; `accordionValue` is the pure rule. Every trigger is a stop of Tab: the focus cannot be moved between them, so Base UI's Up/Down between triggers has no equivalent. Unused so far.

## Progress, Avatar

`Progress`: `value` 0 to 100 (`min`, `max`), `label`, `valueText` (what is spoken: "2/5 reviewed"; else the percentage), `null` for an unknown extent (a segment steps along the bar from the shared timer while mounted: mount it inside an `If`, like `Spinner`). The fill is set by width and never animates; the spoken value is clamped like the bar. No Meter: there is no gauge. `Avatar`: `fallback` (initials), optional `src` with a `delay` before the initials show, decorative unless `label`; `fallbackShown` is the pure rule.

## Not ported, on purpose

Slider (no numeric setting: the sidebar width is a drag handle), Separator (hairlines are borders on their owner), Toolbar, ToggleGroup (`Segmented` is exactly-one; nothing multi-toggles), RTL, hidden inputs and form submission, `aria-controls` (nsh has no ids).

## Tests

`roving.test.ts`, `check-group.test.ts`, `accordion.test.ts` (rules); `components/controls.test.tsx` drives `components/controls-probe.tsx` with `keyboard.press` (Tab, arrows, Space, Return).

## Accessibility rules

The checklist and the reasons are in `docs/ACCESSIBILITY.md`; these are what a control in the kit must do.

- **A name, never a role word.** Icon-only controls are `IconButton` with a required `label` (`Close`, not `Close button`); the role comes from nsh's list (`button`, `checkbox`, `switch`, `tab`, `radio`, `option`, `menuitem`, ...) and `accessibilityState` carries `selected`, `expanded`, `checked`, `disabled`, `busy`. Where nsh has no state (`required`, `invalid`, read only) the kit appends it to `accessibilityHint`.
- **Targets.** The pointer target and the Large hit targets target are `CONTROL` in `lib/layout.ts`: a control drawn smaller keeps its target through padding, and a dense control is never below the pointer target.
- **Focus.** One ring: a 1.5 pt `ring` line hugging the control (`FOCUS_RING`, an outline at offset 0; `FOCUS_RING_BORDERED` for a control with its own border: the border turns `ring` plus a 0.5 pt outline; `FOCUS_RING_SIDEBAR` and `FOCUS_RING_INSET` draw it inside the edge). A pointer press hands the focus back (`releaseFocus`: AppKit focuses a clicked pressable and nsh 0.4.0 reads `focus-visible:` as `focus:`), so only the keyboard shows it. At least 3:1 against what it sits on (`lib/theme/theme.test.ts` checks the pairs). Tab order follows reading order; Escape leaves every popup, menu and dialog; nothing traps the keyboard.
- **Status.** `announce()` is polite and is for what happens away from the focus; something that blocks the person is announced and the focus moves to the control that resolves it. Colour is never the only signal: agent status is a shape first (needs you = filled with bar, working = half, done = check, idle = empty ring, unknown = dashed ring).
- **Motion and size.** `reduceMotion()` and `motion-reduce:` switch motion off (`lib/motion.ts`); layouts survive `fontScale()` 2.0.
- **Not on Linux.** nsh's GTK backend has no `accessible` grouping and no custom `accessibilityActions`: a grouped name goes in the container's label, an action is a real button.
