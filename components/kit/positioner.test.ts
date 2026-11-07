import { expect, test } from "nsh/test";

import type { OverlayPosition, Placement } from "nsh/types";

import { anchorMoved, inSafeZone, type Rect } from "./positioner";

function placed(
  placement: OverlayPosition["placement"],
  x: number,
  y: number,
  width = 120,
  height = 24,
): OverlayPosition {
  return { placement, bounds: { origin: { x, y }, size: { width, height } }, available: { width: 400, height: 400 } };
}

test("a popup ends when the anchor it hangs from moves, not when it changes size or flips side", () => {
  const first = anchorMoved(undefined, placed("bottom", 100, 200));
  expect(first.moved).toBe(false);
  // measured again at another width: the corner moves, the anchor did not
  expect(anchorMoved(first.hung, placed("bottom", 80, 200, 160)).moved).toBe(false);
  // scrolled by a few points
  expect(anchorMoved(first.hung, placed("bottom", 100, 197)).moved).toBe(true);
  // scrolled sideways, same size
  expect(anchorMoved(first.hung, placed("bottom", 130, 200)).moved).toBe(true);
  // no room below: it went above, which is not movement
  expect(anchorMoved(first.hung, placed("top", 100, 150)).moved).toBe(false);
  // a pixel of rounding is not movement
  expect(anchorMoved(first.hung, placed("bottom", 100, 200.4)).moved).toBe(false);
});

test("the edge that faces the anchor is what is compared on every side", () => {
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const first = anchorMoved(undefined, placed(side, 100, 100));
    const away = side === "top" || side === "bottom" ? placed(side, 100, 120) : placed(side, 120, 100);
    expect(anchorMoved(first.hung, placed(side, 100, 100)).moved).toBe(false);
    expect(anchorMoved(first.hung, away).moved).toBe(true);
  }
});

test("a popup that grew where nothing fits is clamped by nsh, and that is not the anchor moving", () => {
  const first = anchorMoved(undefined, placed("bottom", 100, 200, 120, 100));
  // the content grew to 300 tall: kept inside its area, the corner rose while the trigger stayed
  expect(anchorMoved(first.hung, placed("bottom", 100, 100, 120, 300)).moved).toBe(false);
  // above the anchor the edge is the bottom of the popup, which also follows a clamped height
  const above = anchorMoved(undefined, placed("top", 100, 100, 120, 100));
  expect(anchorMoved(above.hung, placed("top", 100, 20, 120, 280)).moved).toBe(false);
  // and a real scroll after it is still seen against the new baseline
  const grown = anchorMoved(first.hung, placed("bottom", 100, 100, 120, 300));
  expect(anchorMoved(grown.hung, placed("bottom", 100, 90, 120, 300)).moved).toBe(true);
});

const trigger: Rect = { x: 100, y: 100, width: 80, height: 20 };

/** A 120 x 60 popup 8 points off the trigger on `side`, centred on it. */
function popupOn(side: Placement): Rect {
  if (side === "bottom") return { x: 80, y: 128, width: 120, height: 60 };
  if (side === "top") return { x: 80, y: 32, width: 120, height: 60 };
  if (side === "right") return { x: 188, y: 80, width: 120, height: 60 };
  return { x: -28, y: 80, width: 120, height: 60 };
}

test("the pointer may be over the trigger, the popup, or the gap between them", () => {
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const popup = popupOn(side);
    const apex = { x: 140, y: 110 };
    expect(inSafeZone(apex, trigger, popup, side, { x: 140, y: 110 })).toBe(true);
    expect(inSafeZone(apex, trigger, popup, side, { x: popup.x + 10, y: popup.y + 10 })).toBe(true);
  }
  // the gap between the trigger and the popup, within the narrower of the two
  expect(inSafeZone({ x: 140, y: 118 }, trigger, popupOn("bottom"), "bottom", { x: 105, y: 124 })).toBe(true);
  expect(inSafeZone({ x: 140, y: 100 }, trigger, popupOn("top"), "top", { x: 170, y: 96 })).toBe(true);
  expect(inSafeZone({ x: 180, y: 110 }, trigger, popupOn("right"), "right", { x: 184, y: 105 })).toBe(true);
  expect(inSafeZone({ x: 100, y: 110 }, trigger, popupOn("left"), "left", { x: 96, y: 110 })).toBe(true);
});

test("the triangle from where the pointer left toward the popup is safe, and the way back or away is not", () => {
  const popup: Rect = { x: 100, y: 300, width: 200, height: 100 };
  const wide: Rect = { x: 100, y: 100, width: 80, height: 20 };
  // left the trigger at its top edge, far from the popup's near edge: a point on the way
  const apex = { x: 110, y: 101 };
  expect(inSafeZone(apex, wide, popup, "bottom", { x: 150, y: 200 })).toBe(true);
  // beside the line to the popup's far corner
  expect(inSafeZone(apex, wide, popup, "bottom", { x: 280, y: 130 })).toBe(false);
  // the other way from the trigger
  expect(inSafeZone(apex, wide, popup, "bottom", { x: 110, y: 20 })).toBe(false);
  // far to the side, level with the gap
  expect(inSafeZone(apex, wide, popup, "bottom", { x: 600, y: 200 })).toBe(false);
});

test("the same triangle holds for a popup above, to the left and to the right", () => {
  const wide: Rect = { x: 100, y: 300, width: 80, height: 20 };
  const above: Rect = { x: 100, y: 100, width: 200, height: 100 };
  expect(inSafeZone({ x: 110, y: 319 }, wide, above, "top", { x: 150, y: 220 })).toBe(true);
  expect(inSafeZone({ x: 110, y: 319 }, wide, above, "top", { x: 600, y: 220 })).toBe(false);

  const tall: Rect = { x: 100, y: 100, width: 20, height: 80 };
  const right: Rect = { x: 300, y: 100, width: 100, height: 200 };
  expect(inSafeZone({ x: 101, y: 110 }, tall, right, "right", { x: 200, y: 150 })).toBe(true);
  expect(inSafeZone({ x: 101, y: 110 }, tall, right, "right", { x: 200, y: 600 })).toBe(false);

  const left: Rect = { x: -100, y: 100, width: 100, height: 200 };
  expect(inSafeZone({ x: 101, y: 110 }, tall, left, "left", { x: 50, y: 150 })).toBe(true);
  expect(inSafeZone({ x: 101, y: 110 }, tall, left, "left", { x: 50, y: 600 })).toBe(false);
});
