import { expect, test } from "nsh/test";

import {
  appear,
  arrivals,
  BURST_MS,
  BURST_ROWS,
  arrived,
  contextEnter,
  createPresence,
  CONTEXT_REPEAT_MS,
  hoverTransition,
  KEY_WINDOW_MS,
  LIVE_TURN_TICKS,
  liveTurn,
  markKeyboard,
  motionClock,
  motionReady,
  moveTransition,
  popupOrigin,
  pressTransition,
  SETTLE_MS,
  swapped,
  SWAP_QUIET_MS,
  toastLook,
  trackTransition,
} from "#lib/motion";
import { reduceMotionOverride } from "#lib/settings";

/** A clock that only moves when told to, and timers that only run when it gets there: no test reads the real one. */
let epoch = 0;
function fakeClock() {
  // Each clock starts later than the last: the module remembers the last key press across tests.
  epoch += 1_000_000;
  let now = epoch;
  let timers: { at: number; run: () => void }[] = [];
  motionClock.now = () => now;
  motionClock.after = (ms, run) => {
    const timer = { at: now + ms, run };
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  return {
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.run();
    },
  };
}

/** Each test starts from a quiet app that is ready, with motion allowed, and a clock of its own. */
function setup() {
  reduceMotionOverride.set(false);
  motionReady.set(true);
  const clock = fakeClock();
  // Far enough from any earlier key press of another test.
  clock.advance(KEY_WINDOW_MS * 10);
  return clock;
}

test("reduced motion removes every transition and every arrival", () => {
  setup();
  expect(pressTransition()).toBeDefined();
  expect(hoverTransition()).toBeDefined();
  expect(moveTransition()).toBeDefined();
  expect(trackTransition()).toBeDefined();
  expect(Object.keys(toastLook()).length).toBeGreaterThan(0);
  reduceMotionOverride.set(true);
  expect(pressTransition()).toBeUndefined();
  expect(hoverTransition()).toBeUndefined();
  expect(moveTransition()).toBeUndefined();
  expect(trackTransition()).toBeUndefined();
  expect(toastLook()).toEqual({});
  expect(appear("reduced-key")).toBeUndefined();
  reduceMotionOverride.set(false);
});

test("the live glyph turns an eighth every LIVE_TURN_TICKS ticker steps, all the way round, and not at all under reduced motion", () => {
  setup();
  const turns = Array.from({ length: 8 * LIVE_TURN_TICKS + 1 }, (_, tick) => liveTurn(tick));
  expect(new Set(turns).size).toBe(8);
  expect(turns[LIVE_TURN_TICKS - 1]).toBe(turns[0]);
  expect(turns[LIVE_TURN_TICKS]).not.toBe(turns[0]);
  expect(turns.at(-1)).toBe(turns[0]);
  reduceMotionOverride.set(true);
  expect(turns.map((_, tick) => liveTurn(tick)).every((c) => c === "")).toBe(true);
  reduceMotionOverride.set(false);
});

test("a thing arrives once per key, never before the app is ready and never after a key", () => {
  const clock = setup();
  motionReady.set(false);
  expect(appear("starting")).toBeUndefined();
  motionReady.set(true);
  // Seen while starting: building it again is not an arrival.
  expect(appear("starting")).toBeUndefined();

  expect(appear("card-1")).toBeDefined();
  expect(appear("card-1")).toBeUndefined();

  markKeyboard();
  expect(appear("card-2")).toBeUndefined();
  // The key is remembered as seen: it does not arrive later either.
  clock.advance(KEY_WINDOW_MS * 2);
  expect(appear("card-2")).toBeUndefined();
  expect(arrived("card-3")).toBe(true);
});

test("a thing without a key arrives every time it is built", () => {
  setup();
  expect(arrived()).toBe(true);
  expect(arrived()).toBe(true);
});

test("the lines of a list move only when they are new after it settled", () => {
  const clock = setup();
  const list = arrivals();
  expect(list.isNew("first")).toBe(false);
  clock.advance(SETTLE_MS);
  expect(list.isNew("second")).toBe(true);
  expect(list.isNew("second")).toBe(false);
  // Seen before it settled: scrolling back to it never moves it.
  expect(list.isNew("first")).toBe(false);
});

