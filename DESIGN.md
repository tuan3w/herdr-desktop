# herdr-desktop design

herdr-desktop is a quiet, dense, keyboard-first desktop tool for someone who supervises coding agents all day. It looks like a page, not a dashboard: a white surface, a sidebar one shade off it, text in two greys, hairlines instead of boxes, and colour spent only where it means something (the main button, one "needs you" signal, status text). The loudest thing on any screen is what needs the person; everything else is quiet and nothing moves at rest. If a screen has more borders, capsules, weights or colours than the same screen would in Notion, remove them. Four themes (Harbor, Container, Chart, Graphite), each light and dark, change only where that colour goes. Every action the user cannot trivially reverse says what happened and offers a way back.

Read the file that matches your change before writing UI:

| Changing | Read |
|---|---|
| a colour, a surface, a status, the sidebar surface, terminal colours | [design/colors.md](design/colors.md) |
| a theme, or how themes switch | [design/themes.md](design/themes.md) |
| text size, weight, fonts, numbers, copy | [design/typography.md](design/typography.md) |
| a button, icon, pill, badge, tab, switch, menu, spinner, sidebar | [design/components.md](design/components.md) |
| a tooltip, popover, preview card or any popup: when it opens, closes, follows | [design/overlays.md](design/overlays.md) |
| a menu, a context menu, a select | [design/menus.md](design/menus.md) |
| a combobox, an autocomplete, a pick list | [design/combobox.md](design/combobox.md) |
| a field's label, error and validation, a form, a number field | [design/inputs.md](design/inputs.md), [design/forms.md](design/forms.md) |
| a checkbox, radio, tabs, collapsible, accordion, progress, avatar, accessibility of a control | [design/controls.md](design/controls.md) |
| a dialog, a toast, undo | [design/dialogs.md](design/dialogs.md) |
| a table, a list of many records, sorting | [design/data.md](design/data.md) |
| feedback, undo, delete, shortcuts, settings, window size | [design/patterns.md](design/patterns.md) |
| anything that moves | [design/motion.md](design/motion.md) |

