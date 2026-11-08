/**
 * Every layout number of the app, in one place (`design/foundations.md` explains each). Screens import these or use the
 * scale classes below; they never write a size of their own. Two kinds of value live here:
 *
 * - the scale `nsh.json` hands to the class engine (`TAILWIND`: type, radius, shadow): `layout.test.ts` fails when
 *   `nsh.json` `"tailwind"` and this file disagree, so `text-sm` means one thing everywhere;
 * - numbers a screen needs in code (widths, row heights for virtual lists, content columns) and the class strings that
 *   spend the 4-pt spacing scale on a row, a page or a gap.
 */

/**
 * The spacing scale in points, as Tailwind classes (4-pt base: `1` = 4). Only these steps are used: 0.5 1 2 3 4 6 8 12.
 * `0.5` (2 pt) is the one half step: the padding of a recessed segmented track, so a raised segment sits 2 pt inside it
 * and its radius is the track's minus 2 (`RADIUS.md` 8 -> `RADIUS.base` 6). Anywhere else a half step is a bug.
 */
export const SPACE = { 0.5: 2, 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48 } as const;

/**
 * Text sizes `[points, line height as a multiple]`, in two tiers (emil-typography: every size from a scale, leading by role).
 * Chrome (sidebar, rows, controls, buttons, meta) is dense UI: `sm` 13 is the body of it, `xs` 12 the floor for meta and
 * ages (emil: "almost never below 12"), leading 1.4 so a one-line control stays under its row height. Reading (chat prose,
 * Markdown) is `base` 14 at 1.55 (the kit's): more leading than chrome because lines are long and wrap (emil: body 1.5 to 1.6), and 14
 * is the desktop floor for text read in paragraphs. `lg` and up are headings, tighter as they grow (display wants about
 * 1.1). Nothing else is used: no `text-[13px]`.
 */
export const TYPE = {
  xs: [12, 1.4],
  sm: [13, 1.4],
  base: [14, 1.55],
  lg: [16, 1.4],
  xl: [18, 1.35],
  "2xl": [22, 1.3],
  "3xl": [26, 1.25],
} as const;

/**
 * Corner radii in points. A child inside a padded parent takes the parent's radius minus the padding (emil-surfaces:
 * nested radii), so the pairs the kit needs must exist: track 8 (`md`) - pad 2 = segment 6 (`base`); card 12 (`lg`) - pad 4
 * = row 8 (`md`); dialog 16 (`xl`) - pad 8 = row 8; message box 24 (`2xl`) - pad 12 = field 12.
 */
export const RADIUS = { sm: 4, base: 6, md: 8, lg: 12, xl: 16, "2xl": 24 } as const;

/**
 * Shadows by the layer they lift: `sm` a card that floats over the page (not used by the quiet look: cards are hairlines),
 * `md` a menu, popover, popup or toast, `lg` a dialog or the palette. Two stacked layers each (a 1 pt ring at 0.10, then one
 * soft layer: no tight middle layer, whose dark line along the bottom read as a thick edge). The ring IS the surface's edge
 * in light (no border beside it: `EDGE` in the kit).
 * In dark the class engine's `dark:shadow-none` drops the whole token and the hairline border is the edge.
 */
export const SHADOW = {
  sm: "0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 3px rgb(0 0 0 / 0.06)",
  md: "0 0 0 1px rgb(0 0 0 / 0.10), 0 4px 20px rgb(0 0 0 / 0.08)",
  lg: "0 0 0 1px rgb(0 0 0 / 0.10), 0 8px 32px rgb(0 0 0 / 0.14)",
} as const;

/** What `nsh.json` `"tailwind"` must contain: the class engine's view of the scales above. */
export const TAILWIND = { fontSize: TYPE, radius: RADIUS, shadow: SHADOW } as const;

/**
 * The sidebar in points: the width the person drags, its bounds, and the fixed width of a snug window (1100 and under).
 * 264 holds a 13-pt title of about 30 characters beside a 16-pt glyph and a count; 220 is the least that still shows 20;
 * 420 is where a wider sidebar only takes room from the conversation.
 */
export const SIDEBAR_WIDTH = { default: 264, min: 220, max: 420, narrow: 240 } as const;
/** The rail of project tiles (a window under 900 or a collapsed sidebar): a 44-pt tile and 10 pt of padding either side. */
export const RAIL_WIDTH = 64;

/**
 * Content columns in points. `home` (the board's table) grows with the window up to 1440 and stops there: the title is the
 * one elastic column, and past 1440 the eye travels too far from a title to its state. `chat` is the conversation's box;
 * with 24 pt of padding either side the text is 720 wide, the readable measure the owner chose (it holds about 95
 * characters of 14-pt prose, above the 75 of emil-typography: accepted, a message is short and code needs the width).
 * `page` is a settings page: a label, a description and a control read as one line at 640.
 */
export const COLUMN = { home: 1440, chat: 768, page: 640 } as const;

/** Pointer hit targets in points; `largeTargets` (Settings) raises every control that reads `hit()` to the second. */
export const HIT = { pointer: 28, large: 44 } as const;

/**
 * Row heights in points, with the class that spends them. Heights are `min-h`, never `h`, so `fontScale()` 2.0 grows a row
 * instead of cutting it (the tab is the one fixed `h`: a tab strip is chrome). A virtual list takes the number as
 * `estimatedItemSize`. Every height is on the 4-pt grid and at least `HIT.pointer`.
 * - `agent`: the standard two-line row, a 13-pt title and a 12-pt meta line (about 35 pt of text) with 4 pt above and below.
 * - `agentCompact`: one line, a state glyph and a title: 32 puts 12 agents in under 400 pt of the sidebar.
 * - `project`: a project header, 28: it is a label for the rows under it and must not look as tall as one of them.
 * - `nav`, `tab`: 32, the height of a default `Btn` (a small one is 28), so the chrome has one line.
 * - `more`: `3 more idle`, a quiet row, 28.
 * - `table`: a row of the board's table, 36: it carries two lines of cells' worth of eye travel, so a little more air than a list.
 */
export const ROW = {
  agent: { height: 44, class: "min-h-11 px-3 py-1" },
  agentCompact: { height: 32, class: "min-h-8 px-3" },
  project: { height: 28, class: "min-h-7 px-3" },
  nav: { height: 32, class: "min-h-8 px-3" },
  more: { height: 28, class: "min-h-7 px-3" },
  table: { height: 36, class: "min-h-9 px-3" },
  tab: { height: 32, class: "relative h-8 min-w-40 max-w-56 flex-1" },
} as const;

/** Gaps between the parts of a page: inside a row, between rows of a card, between cards and between sections (one: a grid has one gap). */
export const GAP = { row: "gap-3", rows: "gap-1", section: "gap-6" } as const;

/** Padding of a page's edge (home, settings, chat) and of a card. */
export const PAD = { page: "px-6 pt-6", card: "p-3" } as const;

/** The chat's column (conversation, composer, docks): `max-w-3xl` is `COLUMN.chat`, 24 pt of page padding either side. */
export const CHAT_COLUMN = "w-full max-w-3xl self-center px-6";

/**
 * The chat's message box: one line is 28 pt (an 18-pt line of `text-sm` and the padding), it grows with its text to 12 lines and
 * then scrolls inside itself, so a long message never pushes the conversation out of the window.
 */
export const COMPOSER_INPUT = { min: 28, lines: 12, max: 260 } as const;
