import { SIDEBAR_WIDTH } from "#lib/layout";

/** A drag that ends this far under the least width means "fold it": the rail, not a sidebar too narrow to read. */
const RAIL_SNAP = 48;

/** The width the sidebar may have: whole points inside the draggable range; anything that is not a number is the default. */
export function clampSidebar(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)));
}

/**
 * What a finished drag means: a width, or `rail` when it went well under the least. The panel group clamps a drag itself on
 * the host tested (macOS), so the snap is a guard for a host that reports the raw size, and the one rule for both.
 */
export function settleDrag(size: number): { rail: true } | { rail: false; width: number } {
  if (size < SIDEBAR_WIDTH.min - RAIL_SNAP) return { rail: true };
  return { rail: false, width: clampSidebar(size) };
}
