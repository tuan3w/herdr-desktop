import { expect, test } from "nsh/test";

import { COLUMN_FROM, columnsIn, layoutFor, MIN_COLUMNS, maySplit, mayWrap } from "#lib/changes-layout";

test("the pane's width alone says column or bar, one header line or two, and how much the diff gets", () => {
  const table: [number, "column" | "bar", "one" | "two"][] = [
    [0, "column", "one"],
    [480, "bar", "two"],
    [640, "bar", "two"],
    [719, "bar", "two"],
    [720, "bar", "one"],
    [760, "bar", "one"],
    [COLUMN_FROM - 1, "bar", "one"],
    [COLUMN_FROM, "column", "one"],
    [1100, "column", "one"],
    [1400, "column", "one"],
  ];
  for (const [width, list, header] of table) {
    const lay = layoutFor(width);
    expect([width, lay.list, lay.header]).toEqual([width, list, header]);
  }
  // A bar gives the diff the whole pane; a column takes its share off.
  expect(layoutFor(640).diffWidth).toBe(640);
  expect(layoutFor(1100).diffWidth).toBeLessThan(1100);
  expect(layoutFor(1100).diffWidth).toBeGreaterThan(700);
});

test("code wraps only while forty columns remain; below that it scrolls sideways, never one character a line", () => {
  expect(mayWrap(215)).toBe(false);
  expect(columnsIn(215)).toBeLessThan(MIN_COLUMNS);
  expect(mayWrap(480)).toBe(true);
  expect(mayWrap(columnsIn(0))).toBe(false);
  // Every pane the tab is laid out for keeps the rule: whatever wraps has at least forty columns.
  for (const width of [480, 640, 760, 900, 1100, 1400]) {
    const lay = layoutFor(width);
    if (mayWrap(lay.diffWidth)) expect(columnsIn(lay.diffWidth)).toBeGreaterThanOrEqual(MIN_COLUMNS);
  }
});

test("side by side needs forty columns in each half", () => {
  expect(maySplit(640)).toBe(false);
  expect(maySplit(1100)).toBe(true);
  expect(maySplit(layoutFor(1100).diffWidth)).toBe(true);
});
