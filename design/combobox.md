# Combobox and Autocomplete

Ported from Base UI's Combobox and Autocomplete (`components/kit/combo.tsx`; the rules without UI are in `components/kit/combo-rules.ts`, unit-tested in `combo.test.ts`; the whole thing end to end in `components/combobox.test.tsx` against `components/combobox-probe.tsx`). Which one to use is in `design/forms.md`: `Combobox` holds one of `items` (or several), `Autocomplete` holds whatever is typed.

## Shape

- The input keeps the keyboard focus the whole time and the list is never focused (a view cannot take the focus from code). The highlight is a position that Up and Down move; Enter picks it; `announce` tells a screen reader the row, and the count after typing settles (`SAY_MS`).
- The list is `ListPopup`: a `Positioner` under the field (an `inline` one is a box in the page), holding one `List` of recycled rows (`Row` reads its position as an accessor and keeps no state). Group headings are rows of their own. Rows are `ROW_H` (32) and headings `HEAD_H` (28): a row's place is arithmetic, so keeping the highlight in view is `revealOffset` and `scrollToOffset`, nothing is measured.
- Nothing is built while closed: the scan, the list, the key bindings (`navigable`) and the count announcement exist only while `visible()`. The owner's `items` is read once, through a `computed`, so an inline `.map` is not re-run per read.
- A dialog is its own root view: the `Positioner` is placed in the root of its anchor, so a list in a dialog needs nothing. A list in the app root closes when a dialog opens above it (`dialogDepth`), and when a scroll carries its field away (`anchor-moved`; a field that grows because chips wrapped is not a scroll).

## Props

`Combobox`: `items` (`ComboOption`: `value`, `title`, `hint`, `group`, `disabled`, `keywords`), `value`, `onChange`; `multiple` turns `value` and `onChange` into arrays (chips). `onClear` (single) or `clear` (multiple) shows a clear button. `disabled`, `readOnly`, `required`, `invalid` (or `error`), `open`/`defaultOpen`/`onOpenChange(open, change)` (`change.cancel()` vetoes), `autoHighlight`, `openOnInputClick`, `inline`, `limit`, `filter` (your own match, or `null` when the owner already filtered), `loading`, `onInputChange`, `onItemHighlighted`, `itemToString`, `loopFocus`, `keepHighlight`, `maxChips`.

`autoFocus` focuses the input when the field appears (the first field of a dialog). `onInputChange(text, "type")` is also called when a composition ends with what it ended with, since the owner is not told while one is running.

`Autocomplete` takes the same where it applies, plus `mode` (`list` default, `both`, `inline`, `none`). `suggestions` are strings or `Suggestion`; `onPick` runs after `onChange`. Defaults differ on purpose: `Combobox` has `autoHighlight="always"` (the chosen row, else the first, is highlighted, so Enter picks), `Autocomplete` has none (Enter submits what was typed) and `openOnInputClick` false.

## Keys

| Key | Does |
|---|---|
| Down (closed, focused) | opens |
| Down / Up | next / previous row, disabled rows skipped; wraps; with no `autoHighlight` the step past an end highlights nothing (the input) before wrapping |
| PageDown / PageUp | seven rows |
| Enter | picks the highlighted row; nothing highlighted: closes (`Autocomplete`: calls `onSubmit`) |
| Escape | closes; a single `Combobox` shows its title again |
| Backspace in an empty multiple field | removes the last chip |
| Left at the start of the text | walks the chips (Left, Right); Delete or Backspace removes the one marked; any typing leaves them |

Up, Down and PageUp/PageDown are bound only while the list is open and not composing (`navigable`): only the newest binding of a key runs and it consumes the key. The chip keys are bound only while they apply (`createCore` and the effect in `Combobox`). A press on a row picks; the pointer highlights a row on entry (`onMouseEnter`, one per row, no per-frame handler), and leaving the list clears a pointer highlight unless `keepHighlight`.

## Text, value, input methods

- A single field shows `typed ?? title`. `typed` is what the user typed since the focus; `reconcileTyped` says when it goes back to the title (close, Escape, a single pick, the value changing under a closed field; a multiple pick keeps the filter until the list closes, so an owner that cancels that close keeps the list, the filter and the highlight).
- While the field still shows the title nothing is filtered: every option is offered (`filterQuery`). Emptying a single field calls `onClear` when it has one.
- An input method composes text with plain letters, and `onChange` sees half-composed text. While `onCompositionChange` says composing: the list keeps the answer of the text before the composition (`frozen`), Enter picks nothing, Up and Down are not bound, and a blur ends the state. Matching ignores case and accents (`foldFast`, `fold` for text with accents); every word must be in the title, the hint or the keywords; titles that start with the first word lead.
- `Autocomplete` `mode` is what the text does while a row is highlighted (`inlineText`): `list` filters and leaves the text; `both` filters and shows the row's text; `inline` shows every suggestion and the row's text; `none` shows every suggestion and leaves the text. A pointer highlight never rewrites the field; read-only never.
- Closing: Escape, an outside press, the input losing the focus. Pressing a row blurs the input first, so a blur closes after `BLUR_MS` unless a press is held (`hold` on the list, the chevron, the clear button and the chips).

## Scale (50,000 options)

- Each option's folded text is built when it is first scanned and kept with the option object (`entryOf`); `foldFast` skips the Unicode pass for text without accents. Folding 50,000 options costs about 180 ms; it is spread over the scan, never paid at once.
- The scan is time-sliced (`stepJob`, `SLICE_MS`, a timer between slices) so the host's 2 s limit and the frame are never in danger; the list shows the previous answer until the new one is ready. A longer query scans only what the shorter one matched and Backspace scans nothing (`createRefiner`). A short list answers in the keystroke's own turn.
- The list given to `List` is positions, never rows built by `Each`. Unfiltered it is a shared identity array (`ids`); grouping builds it once per opening.
- `limit` keeps the best matches and the list says how many were left out. `filter={null}` plus `loading` is the shape of a search the owner runs (`onInputChange` tells it what was typed).
- The dev panel shows `combobox.list`: the thread time of each change of the list.

Measured once on the host with the dev panel (open, type a query, scroll, 60 Down presses), JS p95 per commit and frame p95; the `Combobox` before this port (100 rows, folded every option per keystroke) in brackets. Re-measure after a change to the scan:

| options | open | type | scroll | Down x60 | memory |
|---|---|---|---|---|---|
| 5,000 | 0.1 ms / 0 ms (0 / 0) | 16 ms / 1.4 ms (0 / 4.7) | 8.8 ms / 3.3 ms (15,055 / 7.3) | 0.7 ms / 1.9 ms (3.8 / 0.2) | 64 MB (66) |
| 50,000 | 0.7 ms / 1.4 ms (3.2 / 0) | 2.5 ms / 1.4 ms (0 / 0) | 2.3 ms / 3.5 ms (0 / 10.2) | 0.7 ms / 1.8 ms (0 / 0) | 95 MB (76) |

The scan itself (`combobox.list`): p95 3.4 ms over a run of both sizes. Memory grows by the folded text of the options that were scanned (about 20 MB at 50,000).

## What is not taken

- Escape on a closed field does not clear it (a dialog's Escape would clear the field it closes); use the clear button.
- No hidden form inputs, no `Field` context (`invalid` and `error` are props), no grid mode, no submit-on-pick, no autofill, no virtualizer other than `List`.
- Not verifiable here: a real input method (the harness cannot compose), a screen reader.