test("lines that come while a turn runs, or faster than the rise ends, do not rise", () => {
  const clock = setup();
  let running = true;
  const list = arrivals(() => running);
  clock.advance(SETTLE_MS);
  expect(list.isNew("streamed")).toBe(false);
  running = false;
  clock.advance(BURST_MS);
  // The turn is over: a first line rises, and so do the next ones up to the burst limit, no more.
  expect(Array.from({ length: BURST_ROWS + 2 }, (_, i) => list.isNew(`row-${i}`))).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  // A burst that was not shown is never shown late, and a quiet second brings the rise back.
  expect(list.isNew("row-4")).toBe(false);
  clock.advance(BURST_MS);
  expect(list.isNew("later")).toBe(true);
});

test("a project switch plays its fade once per gesture and never for a key", () => {
  const clock = setup();
  const enter = contextEnter();
  expect(enter.play()).toBe(true);
  clock.advance(CONTEXT_REPEAT_MS - 1);
  expect(enter.play()).toBe(false);
  // Held keys keep it quiet: the window restarts at each switch.
  clock.advance(CONTEXT_REPEAT_MS - 1);
  expect(enter.play()).toBe(false);
  clock.advance(CONTEXT_REPEAT_MS);
  expect(enter.play()).toBe(true);

  clock.advance(CONTEXT_REPEAT_MS * 2);
  markKeyboard();
  expect(enter.play()).toBe(false);
  clock.advance(CONTEXT_REPEAT_MS * 2);
  expect(enter.play()).toBe(true);

  reduceMotionOverride.set(true);
  clock.advance(CONTEXT_REPEAT_MS * 2);
  expect(enter.play()).toBe(false);
  reduceMotionOverride.set(false);
});

test("a number that ticks flashes once, not at every change", () => {
  const clock = setup();
  const swap = swapped();
  expect(swap.changed()).toBe(true);
  clock.advance(SWAP_QUIET_MS - 1);
  expect(swap.changed()).toBe(false);
  clock.advance(SWAP_QUIET_MS - 1);
  expect(swap.changed()).toBe(false);
  clock.advance(SWAP_QUIET_MS);
  expect(swap.changed()).toBe(true);
});

test("a closing popup stays built for its exit, and opening again keeps it", () => {
  const clock = setup();
  const presence = createPresence(false, 120);
  expect(presence.mounted()).toBe(false);

  presence.set(true);
  expect(presence.mounted()).toBe(true);
  expect(presence.closing()).toBe(false);

  presence.set(false);
  expect(presence.mounted()).toBe(true);
  expect(presence.closing()).toBe(true);
  clock.advance(119);
  expect(presence.mounted()).toBe(true);
  clock.advance(1);
  expect(presence.mounted()).toBe(false);
  expect(presence.closing()).toBe(false);

  // Reopened in the middle of the exit: it never goes, and the unbuild timer is cancelled.
  presence.set(true);
  presence.set(false);
  clock.advance(60);
  presence.set(true);
  expect(presence.closing()).toBe(false);
  clock.advance(500);
  expect(presence.mounted()).toBe(true);
});

test("a popup closes at once when there is nothing to wait for", () => {
  const clock = setup();
  const none = createPresence(true, 0);
  none.set(false);
  expect(none.mounted()).toBe(false);

  const reduced = createPresence(true, 120);
  reduceMotionOverride.set(true);
  reduced.set(false);
  expect(reduced.mounted()).toBe(false);
  expect(reduced.closing()).toBe(false);
  reduceMotionOverride.set(false);

  // Closing something that was never built does nothing, not even a timer.
  const closed = createPresence(false, 120);
  closed.set(false);
  clock.advance(1000);
  expect(closed.mounted()).toBe(false);
});

test("a popover grows from the edge that touches its trigger, on the side it was placed", () => {
  expect(popupOrigin("bottom", "start")).toBe("0% 0%");
  expect(popupOrigin("bottom", "center")).toBe("50% 0%");
  expect(popupOrigin("top", "end")).toBe("100% 100%");
  expect(popupOrigin("right", "center")).toBe("0% 50%");
  expect(popupOrigin("left", "start")).toBe("100% 0%");
});
