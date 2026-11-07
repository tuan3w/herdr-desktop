# Inputs: fields, forms, numbers

How a field knows its label, its error and its form, and how a number is typed. Which field to pick and dialogs are in `design/forms.md`; the code is `components/kit/field.ts` (rules), `field-parts.tsx` (parts), `form.ts`, `fields.tsx`, `number.ts` and `number-field.tsx`. Ported from Base UI's `Field`, `Fieldset`, `Form`, `Input` and `NumberField`; what a desktop host cannot do is listed at the end.

## The contract

A `FieldRoot` owns one `Field` (`createField`): `name`, `disabled`, `invalid`, `touched`, `dirty`, `filled`, `focused`, `valid` (`true`, `false`, or `null` while unknown, pending or disabled), the label and description text, `errors()`, `validationMode` and `validationDebounceTime`. `Labeled` is a `FieldRoot` with a label above and the error or hint below; `Field` and `NumberField` are `Labeled` plus a control.

A control calls `useFieldControl` once in its body, under its `FieldRoot`:

```tsx
const control = useFieldControl({ value: () => props.value, required: () => props.required, focus: () => input?.focus() });
<Input {...} accessibilityLabel={control.label()} accessibilityHint={control.hint()} disabled={control.disabled()}
  onFocus={control.focused} onBlur={() => control.blurred()} class={control.invalid() ? INPUT_ERROR : ""} />
```

- The value is followed through `value`: no handler reports a change. A change clears the form's error for that name, sets `dirty` and `filled`, and validates by the mode.
- There is no DOM here: no ids, no `aria-labelledby`. The label and the description are registered text; the control reads them as `accessibilityLabel` (the label) and `accessibilityHint` (the error while one shows, else the description). A `FieldLabel` press focuses an input control.
- What is wrong with a value is reported as `Violation`s (`violations`: `badInput`, `rangeUnderflow`, `tooShort`...), plus `required` (`valueMissing`). There is no native constraint validation. `MESSAGES` are the English defaults; a violation or a `FieldError` child gives its own text.
- Without a `FieldRoot` above, a control gets a field of its own, so it works alone. `FieldItem` gives one item of a group (a checkbox) its own label and disabled state; `Fieldset` and `FieldsetLegend` disable and name a group.
- A wrong control that is not an input leaves out `focus` (a view cannot take the keyboard focus from code).

## When it validates

`validationMode` on the field, else on the `Form`, else `onSubmit`.

| Mode | Checks |
|---|---|
| `onSubmit` | at the first submit, then on every change |
| `onBlur` | when the control is left, and an error that shows is retired on the keystroke that fixes it |
| `onChange` | on every change (`validationDebounceTime` waits for the last; an empty value is checked at once) |

- An empty `required` field is not an error until it was changed or a submit checked it, so a fresh form is not red. In `onBlur` mode leaving it empty counts (Base UI waits for a change).
- Broken constraints come first; the field's `validate` runs when they pass (always in `onChange`). Async `validate` makes the field `null` while it runs, a superseded result is dropped, a rejected one keeps what was shown, and under `onSubmit` it does not hold a submit back.
- What shows, first wins: the owner's `error` prop (`Labeled`), the form's `errors[name]`, the field's own rules. A disabled field shows none (an owner's `invalid` still holds).
- An error is announced once as `label: message` by the `FieldRoot`. `FieldError` draws it (alert icon, red text); `match` limits it to one constraint, `errorInLabel` moves it to the label line, `reserve` keeps its line.

## Forms

`createForm` (or `<Form validationMode errors onFormSubmit>`) collects the fields that registered.

- `form.submit()` (a button, or Return in a single-line field after its own `onSubmit`) validates every enabled field. If one is wrong it stops and moves the keyboard focus to the first wrong input in the order the fields were made; if the wrong ones are not inputs it announces the first and the user reaches it with Tab. Otherwise `onFormSubmit(values)` gets the values of the enabled, named fields.
- `errors` are messages by field name from the owner (a server, a rule over several fields). They make the field invalid, one goes when its field changes, a new object replaces all, and errors that arrive after a successful submit move to the first field they name.
- Put the form's button outside it with `<Form form={form}>` and `onPress={() => form.submit()}`.

