/**
 * How the Changes tab lays itself out from the width of its own pane (not the window's: it opens beside a chat, so the
 * pane is often half of the window, and `compact()`, `narrow()` and `snug()` are window-level). Pure, so a table of
 * widths tests it.
 */

/** From this pane width the files stand in a column beside the diff; below it they fold into one bar above it. */
export const COLUMN_FROM = 900;
/** The files column, border included. */
export const LIST_COLUMN = 288;
/** Below this the header takes two lines (identity and actions, then scope and counts) instead of cutting a control. */
export const TWO_LINES_BELOW = 720;
/** The diff's side padding, both sides. */
const DIFF_PADDING = 32;
/** The line-number gutter and the sign of a row (`gutter_width` in the renderer), and one monospace cell, in points. */
const GUTTER = 56;
const CELL = 7.8;
/** Code is never wrapped narrower than this many columns: it scrolls sideways instead of breaking into one-character lines. */
export const MIN_COLUMNS = 40;

export interface PaneLayout {
  /** `column`: the files beside the diff. `bar`: one bar above the diff, the files in a sheet behind its `Files` button. */
  list: "column" | "bar";
  /** The width the diff gets, in points. */
  diffWidth: number;
  /** One line of header or two. */
  header: "one" | "two";
  /** The header drops what is secondary (the `ahead` count, the word `files`) before it would cut a control. */
  lean: boolean;
}

/** The layout for a pane `width` points wide; 0 (not measured yet) lays out as a wide pane. */
export function layoutFor(width: number): PaneLayout {
  const w = width > 0 ? width : COLUMN_FROM;
  const column = w >= COLUMN_FROM;
  return {
    list: column ? "column" : "bar",
    diffWidth: column ? w - LIST_COLUMN : w,
    header: w >= TWO_LINES_BELOW ? "one" : "two",
    lean: w < 1000,
  };
}

/** How many code columns fit a diff `diffWidth` points wide. */
export const columnsIn = (diffWidth: number): number =>
  Math.max(0, Math.floor((diffWidth - DIFF_PADDING - GUTTER) / CELL));

/** Whether lines may wrap in a diff this wide: only while at least `MIN_COLUMNS` columns remain, else it scrolls sideways. */
export const mayWrap = (diffWidth: number): boolean => columnsIn(diffWidth) >= MIN_COLUMNS;

/** Whether the diff may be side by side: each half is a diff of its own and must hold `MIN_COLUMNS` columns. */
export const maySplit = (diffWidth: number): boolean => columnsIn(diffWidth / 2) >= MIN_COLUMNS;
