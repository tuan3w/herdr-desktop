import { effect, keymap } from "nsh";

import type { ViewRef } from "nsh";
import type { TextStyle } from "nsh/types";

/**
 * THE focus ring (owner decision 2026-11-08: "just enough"): ONE thin line in the `ring` token, 1.5 pt, hugging the control's
 * own corner shape with no gap and no halo. Three drawing forms read as the same line:
 *
 * - `RING`: a borderless control (ghost `Btn`, `IconButton`, switch, row) draws it as an outline at offset 0.
 * - `RING_BORDERED`: a control with its own 1 pt border (field, select, outline `Btn`, composer box): the border turns
 *   `ring` and a 0.5 pt outline at offset 0 thickens it to the same 1.5 pt. A colour change alone is too faint beside the
 *   neutral `input` border (rendered, light and dark).
 * - `RING_INSET`: the same line drawn inside the edge, for items in a clipped or filled row (tabs, list rows, the sidebar)
 *   where an outside outline is cut or painted over by the next row.
 *
 * A pointer press hands the focus back (`releaseFocus`), so only the keyboard shows it; text fields draw it on any focus
 * (the caret is the input mode). `ring-*` and shadow classes draw nothing in the macOS screenshots, and nsh draws one outline
 * per view, so a halo is not part of the ring. An error keeps its `destructive` border and the line stays `destructive`.
 */
export const RING = "outline-[1.5px] outline-offset-0 outline-ring";
export const RING_BORDERED = "border-ring outline-[0.5px] outline-offset-0 outline-ring";
export const RING_INSET = "outline-[1.5px] -outline-offset-[1.5px] outline-ring";
/** The same line for an invalid control: the border stays `destructive`, so the line does too. */
export const RING_INVALID = "border-destructive outline-[0.5px] outline-offset-0 outline-destructive";

const when = (variant: string, classes: string) =>
  classes
    .split(" ")
    .map((c) => `${variant}:${c}`)
    .join(" ");
export const FOCUS_RING = when("focus-visible", RING);
export const FOCUS_RING_BORDERED = when("focus-visible", RING_BORDERED);
export const FOCUS_RING_INSET = when("focus-visible", RING_INSET);

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

/**
 * Hands the keyboard focus back after a pointer press. AppKit focuses a clicked pressable and nsh 0.4.0 reads `focus-visible:`
 * as `focus:`, so without this the ring stays on a button after a click (the `Browse folders` ring in the owner's
 * screenshot). A press with no pointer touch before it came from Return or Space and keeps the focus: the keyboard user is still there (`touchedJustNow`).
 */
export function releaseFocus(node: ViewRef | undefined, byPointer: boolean) {
  if (byPointer) node?.blur();
}

let touchedAt = Number.NEGATIVE_INFINITY;
/** `PopupRoot` calls this on every pointer press in its surface (capture). */
export function noteTouch() {
  touchedAt = Date.now();
}
/** Whether a pointer press began just now: `onPress` of a `Button` carries no position, and the test host reports one for Return too, so the root's touch is the one witness. */
export const touchedJustNow = () => Date.now() - touchedAt < 600;

/** Tabular figures: dates and counts must not jitter as digits change. */
export const NUM: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * The same ring and colour as `FOCUS_RING_INSET`, named for controls on the sidebar surface (the `ring` token is at least
 * 3.28:1 on every theme's sidebar). Drawn inside the edge: sidebar rows sit 2pt apart, and an outline floating outside a
 * row is painted over by the fill of the row after it (and runs into the sidebar's padding).
 */
export const FOCUS_RING_SIDEBAR = FOCUS_RING_INSET;

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
