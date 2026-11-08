import { expect, test } from "nsh/test";

import { createAutoLoad, shouldAutoLoad } from "#lib/earlier";

test("older rows are asked for within one viewport of the top, and only when they can be had", () => {
  expect(shouldAutoLoad(0, 600, "available")).toBe(true);
  expect(shouldAutoLoad(599, 600, "available")).toBe(true);
  expect(shouldAutoLoad(600, 600, "available")).toBe(false);
  for (const state of ["none", "loading", "tooLong"] as const) expect(shouldAutoLoad(0, 600, state)).toBe(false);
});

test("an empty list is at the top", () => {
  expect(shouldAutoLoad(0, 1, "available")).toBe(true);
});

test("one arrival asks once; the next ask waits for the read to have run", () => {
  const ask = createAutoLoad();
  expect(ask(100, 600, "available")).toBe(true);
  // The state has not changed yet (the next pull comes before Rust says loading): no second ask.
  expect(ask(100, 600, "available")).toBe(false);
  expect(ask(100, 600, "loading")).toBe(false);
  expect(ask(100, 600, "available")).toBe(true);
});

test("a person far from the top is not asked for, and is the moment they scroll up", () => {
  const ask = createAutoLoad();
  expect(ask(5000, 600, "available")).toBe(false);
  expect(ask(300, 600, "available")).toBe(true);
});
