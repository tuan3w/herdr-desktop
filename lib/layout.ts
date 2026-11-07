/**
 * Every layout number of the app, in one place (`design/foundations.md` explains each). Screens import these or use the
 * scale classes below; they never write a size of their own. Two kinds of value live here:
 *
 * - the scale `nsh.json` hands to the class engine (`TAILWIND`: type, radius, shadow): `layout.test.ts` fails when
 *   `nsh.json` `"tailwind"` and this file disagree, so `text-sm` means one thing everywhere;
 * - numbers a screen needs in code (widths, row heights for virtual lists, content columns) and the class strings that
 *   spend the 4-pt spacing scale on a row, a page or a gap.
 */

/** The spacing scale in points, as Tailwind classes (4-pt base: `1` = 4). Only these steps are used: 1 2 3 4 6 8 12. */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48 } as const;

/**
 * Text sizes `[points, line height as a multiple]`, named as the classes are. `sm` is the body and the row title, `xs` the
 * meta line, tags and ages; the rest are headings. Nothing else is used: no `text-[13px]`.
 */
export const TYPE = {
  xs: [13, 1.35],
  sm: [15, 1.4],
  base: [17, 1.4],
  lg: [20, 1.35],
  xl: [22, 1.3],
  "2xl": [26, 1.25],
  "3xl": [32, 1.2],
} as const;

/** Corner radii in points. A child inside a padded parent takes the parent's radius minus the padding (card 16 - pad 8 = row 8). */
export const RADIUS = { sm: 4, md: 8, lg: 12, xl: 16, "2xl": 24 } as const;

/**
 * Shadows by the layer they lift: `sm` a card that floats over the page (not used by the quiet look: cards are hairlines),
 * `md` a menu or popover, `lg` a dialog. Three stacked layers each (a hairline ring, a tight one, a wide soft one), so
 * they read as physical; in the dark appearance a shadow cannot be seen and the hairline border of the surface carries it.
 */
export const SHADOW = {
  sm: "0 0 0 1px rgb(0 0 0 / 0.04), 0 1px 2px rgb(0 0 0 / 0.05), 0 2px 6px -2px rgb(0 0 0 / 0.06)",
  md: "0 0 0 1px rgb(0 0 0 / 0.05), 0 2px 4px rgb(0 0 0 / 0.06), 0 8px 20px -6px rgb(0 0 0 / 0.14)",
  lg: "0 0 0 1px rgb(0 0 0 / 0.06), 0 4px 8px rgb(0 0 0 / 0.07), 0 24px 48px -12px rgb(0 0 0 / 0.28)",
} as const;

/** What `nsh.json` `"tailwind"` must contain: the class engine's view of the scales above. */
export const TAILWIND = { fontSize: TYPE, radius: RADIUS, shadow: SHADOW } as const;

/** The sidebar in points: the width the person drags, its bounds, and the fixed width of a snug window (1100 and under). */
export const SIDEBAR_WIDTH = { default: 300, min: 248, max: 480, narrow: 264 } as const;
/** The rail of project tiles (a window under 900 or a collapsed sidebar): a 44-pt tile and 10 pt of padding either side. */
export const RAIL_WIDTH = 64;

/** Content columns in points: the home is a grid that stops growing, the chat and a settings page a readable measure. */
export const COLUMN = { home: 1200, chat: 768, page: 720 } as const;
/** The home lays out two columns of cards from this width (points of the home itself, not of the window). */
export const TWO_COLUMNS_FROM = 800;

/** Pointer hit targets in points; `largeTargets` (Settings) raises every control that reads `hit()` to the second. */
export const HIT = { pointer: 28, large: 44 } as const;

/**
 * Row heights in points, with the class that spends them. The agent row is the unit of the app: glyph, a 15-pt title and a
 * 13-pt meta line with 8 pt of padding above and below. A virtual list takes the number as `estimatedItemSize`.
 */
export const ROW = {
  agent: { height: 56, class: "min-h-12 px-3 py-2" },
  project: { height: 44, class: "min-h-11 px-3 py-2" },
  nav: { height: 40, class: "min-h-10 px-3" },
  more: { height: 36, class: "min-h-9 px-3" },
  tab: { height: 44, class: "h-11 px-4" },
} as const;

/** Gaps between the parts of a page: inside a row, between rows of a card, between cards and between sections (one: a grid has one gap). */
export const GAP = { row: "gap-3", rows: "gap-1", section: "gap-6" } as const;

/** Padding of a page's edge (home, settings, chat) and of a card. */
export const PAD = { page: "px-6 pt-6", card: "p-3" } as const;

/** The chat's column (conversation, composer, docks): `max-w-3xl` is `COLUMN.chat`, 24 pt of page padding either side. */
export const CHAT_COLUMN = "w-full max-w-3xl self-center px-6";
