import { signal } from "nsh";
import { expect, test } from "nsh/test";

import { createCheckGroup, parentState, pressParent } from "./check-group";

const ALL = ["a", "b", "c", "d"];
const none = () => false;

test("the parent is checked on all, mixed on some, and an empty set is not all", () => {
  expect(parentState(4, 4)).toEqual({ checked: true, indeterminate: false });
  expect(parentState(2, 4)).toEqual({ checked: false, indeterminate: true });
  expect(parentState(0, 4)).toEqual({ checked: false, indeterminate: false });
  expect(parentState(0, 0)).toEqual({ checked: false, indeterminate: false });
});

test("from none or all the parent flips between the two", () => {
  expect(pressParent({ all: ALL, value: [], remembered: [], status: "mixed", disabled: none })).toEqual({
    value: ALL,
    status: "mixed",
  });
  expect(pressParent({ all: ALL, value: ALL, remembered: ALL, status: "mixed", disabled: none })).toEqual({
    value: [],
    status: "mixed",
  });
});

test("from a hand-picked set the parent goes to all, then none, then back to that set", () => {
  const picked = ["a", "c"];
  const first = pressParent({ all: ALL, value: picked, remembered: picked, status: "mixed", disabled: none });
  expect(first).toEqual({ value: ALL, status: "on" });
  const second = pressParent({
    all: ALL,
    value: first.value,
    remembered: picked,
    status: first.status,
    disabled: none,
  });
  expect(second).toEqual({ value: [], status: "off" });
  const third = pressParent({
    all: ALL,
    value: second.value,
    remembered: picked,
    status: second.status,
    disabled: none,
  });
  expect(third).toEqual({ value: picked, status: "mixed" });
});

test("disabled children keep their state through the parent", () => {
  const disabled = (v: string) => v === "a" || v === "b";
  // a is disabled and selected, b disabled and not: "all" cannot add b, "none" cannot drop a
  const all = pressParent({ all: ALL, value: ["a"], remembered: ["a"], status: "mixed", disabled });
  expect(all.value).toEqual(["a", "c", "d"]);
  const cleared = pressParent({
    all: ALL,
    value: ["a", "c", "d"],
    remembered: ["a", "c", "d"],
    status: "mixed",
    disabled,
  });
  expect(cleared.value).toEqual(["a"]);
});

test("a group holds its own value, and a cancelled change leaves it alone", () => {
  const seen: string[][] = [];
  let veto = false;
  const group = createCheckGroup({
    all: () => ALL,
    onValueChange: (value, change) => {
      seen.push(value);
      if (veto) change.cancel();
    },
  });
  expect(group.toggle("a", true)).toBe(true);
  expect(group.has("a")).toBe(true);
  expect(group.parent.indeterminate()).toBe(true);
  veto = true;
  expect(group.toggle("b", true)).toBe(false);
  expect(group.has("b")).toBe(false);
  expect(group.parent.press()).toBe(false);
  expect(group.value()).toEqual(["a"]);
  veto = false;
  group.parent.press();
  expect(group.parent.checked()).toBe(true);
  expect(seen[seen.length - 1]).toEqual(ALL);
});

test("a vetoed parent press does not advance the cycle", () => {
  let veto = false;
  const group = createCheckGroup({
    all: () => ALL,
    defaultValue: ["a"],
    onValueChange: (_, change) => veto && change.cancel(),
  });
  group.toggle("c", true);
  veto = true;
  group.parent.press();
  veto = false;
  group.parent.press();
  expect(group.parent.checked()).toBe(true);
});

test("a controlled group changes only when the owner passes a new value", () => {
  const owner = signal<string[]>(["a"]);
  const group = createCheckGroup({ all: () => ALL, value: () => owner(), onValueChange: () => {} });
  group.toggle("b", true);
  expect(group.value()).toEqual(["a"]);
  owner.set(["a", "b"]);
  expect(group.has("b")).toBe(true);
});

test("a selection of thousands is handled in linear time", () => {
  const many = Array.from({ length: 6000 }, (_, i) => `m${i}`);
  const start = Date.now();
  const picked = many.filter((_, i) => i % 3 === 0);
  const first = pressParent({
    all: many,
    value: picked,
    remembered: picked,
    status: "mixed",
    disabled: (v) => v === "m1",
  });
  expect(first.value.length).toBeGreaterThan(5000);
  expect(Date.now() - start).toBeLessThan(500);
});
