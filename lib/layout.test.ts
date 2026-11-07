import { expect, test } from "nsh/test";

import { HIT, RAIL_WIDTH, ROW, SIDEBAR_WIDTH, SPACE, TAILWIND, TYPE } from "#lib/layout";

import config from "../nsh.json";

test("nsh.json hands the class engine the scales of lib/layout.ts: one meaning for text-sm everywhere", () => {
  // JSON has no tuples: compare as written.
  expect(JSON.parse(JSON.stringify(config.tailwind))).toEqual(JSON.parse(JSON.stringify(TAILWIND)));
});

test("the type scale grows with every step and keeps readable line heights", () => {
  const steps = Object.values(TYPE);
  for (let i = 1; i < steps.length; i++) expect(steps[i][0]).toBeGreaterThan(steps[i - 1][0]);
  for (const [, leading] of steps) expect(leading).toBeGreaterThanOrEqual(1.2);
  // A desktop with room: body 15 or 14, meta 12 or 13.
  expect(TYPE.sm[0]).toBeGreaterThanOrEqual(14);
  expect(TYPE.xs[0]).toBeGreaterThanOrEqual(12);
});

test("every row of the app is a comfortable pointer target and the spacing steps are a 4-pt scale", () => {
  for (const row of Object.values(ROW)) expect(row.height).toBeGreaterThanOrEqual(HIT.pointer);
  expect(ROW.agent.height).toBeGreaterThanOrEqual(HIT.large);
  for (const points of Object.values(SPACE)) expect(points % 4).toBe(0);
});

test("the sidebar is wide enough for a 15-pt title and its bounds nest", () => {
  expect(SIDEBAR_WIDTH.min).toBeLessThanOrEqual(SIDEBAR_WIDTH.narrow);
  expect(SIDEBAR_WIDTH.narrow).toBeLessThanOrEqual(SIDEBAR_WIDTH.default);
  expect(SIDEBAR_WIDTH.default).toBeLessThanOrEqual(SIDEBAR_WIDTH.max);
  expect(RAIL_WIDTH).toBeGreaterThanOrEqual(HIT.large + 2 * SPACE[2]);
});
