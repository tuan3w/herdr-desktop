# Menus and selects

`ActionMenu`, `RowMenu` and `SelectField` (`components/kit/menu.tsx`, `select.tsx`) are ports of Base UI's Menu, Context Menu and Select. The pure rules are in `navigation.ts`; both components are one popup, `Surface`, so a fix there fixes both.

## Entries (`MenuEntry`)

| Entry | Is | Closes the menu |
|---|---|---|
| `MenuAction` | `label`, `icon`, `shortcut`, `danger`, `disabled`, `onSelect` | yes (`closeOnClick: false` keeps it open) |
| `MenuCheckbox` (`type: "checkbox"`) | on/off, `checked` and `onCheckedChange`: the owner holds the state | no |
| `MenuRadioGroup` (`type: "radio"`) | one `value` of `items`, optional `label` heading | no (`closeOnClick: true` for "pick the stage") |
| `MenuSection` (`type: "group"`) | a heading above `items` | n/a |
| `MenuGroup` (`items`) | a row that opens a submenu | n/a |
| `"separator"` | a divider; dangling ones (first, last, doubled) are dropped by `menuRows` | n/a |

- Never use an action with a tick for a current value: a choice among values is a `MenuRadioGroup`. A tick follows the owner's state, so a menu left open updates when the owner does (the rows are recomputed from `entries`).
- Names for screen readers: the label, `, selected` for a checked radio, `, checked` for a checked checkbox, the parent's label and `: ` before the label inside a submenu. nsh has no menuitemradio role, so the state is in the name and in `accessibilityState.checked`.
- A `disabled` row is plain muted text and icon (`rowTone`), never tinted: a disabled danger row does not turn pink. It takes the highlight from keys and pointer (Base UI keeps it focusable) and does nothing when chosen.

## Width

The menu and select popups take their edge from `EDGE.md`: no border beside the shadow ring in light, the hairline alone in dark.

A menu is as wide as its longest row needs, 208 to 320 pt (`menuWidth`, an estimate like `listWidth`: the text is not measured because the popup is sized first); a label is cut with an ellipsis only past 320. The label is sized by its text (`shrink`, not `flex-1`) and an empty spacer pushes the tick and the keycap right. Unverified: the headless harness cannot show a popup's measured width; `w-max` was not used because nsh lays an overlay out in a box the size of its host and the estimate does not depend on that.

`ActionMenu` has a `small` trigger (28 pt) for a toolbar of small buttons.

## Keys

The focus stays on the trigger (nsh cannot focus a view from code); the highlight is one signal moved by keys and pointer, `selected` for screen readers, and `announce` says the row a key moved to.

- Up and Down (wrapping unless `loop={false}`), Home and End, Page Up and Page Down (a screenful, never wrapping): `stepIndex`, `edgeIndex`, `pageIndex`.
- Right opens a submenu on its first row, Left leaves it, Escape closes the innermost popup only (`Overlay`'s `onCancel` goes to the top one), Return and Space choose.
- Letters find a row (`typeahead`): accents and case ignored, a session starts after the highlighted row, the same letter again cycles through the rows that start with it (unless some row starts with a doubled letter), the session ends after `TYPING_RESET_MS` or at a key that finds nothing, and a space after letters continues the word, while a space alone chooses. Time is passed in, so there is no timer to cancel.
- A closed `SelectField` is typed into like a native one: letters choose the option they find (not when `readOnly` or `multiple`).
- Tab closes a menu opened from a focused trigger (`closeOnBlur`).

## Pointer

- A row's `onMouseEnter` highlights it; leaving clears it (`highlightItemOnHover={false}` turns that off). Only a panel that has a submenu listens to `onMouseMove`: it needs the position for the safe triangle (`inTransit`).
- A submenu opens after the pointer rests 100 ms; next to an open submenu the next one opens at once.
- `openOnHover` on `ActionMenu` opens the menu after `delay` (100) and closes it `closeDelay` (0) after the pointer left the button and the popup (`createHoverIntent`). Leaving toward the popup waits `TRANSIT_MS` for the pointer to arrive. A menu opened by a press never closes by leaving, and a press within 500 ms of a hover opening keeps it open (`pressTrigger`). The hover event of a view carries no position, so the transit wait always applies.
- Not ported: opening on press-down and choosing by releasing over a row (a nsh press is down and up on one view).

## Popups that must not be left behind

`Surface` closes with a reason (`createOpenState`, `OpenReason`):
`outside-press`, `escape-key`, `item-press`, `focus-out`, `trigger-press`, `trigger-hover`, and
- `anchor-moved`: the trigger scrolled or moved (`anchorMoved`), or the window was resized. A popup does not follow its trigger out of its list;
- `imperative`: a dialog opened above it (`dialogDepth`).

`RowMenu` hangs its menu from a zero-size view inside the row, at the pointer, so scrolling the list moves the anchor and closes the menu. A popup inside a dialog lives in the dialog's root view and needs nothing else. nsh gives JS no window-active signal: switching apps leaves a menu open that was opened by the pointer (a focused trigger's blur closes the others).

