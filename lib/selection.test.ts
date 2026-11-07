import { expect, test } from "nsh/test";

import { clear, isSelected, rangeTo, select, selected, toggle } from "#lib/selection";

const ORDER = ["a", "b", "c", "d", "e"];

test("a press toggles one agent and Shift extends from the last one toggled, in either direction", () => {
  clear();
  toggle("b");
  rangeTo("d", ORDER);
  expect(selected()).toEqual(["b", "c", "d"]);
  expect(isSelected("c")).toBe(true);

  rangeTo("a", ORDER);
  expect(selected()).toEqual(["b", "c", "d", "a"]);
  toggle("c");
  expect(isSelected("c")).toBe(false);
  clear();
});

test("a range with no start, or from a row that is no longer listed, picks just the row asked for", () => {
  clear();
  rangeTo("c", ORDER);
  expect(selected()).toEqual(["c"]);
  toggle("x");
  rangeTo("e", ORDER);
  expect(selected()).toEqual(["c", "x", "e"]);
  clear();
});

test("select replaces the picks and clear empties them", () => {
  clear();
  toggle("a");
  select(["c", "d", "c"]);
  expect(selected()).toEqual(["c", "d"]);
  clear();
  expect(selected()).toEqual([]);
});