```tsx
const form = createForm({ onFormSubmit: (values) => save(values) });
<Form form={form}><FieldRow><Field name="machine" required label="Machine *" value={...} onChange={...} /></FieldRow></Form>
```

## Number field

`NumberField` is for ports, counts, sizes, limits. The value is a `number` or `null`: empty is not 0.

- Shown with `formatNumber`: `Intl.NumberFormat("en-US")` (it exists in this host): `1,234.5`, every digit of the value (never rounded to three), and `format` takes Intl options (`style: "percent"`, `currency`, `maximumFractionDigits`). Units Intl lacks (`lines`, `panes`) are the `unit` prop, written after the box.
- Read with `parseNumber`, in either convention. Both `.` and `,`: the last is the decimal (`1,234.5` and `1.234,5` are 1234.5). One kind twice: grouping by three. A lone `.` is always the decimal (`1.234` is 1.234). A lone `,` is thousands only before exactly three digits after 1 to 3 digits not starting with 0 (`1,234` is 1234; `1,5`, `0,234` and `12,3456` are decimals). So `12,345` meant as twelve and a bit reads as 12345: the English convention first. Spaces and `'` group, a sign leads or trails, labels and `%` are ignored.
- Typing is refused for any character a number does not have (`canBeNumber`); the text is put back. Half-composed text from an input method is kept and read when the composition ends. A text that is not a number yet (`-`, `1,`) keeps the last value; on blur it is `badInput` and stays as typed.
- Blur and Return commit: clamped to `min` and `max` (not with `allowOutOfRange`, which reports `rangeUnderflow` / `rangeOverflow`), rounded to `format`'s fraction digits, written back formatted. Escape takes back the text typed since the last commit.
- Steps (`stepBy`) are exact decimals (`0.1 + 0.2` is `0.3`): Up and Down `step`, Shift or Page keys `largeStep`, `mod` `smallStep` (never `alt`), Home and End the bounds only when both exist, and from an empty field the first step lands on 0 (or the nearest allowed value). `snapOnStep` lands on the grid from `min`. The keys bind only while the field has the focus.
- The `−` and `+` appear on hover or focus, are named `Decrease: label` and `Increase: label`, and repeat while held after `HOLD_DELAY_MS` every `HOLD_TICK_MS` (`createHold`), stopping at a bound. Shift or `mod` held at the press sets the amount. The input is `role="spinbutton"` with `accessibilityValue` and increment and decrement actions.

## Other inputs

- Return: `onSubmit` fires, then the form's `submit`; the input keeps the focus. Escape: a `SearchField` with text clears it; a `NumberField` with an uncommitted text reverts it; otherwise it is the screen's (dialog, list).
- `autoComplete`: `off` for text, an address value for `address`, `password` for `masked`; `autoCorrect` is off for `address`, `mono` and `masked`; `NumberField` asks for the decimal or punctuation keyboard.
- `Field` takes `required`, `readOnly`, `minLength`, `maxLength` and `pattern`; every field takes `name`, `disabled`, `invalid`, `validate`, `validationMode`. `onPaste` hears what was pasted (text, image `File`s, `file:` URLs) and the field still inserts the text: it is how a prompt box takes a screenshot.
- A number that cannot be read is `badInput`: flagged after blur, and a form will not submit it.

## Not taken

- Scrub area, wheel scrubbing and the input mode: no pointer lock or wheel on an `Input`, and a desktop has no soft keyboard.
- `stepMismatch` is not checked: 12.5 against a step of 1 is a real value. `snapOnStep` and `validate` cover it.
- Per-control ids and `aria-describedby`; Base UI's registration order by document position (here: the order the fields were made).
