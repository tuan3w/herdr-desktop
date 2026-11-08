/**
 * How a project header shares its line, as numbers (nsh cannot measure a text before it is laid out, and a flex shrink
 * factor still lets the name give up a little while the machine has room to give). The rule: the name keeps its natural
 * width, the chevron follows it, the machine label shrinks first and goes away before the name is cut.
 */

/** Points one character takes at 13 pt medium (name) and 12 pt (machine): an estimate, set high for the name so it is never cut early. */
export const GLYPH = { name: 7.4, machine: 6.4 } as const;

/** The chevron's width and the gap between the pieces of the line. */
const CHEVRON = 12;
const GAP = 6;

/** Fewer characters than this is a label cut to nothing: the machine is dropped instead (the bubble still names it). */
const MACHINE_MIN_CHARS = 3;

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

/** The widths (pt) a header gives its name and machine in `width` points of line; `machine` 0 means it is left out. */
export function headerBudget(options: { name: number; machine: number; width: number; extra?: number }) {
  const nameNatural = Math.ceil(options.name * GLYPH.name);
  const machineNatural = Math.ceil(options.machine * GLYPH.machine);
  const room = options.width - CHEVRON - GAP - (options.extra ?? 0);
  if (options.machine === 0) return { name: Math.min(nameNatural, room), machine: 0 };
  const left = room - GAP - nameNatural;
  if (left >= machineNatural) return { name: nameNatural, machine: machineNatural };
  if (left >= MACHINE_MIN_CHARS * GLYPH.machine) return { name: nameNatural, machine: left };
  return { name: Math.min(nameNatural, room), machine: 0 };
}