Tokens come from `lib/theme/` (`theme.json` is the default theme's generated copy), motion values from `lib/motion.ts`, the UI kit from `components/kit/` (import everything from `./kit`, never from a file inside it). Those are the source of truth; these docs describe them. `docs/ACCESSIBILITY.md` is the checklist every screen answers to.

## The look: quiet

Check every new screen against these before anything else.

1. **No boxes.** A list is plain rows (`h-9`, `rounded-md`, `hover:bg-accent`), not cards. No border under every row; a hairline only under a header or between major sections.
2. **Two greys, two weights.** Text is `foreground` or `muted-foreground`. Body is regular, row titles and labels `font-medium`, only a page title is `font-bold`. Nothing is uppercase.
3. **Colour is rare.** Grey everywhere; `primary` for the main button and checked boxes; `signal` for what needs the user; status colours as text. A tinted background is a `Pill` and nothing else.
4. **Words, not capsules.** Ages, counts and machine names are plain muted text joined by ` · `. A count is a grey number; only one that needs the user is a capsule.
5. **Actions on demand.** Per-row actions appear on hover or focus (`group` + `group-hover:opacity-100 group-focus-within:opacity-100`); they stay pressable and in the accessibility tree. Page-level actions stay visible.
6. **Small controls.** Buttons and inputs 32pt, dense buttons 28pt, icons 16pt at 1.5 stroke in grey, rows 28 to 40pt.
7. **Status is a shape first.** Needs you = filled with bar, working = half, done = check, idle = empty ring, unknown = dashed ring, then a word, then colour. Colour is never the only signal.

## Rules

1. **Semantic tokens only.** Screens set colour through classes (`bg-card`, `text-muted-foreground`, `border-border`) and icons through `IconTone`, never hex, `oklch()` or `rgb()`: a theme is chosen at runtime. Terminal colours are the one palette that is not a UI colour; they are `term-*` tokens (`design/colors.md`).
   - One raw value exists: the dialog scrim `bg-black/40` in `components/kit/modal.tsx` (a scrim is black in every theme).
   - Tone tints on `success`, `warning`, `info`, `destructive` and `primary` are allowed with a light and a `dark:` opacity (see `Pill`).
   - Alpha does not work on text colours (`text-x/60` is an unknown class): use `opacity-*` on the `Text`.
2. **Kit first.** A screen title is `PageHeader`, a section heading `SectionTitle`, a text field `Field`, a long list to pick from `Combobox`, a count `Badge`, a status tag `Pill`, cut text `Clipped`, many records a `Table`, an icon-only control `IconButton`, a row's "more" `ActionMenu`, feedback `notify`. Do not paste their class strings into a screen. There is no `Card`: see "The look".
3. **State never changes layout.** Selected, hover, disabled, loading and error change colour only: no weight swap, no border-width swap, no size change. A message that may appear reserves its line (`reserve`).
4. **Every control has a name.** Text buttons carry their label; icon-only buttons are `IconButton` with a required `label`; inputs carry `accessibilityLabel` (`Field` sets it); a `Switch` and an `ActionMenu` take a `label`. A glyph such as `✕` is never a name: use `Icon`. The name never contains the role word.
5. **Focus is always visible.** Pressables use `FOCUS_RING` (outline), the sidebar `FOCUS_RING_SIDEBAR`, stacked rows with a selected fill `FOCUS_RING_INSET`. `ring-*` classes draw nothing on the host.
6. **Nothing is lost silently.** Reversible edits go through `notify(..., { undo })`. Irreversible ones (close a pane, remove a machine) go through `confirmDestructive`. Nothing is ever approved silently: a risky answer is two-step, never a timed hold. See `design/patterns.md`.
7. **Motion goes through `lib/motion.ts`.** See `design/motion.md` for what animates and what never does; `reduceMotion()` switches it off.
8. **One primary per area.** An area is a page header, a dialog, or an add-row. Repeated rows have no filled button: their actions are `outline` or `ghost` and appear on hover.
9. **The layout answers to the window.** Three widths are tested: 1280, 960 (rail sidebar) and 760 (one pane at a time), and `fontScale()` 2.0. Use `compact()`, `rail()`, `narrow()`; never read the window size in a screen.
10. **Anything the user can choose is in Settings.** A new option is a signal in `lib/settings.ts` (with `Saved` and `loadSettings`, as its header comment says) and an entry in Settings.
11. **When it does not fit, say so or make room.** One row has one control height. Cut text is a `Clipped` (hover shows it all); text that must be read is never cut. A `Modal` taller than the window scrolls its content between a fixed title and fixed actions. A long pick list is a virtualized `List`.
12. **Shortcuts are `lib/shortcuts.ts`.** Global ones carry `mod`, never `alt`; hints and tooltips name keys through `keyLabel`.

## Nothing else exists

Closed lists. Adding a value means editing `components/kit/` and this file in the same change.

- `Btn` variants: `primary`, `outline` (default), `ghost`, `danger`. There is no `secondary`, `link` or `success`.
- `Pill` tones: `neutral` (default), `success`, `warning`, `danger`, `info`. `Badge` tones: `neutral` (default), `signal`, `primary`, `danger`.
- `IconName` (26): `alert`, `arrow-left`, `check`, `chevron-down`, `chevron-left`, `chevron-right`, `circle-check`, `clock`, `copy`, `download`, `ellipsis`, `image`, `link`, `list`, `loader`, `monitor`, `moon`, `panel-left`, `plus`, `refresh`, `search`, `sliders`, `sun`, `trash`, `undo`, `x`. New icon: add `components/kit/icons/<name>.svg` (24-unit stroke, `stroke="#000"`) and register it in `icon.tsx`.
- Themes: `harbor`, `container`, `chart`, `graphite` (`lib/theme/themes.ts`).
- Fonts: Inter (text), IBM Plex Mono (identifiers: pane ids, paths, commands, host names), both under `fonts/` with their OFL licenses.

## Verify

```sh
nsh check                       # types
nsh test                        # behaviour, undo, keyboard, themes (contrast), narrow window, reduced motion
bun scripts/gen-theme.mjs       # only after changing the default theme's spec
```
