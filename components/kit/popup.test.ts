import { signal } from "nsh";
import { expect, test } from "nsh/test";

import { createOpenState, type OpenReason, placeBubble } from "./popup";

test("an uncontrolled popup holds its own state, starting from defaultOpen", () => {
  const state = createOpenState({ defaultOpen: true });
  expect(state.open()).toBe(true);
  expect(state.set(false, "escape-key")).toBe(true);
  expect(state.open()).toBe(false);
  // asking for what already is changes nothing and does not call onOpenChange
  const calls: boolean[] = [];
  const again = createOpenState({ onOpenChange: (open) => calls.push(open) });
  expect(again.set(false, "none")).toBe(false);
  expect(calls).toEqual([]);
});

test("a controlled popup only asks: the value changes when its owner passes a new one", () => {
  const owner = signal(false);
  const asked: [boolean, OpenReason][] = [];
  const state = createOpenState({
    open: () => owner(),
    onOpenChange: (open, change) => asked.push([open, change.reason]),
  });
  expect(state.set(true, "trigger-press")).toBe(true);
  expect(asked).toEqual([[true, "trigger-press"]]);
  expect(state.open()).toBe(false);
  owner.set(true);
  expect(state.open()).toBe(true);
});

test("onOpenChange can veto a change, and nothing moves", () => {
  const state = createOpenState({
    defaultOpen: true,
    onOpenChange: (_open, change) => change.reason === "outside-press" && change.cancel(),
  });
  expect(state.set(false, "outside-press")).toBe(false);
  expect(state.open()).toBe(true);
  expect(state.set(false, "escape-key")).toBe(true);
  expect(state.open()).toBe(false);
});

const win = { width: 1000, height: 700 };
const anchor = (x: number, y: number, width = 40, height = 32) => ({ x, y, width, height });

test("a bubble over a trigger at the left edge stays inside the window, lined up with the trigger", () => {
  const p = placeBubble({ anchor: anchor(10, 100), bubble: { width: 220, height: 24 }, window: win });
  expect(p.align).toBe("start");
  expect(p.x).toBe(10);
  expect(p.side).toBe("bottom");
  // a trigger so far left that even `start` is under the margin is pushed in
  expect(placeBubble({ anchor: anchor(2, 100), bubble: { width: 220, height: 24 }, window: win }).x).toBe(8);
});

test("a bubble at the right edge ends where its trigger ends and keeps the margin", () => {
  const p = placeBubble({ anchor: anchor(950, 100), bubble: { width: 220, height: 24 }, window: win });
  expect(p.align).toBe("end");
  expect(p.x).toBe(990 - 220);
  expect(p.x + p.width).toBeLessThanOrEqual(992);
  const flush = placeBubble({ anchor: anchor(990, 100, 40), bubble: { width: 220, height: 24 }, window: win });
  expect(flush.x + flush.width).toBe(992);
});

test("a bubble in the middle is centred on its trigger", () => {
  const p = placeBubble({ anchor: anchor(480, 100), bubble: { width: 100, height: 24 }, window: win });
  expect(p).toMatchObject({ align: "center", x: 450, y: 138, side: "bottom" });
});

test("a bubble flips above when there is no room below, and below when asked above has none", () => {
  const low = placeBubble({ anchor: anchor(400, 680), bubble: { width: 100, height: 24 }, window: win });
  expect(low.side).toBe("top");
  expect(low.y).toBe(680 - 6 - 24);
  const top = placeBubble({ anchor: anchor(400, 4), bubble: { width: 100, height: 24 }, window: win, side: "top" });
  expect(top.side).toBe("bottom");
  const asked = placeBubble({ anchor: anchor(400, 300), bubble: { width: 100, height: 24 }, window: win, side: "top" });
  expect(asked.side).toBe("top");
});

test("a bubble taller than either side keeps the side with more room and stays inside the window", () => {
  const p = placeBubble({ anchor: anchor(400, 200), bubble: { width: 100, height: 900 }, window: win });
  expect(p.side).toBe("bottom");
  expect(p.y).toBe(8);
});

test("a bubble wider than the window is narrowed to the window less its margins", () => {
  const p = placeBubble({
    anchor: anchor(100, 100),
    bubble: { width: 400, height: 24 },
    window: { width: 300, height: 700 },
  });
  expect(p.width).toBe(284);
  expect(p.x).toBe(8);
});
