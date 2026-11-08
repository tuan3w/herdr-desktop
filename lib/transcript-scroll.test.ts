import { expect, test } from "nsh/test";

import type { SessionItem } from "herdr-desktop/native";

import type { Row } from "#lib/session-rows";
import {
  AT_END_PT,
  DEFAULT_ROW_PT,
  estimateRowPt,
  FOLLOW_PT,
  isAtEnd,
  pageOffset,
  rowPt,
} from "#lib/transcript-scroll";

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

const message = (role: "user" | "agent", text: string): SessionItem => ({
  id: 1,
  rev: 1,
  kind: "message",
  role,
  text,
  images: [],
  parts: [],
});
const agent = (text: string): Row => ({ kind: "agent", key: "a", sig: "", item: message("agent", text), live: false });
const user = (text: string): Row => ({ kind: "user", key: "u", sig: "", item: message("user", text) });
const prose = (lines: number) => Array.from({ length: lines }, () => "word ".repeat(30)).join("\n");
const fence = (lines: number) =>
  ["```ts", ...Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`), "```"].join("\n");

test("a row not yet drawn is taken to be as tall as the conversation's rows are, not a fixed 72 pt", () => {
  // A chat of long answers: the estimate follows them up, so the content does not grow under the reader as rows are measured.
  const long = Array.from({ length: 40 }, (_, i) => (i % 2 ? agent(`${prose(12)}\n\n${fence(40)}`) : user("why?")));
  expect(estimateRowPt(long)).toBeGreaterThan(200);
  // A chat of one-line answers stays small.
  const short = Array.from({ length: 40 }, (_, i) => (i % 2 ? agent("Done.") : user("and now?")));
  expect(estimateRowPt(short)).toBeLessThan(100);
  // Too few rows to say: the default turn.
  expect(estimateRowPt([user("hi")])).toBe(DEFAULT_ROW_PT);
});

test("an answer's height counts a long fence as the lines it shows folded, and wrapped prose as its lines", () => {
  expect(rowPt(agent(fence(80)))).toBe(rowPt(agent(fence(40))));
  expect(rowPt(agent(fence(10)))).toBeLessThan(rowPt(agent(fence(40))));
  expect(rowPt(agent(prose(4)))).toBeGreaterThan(rowPt(agent(prose(2))));
});
