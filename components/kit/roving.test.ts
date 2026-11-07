import { expect, test } from "nsh/test";

import { keysOf, stepIndex } from "./roving";

const open = [false, false, false];

test("arrows step to the next and previous item and wrap round when looping", () => {
  expect(stepIndex(open, 0, "next", true)).toBe(1);
  expect(stepIndex(open, 2, "next", true)).toBe(0);
  expect(stepIndex(open, 0, "previous", true)).toBe(2);
});

test("without loop the highlight stops at either end", () => {
  expect(stepIndex(open, 2, "next", false)).toBe(2);
  expect(stepIndex(open, 0, "previous", false)).toBe(0);
  expect(stepIndex(open, 0, "next", false)).toBe(1);
});

test("items to skip are passed over, also across the wrap", () => {
  const skip = [false, true, false];
  expect(stepIndex(skip, 0, "next", true)).toBe(2);
  expect(stepIndex(skip, 2, "next", true)).toBe(0);
  expect(stepIndex(skip, 2, "previous", true)).toBe(0);
  // no loop and nothing enabled past the end: stays
  expect(stepIndex([false, true], 0, "next", false)).toBe(0);
});

test("Home and End go to the first and last item that can be reached", () => {
  const skip = [true, false, false, true];
  expect(stepIndex(skip, 2, "first", true)).toBe(1);
  expect(stepIndex(skip, 1, "last", true)).toBe(2);
});

test("from nothing, next enters at the first item and previous at the last", () => {
  expect(stepIndex([true, false, false], -1, "next", true)).toBe(1);
  expect(stepIndex([false, false, true], -1, "previous", true)).toBe(1);
  expect(stepIndex([true, true], -1, "next", true)).toBe(-1);
});

test("a lone item stays put, and an empty group reaches nothing", () => {
  expect(stepIndex([false], 0, "next", true)).toBe(0);
  expect(stepIndex([], -1, "next", true)).toBe(-1);
});

test("a group listens only to the keys of its axis, so the others still scroll the page", () => {
  const names = (o: Parameters<typeof keysOf>[0], homeEnd: boolean) => keysOf(o, homeEnd).map(([k]) => k);
  expect(names("horizontal", false)).toEqual(["left", "right"]);
  expect(names("vertical", false)).toEqual(["up", "down"]);
  expect(names("both", false)).toEqual(["left", "right", "up", "down"]);
  expect(names("horizontal", true)).toEqual(["left", "right", "home", "end"]);
});
