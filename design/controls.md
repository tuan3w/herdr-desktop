# Controls

Checkbox, switch, radio, segmented, tabs, collapsible, accordion, progress, avatar: ports of Base UI's behavior and contract in the app's look (`components/kit/`). What differs from Base UI is always the host: the host cannot move the keyboard focus to a view from code (`focus()` is for inputs), and its `Tabs`/`RadioGroup` have no arrow keys. Where a component below says "one stop of Tab", that is how it is built.

## One stop of Tab, a highlight that moves

`RadioGroup` (and so `Segmented`) and `TabBar` are one focusable container whose items are `focusable={false}` views (they still take pointer and screen-reader presses). While the container has the focus `createRoving` (`roving.ts`) holds the keys; the focus never leaves the container, a virtual highlight moves, its ring is drawn on the item (`RING`: `FOCUS_RING` without `focus-visible:`) and every step is announced (`announce`: name, "selected", "unavailable"). The keys are bound in an effect only while the container has the focus, so a group costs nothing otherwise, and only the axis it lays out along is bound: the other arrows still scroll the page.

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
- No `name`/`value`/hidden input: the app has no form submission. There is no `Field` integration.

## Select all: `createCheckGroup`

One array of selected values (`value` controlled, or `defaultValue`), `has(v)`, `toggle(v, checked)`, and `parent` (`checked()`, `indeterminate()`, `press()`) for a header `CheckRow`. `onValueChange` may `cancel()`. The parent follows Base UI: from none or all it flips; from a hand-picked set it goes to all, then none, then back to that set; a child press restarts the cycle; disabled children keep their state; a cancelled press does not advance the cycle. `pressParent` is pure and linear (a list of 6,000 is 2 ms: `check-group.test.ts`). Not wired to a screen yet: no list selects in bulk.

```tsx
const picked = createCheckGroup({ all: () => ids() });
<CheckRow label="Select all" checked={picked.parent.checked()} indeterminate={picked.parent.indeterminate()} onChange={() => picked.parent.press()} />
<CheckRow label={title} checked={picked.has(id)} onChange={(on) => picked.toggle(id, on)} />   // in a List row: read id as an accessor
```

## Tabs

`TabItem` keeps `label`, `selected`, `onSelect`, `count`, `spoken` and adds `disabled` (reachable by the highlight, never chosen: Base UI's focusable-when-disabled). `TabPanel` is the content: unmounted while not selected (a hidden view costs nothing), `keepMounted` keeps it built and `hidden` for a view that holds state (a half-typed field). The selected fill eases color (`hoverTransition`); a sliding indicator is not built: it needs every tab's measured frame and `design/motion.md` keeps tab changes instant.

## Collapsible and Accordion

`Collapsible` (`open`/`defaultOpen`/`onOpenChange` with a reason and `cancel()` through `createOpenState`, `disabled`), `CollapsibleTrigger` (`role="button"`, `accessibilityState.expanded`, `label`, `chevron`), `CollapsiblePanel` (`keepMounted`). The panel appears at once: animating height is layout, forbidden by `design/motion.md`; the only motion is the chevron turning on `transform` (`moveTransition`). Use it where an item folds; a controlled one lets its owner decide the default fold.

`Accordion`/`AccordionItem` share the same trigger and panel: `value` (open items) or `defaultValue`, `multiple` (else opening closes the others, and the open one can be closed), `disabled`, `keepMounted`; `accordionValue` is the pure rule. Every trigger is a stop of Tab: the focus cannot be moved between them, so Base UI's Up/Down between triggers has no equivalent. Unused so far.

## Progress, Avatar

`Progress`: `value` 0 to 100 (`min`, `max`), `label`, `valueText` (what is spoken: "2/5 reviewed"; else the percentage), `null` for an unknown extent (the bar breathes by opacity while mounted: mount it inside an `If`, like `Spinner`). The fill is set by width and never animates. No Meter: there is no gauge. `Avatar`: `fallback` (initials), optional `src` with a `delay` before the initials show, decorative unless `label`; `fallbackShown` is the pure rule.

## Not ported, on purpose

Slider (no numeric setting: the sidebar width is a drag handle), Separator (hairlines are borders on their owner), Toolbar, ToggleGroup (`Segmented` is exactly-one; nothing multi-toggles), RTL, hidden inputs and form submission, `aria-controls` (nsh has no ids).

## Tests

`roving.test.ts`, `check-group.test.ts`, `accordion.test.ts` (rules); `components/controls.test.tsx` drives `components/controls-probe.tsx` with `keyboard.press` (Tab, arrows, Space, Return).

## Accessibility rules

The checklist and the reasons are in `docs/ACCESSIBILITY.md`; these are what a control in the kit must do.

- **A name, never a role word.** Icon-only controls are `IconButton` with a required `label` (`Close`, not `Close button`); the role comes from nsh's list (`button`, `checkbox`, `switch`, `tab`, `radio`, `option`, `menuitem`, ...) and `accessibilityState` carries `selected`, `expanded`, `checked`, `disabled`, `busy`. Where nsh has no state (`required`, `invalid`, read only) the kit appends it to `accessibilityHint`.
- **Targets.** At least 24 x 24 css pt for a pointer, 44 where touch is possible: a control drawn smaller keeps its target through padding. Dense buttons are 28pt, so rows stay clear of it.
- **Focus.** `FOCUS_RING` (outline), `FOCUS_RING_SIDEBAR` or `FOCUS_RING_INSET`, at least 3:1 against what it sits on (`lib/theme/theme.test.ts` checks the pairs). Tab order follows reading order; Escape leaves every popup, menu and dialog; nothing traps the keyboard.
- **Status.** `announce()` is polite and is for what happens away from the focus; something that blocks the person is announced and the focus moves to the control that resolves it. Colour is never the only signal: agent status is a shape first (needs you = filled with bar, working = half, done = check, idle = empty ring, unknown = dashed ring).
- **Motion and size.** `reduceMotion()` and `motion-reduce:` switch motion off (`lib/motion.ts`); layouts survive `fontScale()` 2.0.
- **Not on Linux.** nsh's GTK backend has no `accessible` grouping and no custom `accessibilityActions`: a grouped name goes in the container's label, an action is a real button.
