import { expect, test } from "nsh/test";

import { clampPan, fitScale, overflows, rotatedBy, turned, zoomed, ZOOM_MAX, ZOOM_MIN } from "#lib/image-view";

const box = { width: 800, height: 400 };

test("a big picture fits the box and a small one keeps its own size", () => {
  expect(fitScale({ width: 1600, height: 400 }, 0, box)).toBe(0.5);
  expect(fitScale({ width: 400, height: 800 }, 0, box)).toBe(0.5);
  expect(fitScale({ width: 100, height: 50 }, 0, box)).toBe(1);
  // Unknown sizes are not a division by zero.
  expect(fitScale({ width: 0, height: 0 }, 0, box)).toBe(1);
});

test("a quarter turn swaps the sides before fitting: a wide picture turned is tall", () => {
  expect(turned({ width: 1600, height: 400 }, 90)).toEqual({ width: 400, height: 1600 });
  expect(fitScale({ width: 1600, height: 400 }, 90, box)).toBe(0.25);
  expect(turned({ width: 1600, height: 400 }, 180)).toEqual({ width: 1600, height: 400 });
  expect(rotatedBy(270)).toBe(0);
  expect(rotatedBy(0)).toBe(90);
});

test("zoom steps are a quarter at a time and stop at the limits", () => {
  expect(zoomed(1, 1)).toBe(1.25);
  expect(zoomed(1.25, -1)).toBe(1);
  expect(zoomed(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
  expect(zoomed(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
});

test("a picture can be dragged only as far as its edges reach the box's, and stays centred when it is smaller", () => {
  const shown = { width: 1000, height: 300 };
  expect(overflows(shown, box)).toBe(true);
  expect(clampPan({ x: 500, y: 90 }, shown, box)).toEqual({ x: 100, y: 0 });
  expect(clampPan({ x: -500, y: -90 }, shown, box)).toEqual({ x: -100, y: 0 });
  expect(overflows({ width: 200, height: 100 }, box)).toBe(false);
  expect(clampPan({ x: 40, y: 40 }, { width: 200, height: 100 }, box)).toEqual({ x: 0, y: 0 });
});
