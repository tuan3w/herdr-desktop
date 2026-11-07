/**
 * The arithmetic of the picture viewer, apart from the screen: how big a picture is drawn (fit, a zoom step, actual size),
 * where it sits when it is bigger than the window (pan, clamped so it never leaves), and what a turn does to the sides.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Pan {
  x: number;
  y: number;
}

/** A turn is a multiple of 90 degrees, clockwise. */
export type Turn = 0 | 90 | 180 | 270;

/** Each zoom step multiplies the scale by this; 1.25 reaches 400% in six presses. */
export const ZOOM_FACTOR = 1.25;
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 16;

/** The size of the picture on screen once turned: a quarter turn swaps the sides. */
export function turned(natural: Size, turn: Turn): Size {
  return turn === 90 || turn === 270 ? { width: natural.height, height: natural.width } : natural;
}

/**
 * The scale at which the whole picture fits the box: never above 1, so a small picture is shown at its own size instead
 * of being blown up (`Actual size` and the zoom steps go beyond).
 */
export function fitScale(natural: Size, turn: Turn, box: Size): number {
  const seen = turned(natural, turn);
  if (seen.width <= 0 || seen.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / seen.width, box.height / seen.height);
}

/** One step in or out from `scale`, kept inside the limits. */
export function zoomed(scale: number, direction: 1 | -1): number {
  const next = direction === 1 ? scale * ZOOM_FACTOR : scale / ZOOM_FACTOR;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 1000) / 1000));
}

/** `125%`. */
export const zoomPercent = (scale: number): string => `${Math.round(scale * 100)}%`;

/**
 * `pan` held so the picture never leaves the box: the picture, as big as `shown` says, may move only as far as its edges
 * reach those of the box; a picture smaller than the box on an axis stays centred on it.
 */
export function clampPan(pan: Pan, shown: Size, box: Size): Pan {
  const room = (extent: number, window: number) => Math.max(0, (extent - window) / 2);
  const x = room(shown.width, box.width);
  const y = room(shown.height, box.height);
  // `+ 0` turns a negative zero (a centred axis) into a plain zero.
  return { x: Math.min(x, Math.max(-x, pan.x)) + 0, y: Math.min(y, Math.max(-y, pan.y)) + 0 };
}

/** Whether the picture is bigger than the box on some axis: only then can it be dragged. */
export const overflows = (shown: Size, box: Size): boolean =>
  shown.width > box.width + 0.5 || shown.height > box.height + 0.5;

/** The next quarter turn, clockwise. */
export const rotatedBy = (turn: Turn): Turn => ((turn + 90) % 360) as Turn;
