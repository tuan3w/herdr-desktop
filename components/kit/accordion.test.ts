import { expect, test } from "nsh/test";
import { accordionValue } from "./accordion";
import { fallbackShown } from "./avatar";
import { progressRatio, progressText } from "./progress";

test("one at a time: opening an item closes the others, and the open one can be closed", () => {
  expect(accordionValue([], "a", true, false)).toEqual(["a"]);
  expect(accordionValue(["a"], "b", true, false)).toEqual(["b"]);
  expect(accordionValue(["a"], "a", false, false)).toEqual([]);
});

test("multiple: each item is its own switch", () => {
  expect(accordionValue(["a"], "b", true, true)).toEqual(["a", "b"]);
  expect(accordionValue(["a", "b"], "a", false, true)).toEqual(["b"]);
  expect(accordionValue(["a"], "a", true, true)).toEqual(["a"]);
});

test("progress is clamped, and an unknown extent has no ratio", () => {
  expect(progressRatio(50, 0, 100)).toBe(0.5);
  expect(progressRatio(120, 0, 100)).toBe(1);
  expect(progressRatio(-5, 0, 100)).toBe(0);
  expect(progressRatio(15, 10, 20)).toBe(0.5);
  expect(progressRatio(null, 0, 100)).toBeUndefined();
  expect(progressRatio(5, 10, 10)).toBeUndefined();
});

test("the spoken value is the caller's words, else the percentage, else that it is working", () => {
  expect(progressText(0.4, "2/5 tasks done")).toBe("2/5 tasks done");
  expect(progressText(0.426)).toBe("43%");
  expect(progressText(undefined)).toBe("busy");
});

test("the initials wait for the delay while a picture loads and never show over a loaded one", () => {
  expect(fallbackShown("loading", false)).toBe(false);
  expect(fallbackShown("loading", true)).toBe(true);
  expect(fallbackShown("error", true)).toBe(true);
  expect(fallbackShown("loaded", true)).toBe(false);
  expect(fallbackShown("idle", true)).toBe(true);
});
