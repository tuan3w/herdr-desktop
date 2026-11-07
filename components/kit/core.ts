import { effect, keymap } from "nsh";

import type { TextStyle } from "nsh/types";

/**
 * Keyboard focus indicator for any pressable: a 2px outline floating 2px off the edge.
 * `ring-*` classes draw nothing on the macOS host (verified), so never use them for focus.
 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * `FOCUS_RING` drawn inside the edge, for rows that touch or nearly touch and take a fill (`selected:bg-accent`): an
 * outline floating outside a row is painted over by the fill of the row after it. Use it on stacked list rows only.
 */
export const FOCUS_RING_INSET = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/**
 * The one edge of a floating surface (popover, menu, popup, dialog, toast, drag preview), by the layer it lifts. Light:
 * the shadow token's own 1 pt ring is the edge, so the border is transparent (it keeps the geometry equal in both
 * appearances). Dark: a shadow cannot be seen on charcoal, so the shadow is switched off and the hairline `border-border`
 * is the edge. Two edges drawn together (a 1 pt border and the 1 pt ring) read as a 2 pt rim, which was the bug.
 */
export const EDGE = {
  sm: "border border-transparent shadow-sm dark:border-border dark:shadow-none",
  md: "border border-transparent shadow-md dark:border-border dark:shadow-none",
  lg: "border border-transparent shadow-lg dark:border-border dark:shadow-none",
} as const;

/** Tabular figures: dates and counts must not jitter as digits change. */
export const NUM: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * `FOCUS_RING` for controls on the sidebar surface, where the page's ring color has too little contrast. Drawn inside
 * the edge: sidebar rows sit 2pt apart, and an outline floating outside a row is painted over by the fill of the row
 * after it (and runs into the sidebar's padding).
 */
export const FOCUS_RING_SIDEBAR =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring";

/**
 * Binds Down to `open` while `armed()`. Only the newest binding of a key runs and it consumes the key, so a field must
 * not keep its binding while it is not the one being used: that would take Down from every other field and from
 * scrolling.
 */
export function openOnDown(armed: () => boolean, open: () => void) {
  effect(() => {
    if (!armed()) return;
    return keymap.bind({ down: open }, { when: "always" });
  });
}
