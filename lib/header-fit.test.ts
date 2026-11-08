import { expect, test } from "nsh/test";

import { actionSlot, headerBudget } from "#lib/header-fit";

// A sidebar is 264 pt wide with 12 pt of padding each side; a header holds back 12 on the left and its actions on the right.
const line = (panel: number, large = false) => panel - 24 - 12 - actionSlot({ plus: true, large });

test("a 12-character name with a 5-character machine shows whole at 264 pt and at 400 pt", () => {
  for (const panel of [264, 400]) {
    const fit = headerBudget({ name: 12, machine: 5, width: line(panel) });
    expect(fit.name).toBeGreaterThanOrEqual(Math.ceil(12 * 7.4));
    expect(fit.machine).toBeGreaterThanOrEqual(Math.ceil(5 * 6.4));
  }
});

test("when the line is short the machine gives way first, then goes, and the name is cut last", () => {
  const natural = headerBudget({ name: 20, machine: 10, width: 1000 });
  const some = headerBudget({ name: 20, machine: 10, width: natural.name + 12 + 6 + 6 + 40 });
  expect(some.name).toBe(natural.name);
  expect(some.machine).toBeLessThan(natural.machine);
  expect(some.machine).toBeGreaterThan(0);
  const none = headerBudget({ name: 20, machine: 10, width: natural.name + 12 + 6 + 6 });
  expect(none).toEqual({ name: natural.name, machine: 0 });
  const tight = headerBudget({ name: 20, machine: 10, width: natural.name - 30 });
  expect(tight.machine).toBe(0);
  expect(tight.name).toBeLessThan(natural.name);
});

test("a header with no machine gives its name the line", () => {
  expect(headerBudget({ name: 8, machine: 0, width: 300 }).machine).toBe(0);
  expect(headerBudget({ name: 80, machine: 0, width: 300 }).name).toBe(300 - 12 - 6);
});

test("the actions' slot follows the real button size, larger under Large hit targets", () => {
  expect(actionSlot({ plus: true, large: false })).toBe(32 + 2 + 32 + 4);
  expect(actionSlot({ plus: true, large: true })).toBe(44 + 2 + 32 + 4);
  expect(actionSlot({ plus: false, large: true })).toBe(32 + 4);
});
