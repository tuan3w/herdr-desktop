import { expect, test } from "nsh/test";

import { createIdle, lightboxFit, nameLine, stepTarget, wheelZoom, zoomAt } from "#lib/lightbox";

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
const WINDOW = { width: 1000, height: 800 };

test("a picture is fitted inside the window with an 8% margin on every side, and never blown up", () => {
  // 1600 x 1000 into 1000 x 800 less 16%: 840 x 672
  expect(near(lightboxFit({ width: 1600, height: 1000 }, 0, WINDOW), 0.525)).toBe(true);
  expect(lightboxFit({ width: 100, height: 100 }, 0, WINDOW)).toBe(1);
  // a quarter turn swaps the sides before fitting
  expect(near(lightboxFit({ width: 1600, height: 1000 }, 90, WINDOW), 672 / 1600)).toBe(true);
});

test("the name line carries the position only when the folder has more than one picture", () => {
  const names = ["a.png", "b.png", "c.png"];
  expect(nameLine("b.png", names)).toBe("b.png · 2 of 3");
  expect(nameLine("a.png", ["a.png"])).toBe("a.png");
  expect(nameLine("a.png", undefined)).toBe("a.png");
  expect(nameLine("x.png", names)).toBe("x.png");
});

test("stepping stops at the ends of the folder instead of wrapping", () => {
  const names = ["a.png", "b.png", "c.png"];
  expect(stepTarget(names, "b.png", 1)).toBe("c.png");
  expect(stepTarget(names, "b.png", -1)).toBe("a.png");
  expect(stepTarget(names, "c.png", 1)).toBeUndefined();
  expect(stepTarget(names, "a.png", -1)).toBeUndefined();
  expect(stepTarget(names, "x.png", 1)).toBeUndefined();
});

test("the wheel zooms smoothly in and out within the zoom range, and the sensor settling changes nothing", () => {
  expect(wheelZoom(1, 30)).toBeGreaterThan(1);
  expect(wheelZoom(1, 30)).toBeLessThan(1.25);
  expect(near(wheelZoom(wheelZoom(1, 30), -30), 1)).toBe(true);
  expect(wheelZoom(15.9, 2000 / 2)).toBe(16);
  expect(wheelZoom(0.06, -1000)).toBe(0.05);
  expect(wheelZoom(2, 5000)).toBe(2);
});

test("zooming keeps the point under the pointer still", () => {
  const pan = { x: 40, y: -20 };
  const at = { x: 100, y: 50 };
  const next = zoomAt(pan, at, 1, 2);
  // the picture point under `at` before: (at - pan) / 1; after: (at - next) / 2. Same point.
  expect(near((at.x - next.x) / 2, (at.x - pan.x) / 1)).toBe(true);
  expect(near((at.y - next.y) / 2, (at.y - pan.y) / 1)).toBe(true);
  expect(zoomAt(pan, at, 2, 2)).toEqual(pan);
});

test("controls hide after 2 s of stillness, and any movement starts the wait again", () => {
  const clock = fakeClock();
  const seen: boolean[] = [];
  const idle = createIdle(2000, clock, (active) => seen.push(active));
  idle.poke();
  expect(seen).toEqual([true]);
  clock.advance(1500);
  idle.poke();
  clock.advance(1500);
  expect(seen).toEqual([true]);
  clock.advance(500);
  expect(seen).toEqual([true, false]);
  idle.poke();
  expect(seen).toEqual([true, false, true]);
  idle.stop();
  clock.advance(5000);
  expect(seen).toEqual([true, false, true]);
});

test("a hold that is kept (a menu open) does not run out", () => {
  const clock = fakeClock();
  const seen: boolean[] = [];
  const idle = createIdle(2000, clock, (active) => seen.push(active));
  idle.poke();
  idle.hold(true);
  clock.advance(10_000);
  expect(seen).toEqual([true]);
  idle.hold(false);
  clock.advance(2000);
  expect(seen).toEqual([true, false]);
});

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    after(ms: number, run: () => void) {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of timers) {
        if (t.at <= now) {
          timers.delete(id);
          t.run();
        }
      }
    },
  };
}
