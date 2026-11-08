/**
 * How a project header shares its line. The rule: the name keeps its natural width and the chevron follows it; the
 * machine label is shown whole when it fits beside them and left out when it does not, never cut. Widths come from the
 * text itself (a hidden copy laid out with no clamp); an estimate per character stands in only before that, because an
 * estimate used as a hard maximum cut `tuannd12` to `tuannd` while hundreds of points were free.
 */

/** Points one character takes at 13 pt medium (name) and 12 pt (machine): a stand-in before the text is measured. */
const GLYPH = { name: 7.4, machine: 6.6 } as const;

/** The chevron's width and the gap between the pieces of the line. */
const CHEVRON = 12;
const GAP = 6;

/** The box of a hover action: 32 pt, 44 under Large hit targets (`IconButton` `roomy`); the `...` menu is 32 either way. */
export const actionBox = (large: boolean) => (large ? 44 : 32);
const MENU_BOX = 32;
const EDGE = 4;
const ACTION_GAP = 2;

/** The right edge a row holds back for its actions, hovered or not, so nothing moves when they appear. */
export function actionSlot(options: { plus: boolean; large: boolean }) {
  const box = options.plus ? actionBox(options.large) + ACTION_GAP : 0;
  return box + MENU_BOX + EDGE;
}

/**
 * Whether the machine label fits beside the name at natural width, all of it or none: a label that is dropped is in the
 * tooltip, a stub (`fatm`) says nothing. `name` and `machine` are widths in points, measured (`sidebar.tsx` lays each
 * out once with no clamp) or, before the first measure, `estimate`; `room` is the line less what the row holds back. The
 * name is never given a width here: it shrinks by flex only when `room` is really short and fades then.
 */
export function machineFits(options: { name: number; machine: number; room: number }) {
  if (options.machine <= 0) return false;
  return options.name + GAP + CHEVRON + GAP + options.machine <= options.room;
}

/** A width from a character count, used only until the real text has been measured (set high so a name is never cut early). */
export const estimate = (chars: number, kind: keyof typeof GLYPH) => Math.ceil(chars * GLYPH[kind]);
