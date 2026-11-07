/**
 * How far from the end the list still pulls the view down as rows grow (`autoscrollToBottomThreshold`). Small on purpose:
 * one wheel notch (about 50 pt) up is the reader saying "stay here", and a streaming row must not take them back.
 */
export const FOLLOW_PT = 12;
/**
 * How far from the end still counts as being at it for the tab (`atEnd`: the `Jump to latest` pill and the unseen count).
 * Larger than `FOLLOW_PT` so the pill does not flicker on a few points of scroll or of rounding; between the two the
 * view stays where the reader put it and the pill stays quiet.
 */
export const AT_END_PT = 64;

/** Whether a view scrolled to `offset` (of `size` high, over `content`) is at the end for the pill and the unseen count. */
export function isAtEnd(offset: number, size: number, content: number): boolean {
  return offset + size >= content - AT_END_PT;
}

/** Where a page key goes: 90% of the view up or down, kept inside the content. */
export function pageOffset(offset: number, size: number, content: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(content - size, offset + direction * size * 0.9));
}
