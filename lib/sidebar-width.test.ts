import { expect, test } from "nsh/test";

import { SIDEBAR_WIDTH } from "#lib/layout";
import { clampSidebar, settleDrag } from "#lib/sidebar-width";

const { min, max, default: dflt } = SIDEBAR_WIDTH;

test("clampSidebar keeps a width inside the range and whole", () => {
  const table: [unknown, number][] = [
    [min - 1, min],
    [0, min],
    [-50, min],
    [min, min],
    [300.4, 300],
    [max, max],
    [max + 200, max],
    [NaN, dflt],
    [Infinity, dflt],
    ["300", dflt],
    [undefined, dflt],
  ];
  for (const [given, want] of table) expect(clampSidebar(given)).toBe(want);
});

test("settleDrag folds to the rail only well under the least width", () => {
  expect(settleDrag(min - 10)).toEqual({ rail: false, width: min });
  expect(settleDrag(min - 47)).toEqual({ rail: false, width: min });
  expect(settleDrag(min - 49)).toEqual({ rail: true });
  expect(settleDrag(64)).toEqual({ rail: true });
  expect(settleDrag(dflt)).toEqual({ rail: false, width: dflt });
  expect(settleDrag(max + 80)).toEqual({ rail: false, width: max });
});