## Long lists

A panel taller than 384pt scrolls, and so does one taller than the room beside its trigger: `Surface` measures the trigger after the first frame and, when the popup fits neither above nor below (`fitRows`, `roomAround`), rebuilds the rows no taller than the larger side (shadcn's `max-h-(--available-height)`). Without that nsh puts a popup that fits neither side on the larger one and clamps it into the window, over its own trigger. A menu that fits is never rebuilt. A scrolling panel gives its rows 8pt on the right so the scroll bar never covers the highlight or the tick. With more than 30 rows and no submenu it is a `List` (only the rows in view exist, cells are recycled, rows read their data as accessors); otherwise a `Scroll`. Opening a select of 500 machines builds about twenty rows. The keys keep the highlighted row in view (`revealOffset`), and a list opens centered on its value (`centerOffset`) moved to a row boundary (`snapScroll`), so the first visible row is whole and never cut mid-glyph; the chosen row stays in view, and in the pop-up button look the popup moves with the offset so that row stays on the trigger. Heights are fixed constants of `menu.tsx` (an item, a heading, a divider) so offsets are a prefix sum (`offsetsOf`); they are still the standard tier and move to the compact tier of `lib/layout.ts` with the type re-cut (owed). A menu with submenus is `Scroll`: its rows exist, keep it to tens.

## SelectField

`items` are options, `SelectGroup`s (a heading) and `"separator"`; `disabled` per option; `multiple` makes `value` an array and `onChange` get an array, the list stays open and ticks (`toggled`); `isItemEqualToValue` compares values; `readOnly` opens and browses but chooses nothing; `disabled` neither focuses nor opens; `required` and `invalid` add to the accessible name, and `invalid` draws the border; the select takes part in its `Labeled` field and in a `Form` (`useFieldControl`): a required select left empty stops the submit and its message is announced, since a select cannot take the focus from code (it has no form name, `name` being its accessible name, so its value is not in `values`); `name` is the accessible name when there is no `label`. `open`, `defaultOpen` and `onOpenChange` make the open state controlled (`createOpenState`; `change.cancel()` vetoes).

`alignItemWithTrigger` (default true) is Base UI's pop-up button look: the list is placed so the chosen option sits on the trigger (`alignSelected`: the viewport is as tall as the window allows, scrolled as little as it must be). It is the `Overlay` anchored to the trigger with a negative `offset`, so it still follows the trigger. When the trigger is too near an edge for that, the list goes under it (Base UI's fallback). The list is at least as wide as the trigger and `LIST_MIN` (176) and grows to its longest option, up to `LIST_MAX` (480) and the window (`listWidth`; Base UI sizes it `min-width: var(--anchor-width)` and lets it grow, so "4.5 (recommended)" is read whole). The text is estimated, not measured, because the list is sized before it is built. Rows then hang like the trigger's text: the choice list's rows have 6pt of padding inside the popup's 5, the trigger has 11.

## Not ported, and why

Scroll arrows (native scrolling and a `List` instead), modal scroll lock and backdrop (an overlay and an outside press instead), hidden form input and autofill (no web form), the close-parent-on-Escape option and the item-highlighted callback (no caller), menubar and filterable menus (a desktop screen has no use yet).

## Tests

`navigation.test.ts` (step, page, typeahead, offsets, alignment, safe triangle, hover intent), `menu.test.ts` (`menuRows`: checkbox and radio semantics, dividers; `menuWidth`, `rowTone`), `menu.test.ts` also covers `fitRows`, `roomAround` and `snapScroll`, `select.test.ts` (`selectRows`, `toggled`, `listWidth`), `components/select-form.test.tsx` (a required select in a form), `components/menus.test.tsx` (keys, selection, 500-machine select, dialog, context menu) over `components/menus.fixture.tsx`. Hover, the safe triangle, alignment and the hover open are checked with screenshots: the headless harness has no hover and does not open submenus.
