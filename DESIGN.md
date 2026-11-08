# herdr-desktop design

herdr-desktop is a dense, calm, keyboard-first desktop tool for someone who supervises coding agents all day. It is a window of 1280 pt or more with a pointer and a keyboard, not a wide phone: the bar is **density** (a dozen agents visible and still room to read one), **regions** (each part of the window has one job) and **once per view** (an agent, a fact and a mark each appear once). Calm means said once and quiet, never empty: unused width and oversized type are defects. Its look is a page, not a dashboard: a surface, a sidebar one shade off it, text in two greys, hairlines instead of boxes, colour only where it means something.

**The window has four regions.** Sidebar: the one list of every agent, grouped by project, state on the row. Main: the one agent being worked on, or the Board, or Settings. Inspector (right, collapsible, remembers its state): what you consult, not read (overview, changes, files, terminal). Status: connection truth per machine. An agent is listed once per view; the conversation keeps a readable measure and extra width goes to the inspector, never to margins. A text button that opens a dialog of facts about the open agent is a missing inspector.

Every border, weight and colour must answer one of the supervisor's five questions (`AGENTS.md`: does anything need me, is it alive, what did it do, steer it, can I trust it). One that answers none is removed; space that holds nothing is removed just as hard. The loudest thing on any screen is what needs the person, motion only explains a change and nothing moves at rest. Four themes (Harbor, Container, Chart, Graphite), each light and dark, change only where that colour goes. Every action the user cannot trivially reverse says what happened and offers a way back.

Read the file that matches your change before writing UI:

| Changing | Read |
|---|---|
| a colour, a surface, a status, the sidebar surface, terminal colours | [design/colors.md](design/colors.md) |
| a theme, or how themes switch | [design/themes.md](design/themes.md) |
| text size, weight, fonts, numbers, copy | [design/typography.md](design/typography.md) |
| a button, icon, pill, badge, switch, menu, spinner, sidebar, rail | [design/components.md](design/components.md) |
| the Board (project table, filter chips), answering, bulk actions, the status bar | [design/board.md](design/board.md) |
| a tooltip, popover, preview card or any popup: when it opens, closes, follows | [design/overlays.md](design/overlays.md) |
| a menu, a context menu, a select | [design/menus.md](design/menus.md) |
| a combobox, an autocomplete, a pick list | [design/combobox.md](design/combobox.md) |
| a field's label, error and validation, a form, a number field | [design/inputs.md](design/inputs.md), [design/forms.md](design/forms.md) |
| a checkbox, radio, tabs, collapsible, accordion, progress, avatar, accessibility of a control | [design/controls.md](design/controls.md) |
| a dialog, a toast, undo | [design/dialogs.md](design/dialogs.md) |
| a scrollbar, a scrolling list, keeping the place while it scrolls | [design/scroll.md](design/scroll.md) |
| a table, a list of many records, sorting | [design/data.md](design/data.md) |
| Changes: changed files, diffs, notes to the agent, revert | [design/changes.md](design/changes.md) |
| Files in the inspector, a viewer, a picture, a diagram, a page from a machine, sending a file | [design/files.md](design/files.md) |
| the tab strips: main-region tabs, inspector tabs | [design/tabs.md](design/tabs.md) |
| the pane view and the terminal agent's conversation | [design/pane.md](design/pane.md) |
| switching between projects and agents (contexts, Switcher, back and forward) | [design/context.md](design/context.md) |
| the chat's permission dock, a question form, New session, Past sessions, session details | [design/chat-parts.md](design/chat-parts.md) |
| feedback, undo, delete, shortcuts, settings, window size | [design/patterns.md](design/patterns.md) |
| spacing, type sizes, row heights, radii, widths, elevation | [design/foundations.md](design/foundations.md) |
| where the signal colour may appear, what a waiting agent looks like on each surface (a mark on its row, once) | [design/attention.md](design/attention.md) |
| anything that moves | [design/motion.md](design/motion.md) |
| the chat tab: the conversation, work groups, tool rows, the message box, queue, attachments | [design/chat.md](design/chat.md) |
| the command palette: scopes, ranking, rows, actions, two-step commands, files | [design/palette.md](design/palette.md) |

Tokens come from `lib/theme/` (`theme.json` is the default theme's generated copy), sizes from `lib/layout.ts` (with the `"tailwind"` scale of `nsh.json`), motion values from `lib/motion.ts`, the UI kit from `components/kit/` (import everything from `./kit`, never from a file inside it). Those are the source of truth; these docs describe them. `docs/ACCESSIBILITY.md` is the checklist every screen answers to.

## The look: quiet

Check every new screen against these before anything else.

1. **No boxes inside boxes.** A list is plain rows (`ROW`, `rounded-md`, `hover:bg-accent`), not cards; a hairline only under a header or between major sections. Why: the Board once drew the sidebar's list again as cards inside a card. Decided, not built yet: the Board is a table grouped by project (`design/board.md`).
2. **Two greys, two weights.** Text is `foreground` or `muted-foreground`. Body is regular, row titles and labels `font-medium`, only a page title is `font-bold`. Nothing is uppercase.
3. **Colour is rare.** Grey everywhere; `primary` for the main button and checked boxes; `signal` only for the mark on a waiting agent's row (said once per agent per view, `design/attention.md`); status colours as text. A tinted background is a `Pill` and nothing else.
4. **Words, not capsules.** Ages, counts and machine names are plain muted text joined by ` · `. A count is a grey number; there is no capsule.
5. **Actions on demand.** Per-row actions appear on hover or focus (`group` + `group-hover:opacity-100 group-focus-within:opacity-100`); they stay pressable and in the accessibility tree. Page-level actions stay visible.
6. **Density, not size.** Sizes (text, controls, rows, icons, gaps) are in `lib/layout.ts` and `design/foundations.md`; the first scale was a phone's, so a row is one line and a dozen agents fit in the sidebar at 1280 x 800 (a cutover to a desktop scale is in progress: do not restate numbers in a screen or a doc). Why: at the phone scale eight agents filled the sidebar and sidebar text ran about 1.4 times wider than in comparable apps (unverified, from screenshots). Icons are grey at 1.5 stroke.
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
9. **The layout answers to the window.** Three widths are tested: 1280, 960 (the full sidebar at its narrow width, `snug()`) and 760 (the rail of project tiles, one pane at a time), and `fontScale()` 2.0. Decided, not built yet: below about 1000 pt the inspector overlays instead of squeezing the conversation (unverified). Use `compact()`, `rail()`, `narrow()`, `snug()`; never read the window size in a screen.
10. **Anything the user can choose is in Settings.** A new option is a signal in `lib/settings.ts` (with `Saved` and `loadSettings`, as its header comment says) and an entry in Settings.
11. **When it does not fit, say so or make room.** One row has one control height. Cut text is a `Clipped` (hover shows it all); text that must be read is never cut. A `Modal` taller than the window scrolls its content between a fixed title and fixed actions. A long pick list is a virtualized `List`.
12. **Shortcuts are `lib/shortcuts.ts`.** Global ones carry `mod`, never `alt`; hints and tooltips name keys through `keyLabel`.
13. **Taste.** What the owner corrects in every render (nothing jumps, one surface per thing, text whole or faded, quiet at rest, tooltip and toast placement, say it once) is `design/taste.md`.

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
make test                       # (never bare `nsh test`: AGENTS.md) behaviour, undo, keyboard, themes (contrast), narrow window, reduced motion
bun scripts/gen-theme.mjs       # only after changing the default theme's spec
```
