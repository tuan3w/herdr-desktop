# Typography

## Typefaces

Two faces, both under `fonts/` with their OFL licenses, registered by importing the files in the app entry (assets must live under the app's entry folder) and made the defaults by the `font-sans` and `font-mono` theme tokens, so no screen names a family.

| Face | Weights shipped | Use |
|---|---|---|
| Inter | 400, 500, 600, 700 | all text. A neutral UI face with wide Latin coverage; it stays quiet at 14pt, which is the point. A rounder display face looks larger and louder at the same size and makes every row feel heavy. |
| IBM Plex Mono | 400, 500 | identifiers: pane ids, paths, commands, host names and numbers that must line up (`Field mono`, the `mono` column of a `Table`). Characters line up and `0`/`O`, `1`/`I` differ, which matters when an id is read aloud or copied by eye. Small and muted in lists, never decorative. |

- Only the shipped weights exist: `font-normal`, `font-medium`, `font-semibold`, `font-bold`. Another weight falls back to the nearest and is a bug.
- Mono is for identifiers only. Names, times and prose stay in Inter.
- A new face must cover every script the app shows (agent names, paths and terminal output are user text) and have tabular figures.

## Sizes

| Use | Classes | Where |
|---|---|---|
| Page title | `text-3xl font-bold tracking-tight` | `PageHeader` |
| Detail title | `text-2xl font-bold` | the header of an open record (an agent, a machine) |
| Dialog title | `text-lg font-semibold` | `Modal` |
| Settings section | `text-base font-medium` | `SettingsSection` |
| Empty-state title | `text-base font-medium` | `Empty` |
| Body, row titles, labels | `text-sm` | most of the app |
| Meta, captions, tags, group labels | `text-xs` | `Pill`, `SectionTitle`, `Badge`, ages |

Six steps. Do not add `text-4xl` or arbitrary sizes (`text-[13px]`): hierarchy comes from the step, the weight and `foreground` against `muted-foreground`. Most of a screen is one size (`text-sm`); that sameness is what lets the one large title and the few grey labels read.

## Weights

| Weight | Use |
|---|---|
| normal | body, descriptions, values, labels in a form |
| `font-medium` | row titles, tabs, nav selected or not, buttons, group headings |
| `font-semibold` | dialog titles |
| `font-bold` | the page title and the detail title: nothing else |

**Never change weight on hover, selected or pressed.** A heavier label is wider, so the neighbours shift. Signal state with a fill or the text color (`selected:bg-accent`, `text-foreground` against `text-muted-foreground`).

## Numbers

An age, time or count that is its own `Text` uses `NUM` from `components/kit/core.ts` (`fontVariant: ["tabular-nums"]`), so digits keep a constant width and columns do not jitter when a value changes. Inter has tabular figures. A count written inside a `SectionTitle` string (`Needs you (3)`) is not tabular.

```tsx
// Correct
<Text style={NUM} class="w-16 text-xs text-muted-foreground">{age()}</Text>

// Incorrect: an age in a fixed-width column with proportional digits
<Text class="w-16 text-xs text-muted-foreground">{age()}</Text>
```

`Pill` and `Badge` apply `NUM` themselves. `PageHeader` applies it to the subtitle.

## Case, spacing, width

- Sentence case everywhere. **Nothing is uppercase** and nothing is letter-spaced: a small grey `text-xs font-medium` label (`SectionTitle`, a sidebar group label) groups as well as capitals do without shouting.
- `tracking-tight` only on the page title.
- Hint text: `max-w-sm` (`Empty`). A setting's description: `max-w-lg`. A page's content column: `max-w-3xl`, centered. Long prose does not run the full window width.
- Cut text is a `Clipped` (`design/components.md`): one line with an ellipsis (two for a preview), and hovering a cut one shows all of it. Never cut what must be read to act: a toast and a field's error wrap in full, a `Modal` scrolls its content, a table column or the sidebar gets room (a resizable sidebar takes room from a page; a table drops optional columns).
- Text color alpha does not exist: dim secondary text with `opacity-60` on the `Text`, or use `text-muted-foreground`.

## Copy

- English, sentence case: `New agent`, not `New Agent`.
- A button says what it does, with a specific verb: `Stop agent`, `Close pane`, `Mark reviewed`. Not `Submit`, `OK`, `Confirm`.
- A destructive confirm names the object and what goes with it, with numbers (`confirmDestructive` in `components/kit/modal.tsx`).
- An error or empty state says what to do next: `Change the filter or the search.`, `No agents on this machine. Start one with New agent.`
- A toast is past tense and names the object: `Stopped agent api-fix`.
- No "please": the app speaks directly.
- In a `Field`, the placeholder shows an example or a format, never the label. A bare `Input` in an add-row has no label, so its placeholder is the hint (`Host name`, `Path`).
- Counts sit next to their noun in the same string: `Needs you (3)`, `2 panes`.
- A settings row says what the setting is and, in one line, what it changes: `Collapse the sidebar` / `Show only icons to give the content room. A narrow window collapses it by itself.`
- Input methods type with plain letters, so a bare letter is never a global shortcut (`design/patterns.md`).
