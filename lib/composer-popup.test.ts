import { expect, test } from "nsh/test";

import {
  bubbleBox,
  createSettle,
  MAX_ROWS,
  PEEK_HEAD,
  PEEK_LINE,
  PEEK_MAX_LINES,
  PEEK_MIN,
  PEEK_PAD,
  PEEK_SPACE,
  peekLines,
  ROW,
  viewportHeight,
  viewportRows,
} from "#lib/composer-popup";

test("the list is as many whole rows as it holds, never more than the cap, so a row is never cut in half", () => {
  expect(viewportRows(0)).toBe(0);
  expect(viewportRows(3)).toBe(3);
  expect(viewportRows(MAX_ROWS + 20)).toBe(MAX_ROWS);
  for (const n of [1, 4, 9, 10, 11, 200]) expect(viewportHeight(n) % ROW).toBe(0);
  expect(viewportHeight(200)).toBe(MAX_ROWS * ROW);
});

test("a preview shows only whole lines of the list's height, never a half line, and a short list gets a short preview", () => {
  const chrome = 2 * PEEK_PAD + PEEK_HEAD + PEEK_SPACE;
  expect(peekLines(0)).toBe(0);
  expect(peekLines(chrome + PEEK_LINE - 1)).toBe(0);
  expect(peekLines(chrome + PEEK_LINE)).toBe(1);
  expect(peekLines(chrome + 5 * PEEK_LINE + 14)).toBe(5);
  expect(peekLines(1000)).toBe(PEEK_MAX_LINES);
  // the tallest list (10 rows and the keys row) fits a screenful of code, a one-row list only its name line
  expect(peekLines(MAX_ROWS * ROW + 24)).toBeGreaterThan(10);
  expect(peekLines(viewportHeight(1) + 24)).toBe(0);
});

test("a bubble is as tall as its list and level with its top; a list too short for it keeps the bottom edge so the bubble never covers the box", () => {
  expect(bubbleBox(344, PEEK_MIN)).toEqual({ height: 344, edge: "top" });
  expect(bubbleBox(PEEK_MIN, PEEK_MIN)).toEqual({ height: PEEK_MIN, edge: "top" });
  expect(bubbleBox(58, PEEK_MIN)).toEqual({ height: PEEK_MIN, edge: "bottom" });
  expect(bubbleBox(58)).toEqual({ height: 58, edge: "top" });
  expect(peekLines(PEEK_MIN)).toBe(5);
});

/** A clock the test turns by hand: timers fire when it is advanced past them. */
function fake() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        pending.set(next, { at: now + ms, run });
        return next++;
      },
      clear: (id: number) => void pending.delete(id),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of Array.from(pending)) {
        if (t.at <= now) {
          pending.delete(id);
          t.run();
        }
      }
    },
  };
}

test("a highlight that rests for the delay is settled; one that keeps moving never is", () => {
  const clock = fake();
  const settled: (string | null)[] = [];
  const settle = createSettle(150, (key) => settled.push(key), clock.timers);
  settle.move("a");
  clock.advance(100);
  settle.move("b");
  clock.advance(100);
  settle.move("c");
  clock.advance(149);
  expect(settled).toEqual([]);
  clock.advance(1);
  expect(settled).toEqual(["c"]);
});

test("moving takes back what was settled, so the bubble goes while the keys run and comes back once", () => {
  const clock = fake();
  const log: (string | null)[] = [];
  const settle = createSettle(150, (key) => log.push(key), clock.timers);
  settle.move("a");
  clock.advance(150);
  settle.move("b");
  expect(log).toEqual(["a", null]);
  clock.advance(150);
  clock.advance(1000);
  expect(log).toEqual(["a", null, "b"]);
});

test("cancelling ends the wait and says nothing", () => {
  const clock = fake();
  const log: (string | null)[] = [];
  const settle = createSettle(150, (key) => log.push(key), clock.timers);
  settle.move("a");
  settle.cancel();
  clock.advance(1000);
  expect(log).toEqual([]);
});
