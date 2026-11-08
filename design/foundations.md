# Foundations

The numbers every screen is built from. They live in two places and nowhere else: `lib/layout.ts` (code) and the `"tailwind"` block of `nsh.json` (the class engine's copy of the type, radius and shadow scales); `lib/layout.test.ts` fails when the two disagree. A screen never writes a size, a radius or a width of its own: it uses a scale class or imports a constant from `lib/layout.ts`.

A desktop is 1280 pt or more, with a pointer and a keyboard, open all day (`AGENTS.md`, "Desktop is not a wide phone"). So the numbers are dense (a dozen agents visible and room to read one) and every row still clears a pointer. Sizes are logical px: 1 unit is 1 CSS px, and `fontScale()` scales text only.

## Spacing

A 4-pt base. These steps exist; any other half step (`gap-1.5`, `px-2.5`, `py-0.5`) is a bug.

| Class step | Points | Used for |
|---|---|---|
| `0.5` | 2 | only the padding of a recessed segmented track (`p-0.5`): the raised segment sits 2 pt inside it, so its radius is the track's minus 2 |
| `1` | 4 | between a title and its meta line, icon to text inside a tight control, row padding of a two-line row |
| `2` | 8 | inside a control (`gap-2`), card padding, gap between small controls |
| `3` | 12 | row padding left and right, gap between a glyph and its text |
| `4` | 16 | dialog and panel padding |
| `6` | 24 | the page's edge, the gap between sections and between cards (`GAP.section`) |
| `8` | 32 | the end of a page (`pb-8`), a big empty state |
| `12` | 48 | rare: a fill-the-pane empty state |

Why one 2-pt step: nested radii are outer minus padding (emil-surfaces), and a track that pads 4 would put the segment 4 pt in, which reads as a gap, not a raised chip. `lib/layout.test.ts` allows exactly one value off the 4-pt scale.

`SPACE` states the scale for code; `GAP` and `PAD` are the class strings a page spends it with: `GAP.row` (12) inside a row, `GAP.rows` (4) between the rows of a card, `GAP.section` (24) between sections and cards; `PAD.page` (24) is a page's edge.

## Type

Inter for text, IBM Plex Mono for identifiers (`design/typography.md` has the table). Two tiers: chrome (sidebar, rows, controls, buttons, meta) is `text-sm` 13 and `text-xs` 12; reading (chat prose, Markdown) is `text-base` 14 with more leading. `lg` and up are headings. A row is a 13-pt title in `foreground` and a 12-pt meta line in `muted-foreground`.

## Rows and hit targets

`ROW` holds the height (for virtual lists) and the classes of each row kind. Heights are on the 4-pt grid, each a step of `CONTROL`, and are `min-h` so `fontScale()` 2.0 grows a row instead of cutting it.

| Row | Height | Classes (`ROW.<kind>.class`) | Why this height |
|---|---|---|---|
| `agentCompact` | 32 | `min-h-8 px-3` | a glyph and a title: 12 agents fit in 384 pt of the sidebar |
| `agent` | 44 | `min-h-11 px-3 py-1` | two lines (13 + 12 pt text, about 35 pt) and 4 pt either side; also the `CONTROL.large` size |
| `project` | 28 | `min-h-7 px-3` | a header labels the rows under it and must not be as tall as one |
| `nav` | 32 | `min-h-8 px-3` | the height of a small control: one line of chrome |
| `more` | 28 | `min-h-7 px-3` | a quiet row (`3 more idle`) |
| `table` | 32 | `min-h-8 px-3` | the board's table: a default control's height (36 is off the ladder) |
| `tab` | 32 | `relative h-8 min-w-40 max-w-56 flex-1` | the dock's tabs: one chrome line |

Controls (kit; the targets the kit follows): `Btn` 32 (`min-h-8`), small `Btn` 28, `IconButton` 28, a field, a select, a menu item and a combobox row 32, a segmented control about 28 and a tab of `Tabs` 28; a switch about 30 x 18. Every control is a step of `CONTROL` (28, 32 or 44); with Settings > Large hit targets (`largeTargets`) the answer chips grow to `CONTROL.large` (44 pt). Why 28: a pointer is precise (emil says 44 for touch, and the large setting gives it); a 28 floor lets a dozen rows show.

## Radius

`RADIUS`: `sm` 4 (tags, a keycap, a checkbox), `base` 6 (a segment inside a track), `md` 8 (controls, rows, a hover fill, a track), `lg` 12 (a card), `xl` 16 (a dialog, the inbox), `2xl` 24 (the chat's message box). Rule: a child inside a padded parent takes the parent's radius minus the padding (emil-surfaces; beyond 24 pt of gap the layers read as separate and the rule stops). Every pair the kit needs exists and `lib/layout.test.ts` checks them: track 8 - pad 2 = segment 6; card 12 - pad 4 = row 8; dialog 16 - pad 8 = row 8; message box 24 - pad 12 = field 12.

## Surfaces and elevation

Five layers, from the page up. Colour comes from the tokens of `design/colors.md`; this table says which layer takes which depth cue.

| Layer | Token | Depth |
|---|---|---|
| page | `background` | none |
| sidebar | `sidebar` (one shade off the page) | none; a hairline `sidebar-border` at its edge |
| card, the inbox | `card` | a `border-border` hairline, no shadow |
| popover, menu, popup, toast | `popover` | `EDGE.md` (`SHADOW.md`) |
| tooltip | `foreground` pill | none: the fill is the edge |
| dialog, palette | `card`, `popover` | `EDGE.lg` (`SHADOW.lg`) over the scrim (`bg-black/40`) |

`SHADOW.sm` is for a small raised thing (the chosen segment, a floating chip). Each shadow stacks two layers, a 1-pt ring at 0.10 (the edge) and one soft layer: `sm` 0 1 3 at 0.06, `md` 0 4 20 at 0.08, `lg` 0 8 32 at 0.14. No tight middle layer: its 0.05 line along the bottom corners read as a thick edge beside the ring.

**Edges.** One edge per surface (`EDGE` in the kit). A floating surface takes its edge from the shadow's ring in light and from `border-border` in dark: `border border-transparent shadow-md dark:border-border dark:shadow-none`. The transparent border keeps the geometry equal in both appearances. A flat surface (card, row, table, panel, input) keeps a hairline and no shadow. Why: the surfaces first wore `border border-border` AND a shadow whose first layer is a 1-pt ring, so the edge was drawn twice (about 2 pt) beside a soft shadow, and the owner called it too strong and thick. Never add a border to a surface that has `EDGE`, and never a shadow to one that has a border only.

## Widths

| What | Value | Why |
|---|---|---|
| sidebar | 264 default, 220 to 420 draggable (`SIDEBAR_WIDTH`) | 264 holds a 13-pt title of about 30 characters beside a glyph and a count; 420 is where more width only takes room from the conversation |
| snug sidebar | 240, fixed (`SIDEBAR_WIDTH.narrow`) at 900 to 1100 | the conversation keeps its measure |
| rail | 64 (`RAIL_WIDTH`), 44-pt tiles | under 900, or collapsed |
| home | grows with the window to 1440 (`COLUMN.home`); the Board is one table, never columns of cards | the title is the one elastic column, so it is uncapped on every laptop; past 1440 the eye travels too far from a title to its state |
| chat | 768 (`COLUMN.chat`, `CHAT_COLUMN`: `max-w-3xl`, 24 pt of padding, so the text is 720) | the owner's readable measure; about 95 characters of 14-pt prose, above the 75 of emil-typography, accepted because a message is short and code and tables need the width. Extra window width goes to the inspector, not margins |
| settings page | 640 (`COLUMN.page`) | a label, its description and its control read as one line |
| dialogs | 560, 760 (`wide`), 1000 (`huge`) | `Modal` |

The three tested window widths are 1280, 960 and 760 (`DESIGN.md`); at `fontScale()` 2.0 no text has a fixed-height box (a row has `min-h`, a line is `Clipped` only where hovering shows it all).

## Changing a number

1. Change it in `lib/layout.ts`; if it is in `TAILWIND`, in `nsh.json` too (the test says which side is stale).
2. Look at it: `.shots/` at 1280, 960 and 760, light and dark.
3. Update this file in the same change.
