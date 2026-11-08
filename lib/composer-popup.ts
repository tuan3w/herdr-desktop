/**
 * The geometry and timing of the lists that open from the message box (`design/composer.md`), pure so the rules that stop
 * them jumping are tested without a window.
 */

/** One row's height in points: a list scrolls by whole rows. */
export const ROW = 32;
/** Rows visible at most: a longer list scrolls. */
export const MAX_ROWS = 10;

/** How many rows are drawn: all of them up to the cap. Only the top edge of a list that hangs from its bottom moves when this changes. */
export const viewportRows = (count: number, max = MAX_ROWS): number => Math.max(0, Math.min(count, max));

/** The list's height: whole rows and nothing else, so no row is ever cut in half at the bottom. */
export const viewportHeight = (count: number): number => viewportRows(count) * ROW;

/** The gap between a list and the bubble beside it, in points. */
export const BUBBLE_GAP = 8;
/** The preview bubble's inner padding, its muted name line, the space under that line, and one line of code, in points. */
export const PEEK_PAD = 12;
export const PEEK_HEAD = 20;
export const PEEK_SPACE = 8;
export const PEEK_LINE = 15;
/** The most lines a preview ever shows. */
export const PEEK_MAX_LINES = 20;

/** The least a file preview is tall: a name line and five lines of code, so a list of one match still has something to show. */
export const PEEK_MIN = 2 * PEEK_PAD + PEEK_HEAD + PEEK_SPACE + 5 * PEEK_LINE;

/**
 * The bubble's height and which edge it shares with the list: as tall as the list, top to top, and when the list is
 * shorter than `min` the bubble grows UP from the list's bottom edge, never down over the message box under the list.
 */
export const bubbleBox = (listHeight: number, min = 0): { height: number; edge: "top" | "bottom" } =>
  listHeight >= min ? { height: listHeight, edge: "top" } : { height: min, edge: "bottom" };

/**
 * How many whole lines of code fit a bubble as tall as its list: never a half line at the bottom and never a blank area, so
 * a short list (3 rows) shows a short preview. The bubble's height is the list's height, which is fixed while the list is
 * open, so the highlight moving or the bytes arriving late changes nothing.
 */
export const peekLines = (bubbleHeight: number): number =>
  Math.max(0, Math.min(PEEK_MAX_LINES, Math.floor((bubbleHeight - 2 * PEEK_PAD - PEEK_HEAD - PEEK_SPACE) / PEEK_LINE)));

interface Timers<T> {
  set: (run: () => void, ms: number) => T;
  clear: (id: T) => void;
}

/**
 * Tells when a highlight has rested: `move(key)` takes back what was settled (`onSettle(null)`) and starts the wait again,
 * and `delay` ms after the last move `onSettle(key)` says that row is the one to describe. A bubble that follows this never
 * opens while the pointer or the keys are running through rows. `timers` is injected so a test owns the clock.
 */
export function createSettle<T = ReturnType<typeof setTimeout>>(
  delay: number,
  onSettle: (key: string | null) => void,
  timers: Timers<T> = { set: setTimeout as never, clear: clearTimeout as never },
): { move: (key: string) => void; cancel: () => void } {
  let timer: T | undefined;
  let shown = false;
  const stop = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  return {
    move(key) {
      stop();
      if (shown) {
        shown = false;
        onSettle(null);
      }
      timer = timers.set(() => {
        timer = undefined;
        shown = true;
        onSettle(key);
      }, delay);
    },
    cancel: stop,
  };
}
