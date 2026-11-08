import { expect, test } from "nsh/test";

import { actionSlot, estimate, machineFits } from "#lib/header-fit";

// A sidebar is 264 pt wide with 12 pt of padding each side; a header holds back 12 on the left and its actions on the right.
const room = (panel: number, large = false) => panel - 24 - 12 - actionSlot({ plus: true, large });

test("a 12-character name with a 6-character machine shows its machine whole at 264 pt and at 520 pt", () => {
  // Widths as nsh lays them out (`payments-api` 91 pt at 13 pt medium, `fatman` 39 pt at 12 pt): the per-character
  // estimate would call the machine wider and, used as a hard maximum, cut the longer ones to a stub.
  for (const panel of [264, 520]) expect(machineFits({ name: 91, machine: 39, room: room(panel) })).toBe(true);
  expect(machineFits({ name: estimate(12, "name") + 10, machine: estimate(6, "machine") + 10, room: room(520) })).toBe(
    true,
  );
});

test("at 520 pt a long name and a long machine are both whole: nothing is left for a cut", () => {
  expect(machineFits({ name: 160, machine: 70, room: room(520) })).toBe(true);
});

test("the machine is shown whole or not at all: it never gets a width between", () => {
  const name = 120;
  const need = name + 6 + 12 + 6 + 50;
  expect(machineFits({ name, machine: 50, room: need })).toBe(true);
  expect(machineFits({ name, machine: 50, room: need - 1 })).toBe(false);
});

test("a header with no machine has nothing to fit", () => {
  expect(machineFits({ name: 80, machine: 0, room: 400 })).toBe(false);
});

test("the actions' slot follows the real button size, larger under Large hit targets", () => {
  expect(actionSlot({ plus: true, large: false })).toBe(32 + 2 + 32 + 4);
  expect(actionSlot({ plus: true, large: true })).toBe(44 + 2 + 32 + 4);
  expect(actionSlot({ plus: false, large: true })).toBe(32 + 4);
});
