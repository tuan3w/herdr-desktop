# Foundations

The numbers every screen is built from. They live in two places and nowhere else: `lib/layout.ts` (code) and the `"tailwind"` block of `nsh.json` (the class engine's copy of the type, radius and shadow scales); `lib/layout.test.ts` fails when the two disagree. A screen never writes a size, a radius or a width of its own: it uses a scale class or imports a constant from `lib/layout.ts`.

The look is quiet (`DESIGN.md`) and it has room: the app runs on a desktop, so spacing is generous and a row is never smaller than it needs to be to be hit with a pointer.

## Spacing

A 4-pt base. Only these steps exist; a half step (`gap-1.5`, `px-2.5`, `py-0.5`) is a bug.

| Class step | Points | Used for |
|---|---|---|
| `1` | 4 | between a title and its meta line, icon to text inside a tight control |
| `2` | 8 | inside a control (`gap-2`), card padding, gap between small controls |
| `3` | 12 | row padding left and right, gap between a glyph and its text |
| `4` | 16 | dialog and panel padding, the inbox's padding |
| `6` | 24 | the page's edge, the gap between sections and between cards (`GAP.section`) |
| `8` | 32 | the end of a page (`pb-8`), a big empty state |
| `12` | 48 | rare: a fill-the-pane empty state |

`SPACE` in `lib/layout.ts` states the scale for code; `GAP` and `PAD` are the class strings a page spends it with: `GAP.row` (12) inside a row, `GAP.rows` (4) between the rows of a card, `GAP.section` (24) between sections and cards; `PAD.page` (24 at the sides, 24 on top) is a page's edge.

## Type

Inter for text, IBM Plex Mono for identifiers (`design/typography.md`). The scale is `TYPE` (points and line height):

| Class | Points / line | Used for |
|---|---|---|
| `text-xs` | 13 / 1.35 | meta lines, ages, tags, counts, captions |
| `text-sm` | 15 / 1.4 | body, row titles, labels, buttons (the unit of the app) |
| `text-base` | 17 / 1.4 | a card's name, a section heading in Settings, an empty state's title, the inbox heading |
| `text-lg` | 20 / 1.35 | a dialog's title |
| `text-xl` | 22 / 1.3 | not used yet (kept so the scale has no hole) |
| `text-2xl` | 26 / 1.25 | the title of an open record |
| `text-3xl` | 32 / 1.2 | a page title (`PageHeader`) |

Two sizes cover almost everything: a row has a 15-pt title in `foreground` and a 13-pt meta line in `muted-foreground`. Weight is `font-medium` for titles and `font-semibold` for headings.

## Rows and hit targets

`ROW` holds the height (for virtual lists) and the classes of each row kind. The agent row is the unit: a glyph, a title and a meta line with 8 pt above and below, so 52 to 56 pt, never under 48.

| Row | Height | Classes (`ROW.<kind>.class`) |
|---|---|---|
| `agent` | 56 | `min-h-12 px-3 py-2` (sidebar, home, popover of a rail tile) |
| `project` | 44 | `min-h-11 px-3 py-2` (a project header in the sidebar and a card's header button) |
| `nav` | 40 | `min-h-10 px-3` (`New agent session`, `Board`, `Settings`) |
| `more` | 36 | `min-h-9 px-3` (`3 more idle`) |
| `tab` | 44 | `h-11 px-4` (the dock's tabs) |

Controls (kit): `Btn` 36 (`min-h-9`), small `Btn` 32, `IconButton` 32, a field, a select, a menu item and a combobox row 36, a segmented control and a tab of `Tabs` 32. Every pointer target is at least `HIT.pointer` (28 pt); with Settings > Large hit targets (`largeTargets`) the answer chips grow to `HIT.large` (44 pt). A control that must grow with text (`Btn`) has a `min-h`, never a fixed `h`, so `fontScale()` 2.0 makes it taller instead of cutting it.

## Radius

`RADIUS`: `sm` 4 (tags, a keycap, a checkbox), `md` 8 (controls, rows, a hover fill), `lg` 12 (a dialog), `xl` 16 (a card, the inbox), `2xl` 24 (the chat's message box). A child inside a padded parent takes the parent's radius minus the padding: a card (16) with 8 pt of padding holds rows of 8.

## Surfaces and elevation

Five layers, from the page up. Colour comes from the tokens of `design/colors.md`; this table says which layer takes which depth cue.

| Layer | Token | Depth |
|---|---|---|
| page | `background` | none |
| sidebar | `sidebar` (one shade off the page) | none; a hairline `sidebar-border` at its edge |
| card, the inbox | `card` | a `border-border` hairline, no shadow |
| popover, menu, tooltip | `popover` | `shadow-md` (`SHADOW.md`) and a hairline ring inside the shadow |
| dialog | `card` | `shadow-lg` (`SHADOW.lg`) over the scrim (`bg-black/40`) |

`SHADOW.sm` exists for a surface that must float over the page; the quiet look uses none. Each shadow stacks three layers (a 1-pt ring, a tight one, a wide soft one) so it reads as physical. In the dark appearance a shadow cannot be seen: the hairline border carries the depth.

## Widths

| What | Value | Where |
|---|---|---|
| sidebar | 300 default, 248 to 480 draggable (`SIDEBAR_WIDTH`) | wide windows (1100 and up) |
| snug sidebar | 264, fixed (`SIDEBAR_WIDTH.narrow`) | 900 to 1100 |
| rail | 64 (`RAIL_WIDTH`), 44-pt tiles | under 900, or collapsed |
| home | a grid that stops at 1200 (`COLUMN.home`), two columns from 800 (`TWO_COLUMNS_FROM`) | `Board` |
| chat | 768 (`COLUMN.chat`, `CHAT_COLUMN`: `max-w-3xl`, 24 pt of padding) | the conversation, its message box and docks |
| settings, dialogs | 560, 760 (`wide`), 1000 (`huge`) | `Modal` |

The three tested window widths are 1280, 960 and 760 (`DESIGN.md`); at `fontScale()` 2.0 no text has a fixed-height box (a row has `min-h`, a line is `Clipped` only where hovering shows it all).

## Changing a number

1. Change it in `lib/layout.ts`; if it is in `TAILWIND`, in `nsh.json` too (the test says which side is stale).
2. Look at it: `.shots/` at 1280, 960 and 760, light and dark.
3. Update this file in the same change.
