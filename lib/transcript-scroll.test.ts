import { expect, test } from "nsh/test";

import { AT_END_PT, FOLLOW_PT, isAtEnd, pageOffset } from "#lib/transcript-scroll";

test("one wheel notch up stops following, yet the pill waits for a real scroll away from the end", () => {
  const size = 500;
  const content = 2000;
  const end = content - size;
  // One notch (about 50 pt) is past the follow threshold, so a streaming row does not pull the reader down again...
  expect(50).toBeGreaterThan(FOLLOW_PT);
  // ...but it is inside the end the pill uses, so the pill does not appear for it.
  expect(isAtEnd(end - 50, size, content)).toBe(true);
  expect(isAtEnd(end, size, content)).toBe(true);
  expect(isAtEnd(end - AT_END_PT, size, content)).toBe(true);
  expect(isAtEnd(end - AT_END_PT - 1, size, content)).toBe(false);
  expect(AT_END_PT).toBeGreaterThan(FOLLOW_PT);
});

test("a page key moves nine tenths of the view and stops at both ends", () => {
  expect(pageOffset(1000, 500, 2000, -1)).toBe(550);
  expect(pageOffset(1000, 500, 2000, 1)).toBe(1450);
  expect(pageOffset(100, 500, 2000, -1)).toBe(0);
  expect(pageOffset(1400, 500, 2000, 1)).toBe(1500);
  expect(pageOffset(0, 500, 300, 1)).toBe(0);
});
