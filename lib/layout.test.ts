import { expect, test } from "nsh/test";

import { inputHeight } from "#components/kit/fields";
import { ROW_HEIGHT } from "#components/kit/table";
import {
  DIALOG_LARGE,
  CONTROL,
  ICON,
  largeDialogSize,
  RADIUS,
  RAIL_WIDTH,
  ROW,
  SIDEBAR_WIDTH,
  SPACE,
  TAILWIND,
  TYPE,
} from "#lib/layout";
import { largeTargets } from "#lib/settings";

import config from "../nsh.json";

test("nsh.json hands the class engine the scales of lib/layout.ts: one meaning for text-sm everywhere", () => {
  // JSON has no tuples: compare as written.
  expect(JSON.parse(JSON.stringify(config.tailwind))).toEqual(JSON.parse(JSON.stringify(TAILWIND)));
});

test("the type scale grows with every step and keeps readable line heights", () => {
  const steps = Object.values(TYPE);
  for (let i = 1; i < steps.length; i++) expect(steps[i][0]).toBeGreaterThan(steps[i - 1][0]);
  for (const [, leading] of steps) expect(leading).toBeGreaterThanOrEqual(1.2);
  // Chrome is dense desktop UI (13 body, 12 meta, never below 12); reading text is 14 or more with more leading.
  expect(TYPE.xs[0]).toBeGreaterThanOrEqual(12);
  expect(TYPE.sm[0]).toBeGreaterThanOrEqual(13);
  expect(TYPE.sm[0]).toBeLessThanOrEqual(14);
  expect(TYPE.base[0]).toBeGreaterThanOrEqual(14);
  expect(TYPE.base[1]).toBeGreaterThan(TYPE.sm[1]);
});

const strictlyAscending = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1]);
const points = (cls: string) => Number(cls.replace(/^(min-)?h-/, "")) * 4;

test("the ladders are strictly ordered and sit on the grid they name", () => {
  expect(strictlyAscending(Object.values(CONTROL))).toBe(true);
  expect(strictlyAscending(Object.values(ICON))).toBe(true);
  expect(strictlyAscending(Object.values(SPACE).sort((a, b) => a - b))).toBe(true);
  // sm 4 < base 6 < md 8 < lg 12 < xl 16 < 2xl 24
  expect(strictlyAscending(Object.values(RADIUS))).toBe(true);
  expect(Object.values(ICON)).toEqual([12, 14, 16, 20]);
  expect(strictlyAscending(Object.values(TYPE).map(([size]) => size))).toBe(true);
  for (const height of Object.values(CONTROL)) expect(height % 4).toBe(0);
  expect(Object.values(CONTROL)).toEqual([28, 32, 44]);
});

test("the kit's own copies of the ladder agree with lib/layout.ts", () => {
  // The kit may not import lib/layout, so it spells the numbers; a drift here is a screen with two heights in one row.
  const before = largeTargets();
  largeTargets.set(false);
  expect(points(inputHeight())).toBe(CONTROL.default);
  largeTargets.set(true);
  expect(points(inputHeight())).toBe(CONTROL.large);
  largeTargets.set(before);
  expect(ROW_HEIGHT).toBe(ROW.table.height);
});

test("every row of the app is on the control ladder, its class says the same number, and the spacing steps keep one 2-pt step", () => {
  for (const [kind, row] of Object.entries(ROW)) {
    expect(Object.values(CONTROL)).toContain(row.height);
    // A tab is a fixed `h`, every other row a `min-h` that grows with fontScale().
    expect(row.class).toContain(`${kind.startsWith("tab") ? "h" : "min-h"}-${row.height / 4}`);
  }
  expect(ROW.agent.height).toBeGreaterThanOrEqual(CONTROL.large);
  expect(ROW.agentCompact.height).toBeLessThan(ROW.agent.height);
  // The compact tier is what lets a dozen agents show at 1280 x 800.
  expect(ROW.agentCompact.height * 12).toBeLessThanOrEqual(400);
  const off = Object.values(SPACE).filter((points) => points % 4 !== 0);
  expect(off).toEqual([2]);
});

test("nested radii exist for every pair the kit draws: outer minus padding", () => {
  const has = (points: number) => Object.values(RADIUS).includes(points as never);
  // [outer, padding]: a segmented track, a card of rows, a dialog of rows, the message box.
  for (const [outer, padding] of [
    [RADIUS.md, SPACE[0.5]],
    [RADIUS.lg, SPACE[1]],
    [RADIUS.xl, SPACE[2]],
    [RADIUS["2xl"], SPACE[3]],
  ])
    expect(has(outer - padding)).toBe(true);
});

test("the sidebar is wide enough for a 13-pt title and its bounds nest", () => {
  expect(SIDEBAR_WIDTH.min).toBeLessThanOrEqual(SIDEBAR_WIDTH.narrow);
  expect(SIDEBAR_WIDTH.narrow).toBeLessThanOrEqual(SIDEBAR_WIDTH.default);
  expect(SIDEBAR_WIDTH.default).toBeLessThanOrEqual(SIDEBAR_WIDTH.max);
  expect(RAIL_WIDTH).toBeGreaterThanOrEqual(CONTROL.large + 2 * SPACE[2]);
});

test("the large dialog keeps its own size in a roomy window and the margin on every side in a small one", () => {
  expect(largeDialogSize({ width: 1280, height: 800 })).toEqual({ width: 880, height: 640 });
  // 760 wide: the window less 24 pt either side, never wider than itself
  expect(largeDialogSize({ width: 760, height: 800 }).width).toBe(760 - 2 * DIALOG_LARGE.margin);
  expect(largeDialogSize({ width: 1280, height: 500 }).height).toBe(500 - 2 * DIALOG_LARGE.margin);
  expect(largeDialogSize({ width: 10, height: 10 })).toEqual({ width: 0, height: 0 });
});
