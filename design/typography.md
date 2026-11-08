# Typography

## Typefaces

Two faces, both under `fonts/` with their OFL licenses, registered by importing the files in the app entry (assets must live under the app's entry folder) and made the defaults by the `font-sans` and `font-mono` theme tokens, so no screen names a family.

| Face | Weights shipped | Use |
|---|---|---|
| Inter | 400, 500, 600 (700 is still shipped, used by nothing once callers migrate) | all text. A neutral UI face with wide Latin coverage; it stays quiet at 13 pt, which is the point. A rounder display face looks larger and louder at the same size and makes every row feel heavy. |
| IBM Plex Mono | 400, 500 | identifiers: pane ids, paths, commands, host names and numbers that must line up (`Field mono`, the `mono` column of a `Table`). Characters line up and `0`/`O`, `1`/`I` differ, which matters when an id is read aloud or copied by eye. Small and muted in lists, never decorative. |

- Only `font-normal`, `font-medium` and `font-semibold` are used. Another weight falls back to the nearest and is a bug.
- Mono is for identifiers only. Names, times and prose stay in Inter.
- A new face must cover every script the app shows (agent names, paths and terminal output are user text) and have tabular figures.

## Sizes

Two tiers (emil-typography: sizes come from a scale, leading follows role). **Chrome** is the dense UI around the work: sidebar, rows, controls, buttons, meta. **Reading** is text read in paragraphs: chat prose and Markdown. Sizes are logical px (`TYPE` in `lib/layout.ts`).

| Class | Size / line | Tier | Used for |
|---|---|---|---|
| `text-xs` | 12 / 1.4 | chrome | meta lines, ages, tags, counts, captions, group labels (`Pill`, `SectionTitle`, `Badge`). 12 is the floor: below it Inter loses its counters |
| `text-sm` | 13 / 1.4 | chrome | row titles, labels, buttons, fields, menus, nav (most of the app) |
| `text-base` | 14 / 1.55 | reading | chat prose and Markdown body; also a section heading in Settings and an empty state's title, set `font-medium` |
| `text-lg` | 16 / 1.4 | heading | a dialog's title, a Markdown second-level heading |
| `text-xl` | 18 / 1.35 | heading | a Markdown first-level heading; not used elsewhere yet (kept so the scale has no hole) |
| `text-2xl` | 22 / 1.3 | heading | the title of an open record |
| `text-3xl` | 26 / 1.25 | heading | a page title (`PageHeader`) |

Why these numbers: desktop chrome sits at 13 with 12 meta (a phone scale of 15 and 13 was 2 to 4 px too big and cost one row in six); reading text stays at 14 because long lines want a bigger size and more leading (1.55; chrome 1.4 so a one-line control stays short); headings step about 1.2 and tighten (1.25 at 26) as display type wants. Do not add `text-4xl` or arbitrary sizes (`text-[13px]`): hierarchy comes from the step, the weight and `foreground` against `muted-foreground`. Most of a screen is one size (`text-sm`); that sameness is what lets the one large title and the few grey labels read.

## Weights

Three weights are used (emil: restraint; every weight is another file and another level of hierarchy).

| Weight | Use |
|---|---|
| normal | body, descriptions, values, labels in a form |
| `font-medium` | row titles, tabs, nav, buttons, group headings, section headings |
| `font-semibold` | dialog titles, the page title and the detail title |

`font-bold` is retired: at 22 to 26 pt semibold is already clearly heavier than 13-pt medium, and Inter 700 is the file that would go next. A caller that still writes it is migrated to `font-semibold`.

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
- `tracking-tight` only on the page title (emil: display type tightens, text at reading sizes gets no tracking).
- Hint text: `max-w-sm` (`Empty`). A setting's description: `max-w-lg`. A page's content column: `COLUMN.page` (640) for settings and `COLUMN.chat` (768 with padding, so 720 of text) for the conversation, centered; the board's table is the one wide column (`COLUMN.home`). Long prose does not run the full window width.
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
