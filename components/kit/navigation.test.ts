import { expect, test } from "nsh/test";
import { fold } from "../../lib/text";
import { TRANSIT_MS } from "./hover";
import {
  alignSelected,
  centerOffset,
  createHoverIntent,
  edgeIndex,
  inTransit,
  isTyping,
  offsetsOf,
  pageIndex,
  revealOffset,
  type Scheduler,
  stepIndex,
  type Typing,
  typeahead,
  TYPING_RESET_MS,
} from "./navigation";

test("stepping skips rows that cannot take the highlight and wraps round when it loops", () => {
  const skip = [false, true, false];
  expect(stepIndex(skip, 0, 1, true)).toBe(2);
  expect(stepIndex(skip, 2, 1, true)).toBe(0);
  expect(stepIndex(skip, 0, -1, true)).toBe(2);
  expect(stepIndex(skip, -1, 1, true)).toBe(0);
  expect(stepIndex(skip, -1, -1, true)).toBe(2);
  expect(stepIndex([true, true], -1, 1, true)).toBe(-1);
  expect(stepIndex([], -1, 1, true)).toBe(-1);
});

test("without loop the highlight stops at either end", () => {
  const skip = [false, false, true];
  expect(stepIndex(skip, 1, 1, false)).toBe(1);
  expect(stepIndex(skip, 0, -1, false)).toBe(0);
  expect(stepIndex(skip, 0, 1, false)).toBe(1);
  // Nothing highlighted yet: a step still enters the list at its near end.
  expect(stepIndex(skip, -1, -1, false)).toBe(1);
});

test("Home and End are the first and last row that can be chosen", () => {
  expect(edgeIndex([true, false, false, true], 1)).toBe(1);
  expect(edgeIndex([true, false, false, true], -1)).toBe(2);
  expect(edgeIndex([true], 1)).toBe(-1);
});

test("a page moves a screenful, stops at the ends and does not wrap", () => {
  const skip = Array.from({ length: 20 }, () => false);
  expect(pageIndex(skip, 2, 1, 8)).toBe(10);
  expect(pageIndex(skip, 15, 1, 8)).toBe(19);
  expect(pageIndex(skip, 5, -1, 8)).toBe(0);
  expect(pageIndex(skip, -1, 1, 8)).toBe(0);
  // The row a page lands on is a heading: back up to the one before it.
  expect(pageIndex([false, false, false, true], 0, 1, 3)).toBe(2);
  expect(pageIndex([false, true, true], 0, 1, 2)).toBe(0);
});

const labels = ["Copy session id", "\u0110one", "Zoë delete…"].map(fold);
const none = [false, false, false];

function type(keys: string, from: number, start = 0, skip = none, words = labels) {
  let typing: Typing | undefined;
  let index = from;
  let now = start;
  for (const key of keys) {
    const next = typeahead(typing, key, words, skip, index, now);
    typing = next.typing;
    if (next.index >= 0) index = next.index;
    now += 100;
  }
  return { index, typing };
}

test("typeahead finds a row by its first letters, ignoring accents and case", () => {
  expect(type("d", -1).index).toBe(1);
  expect(type("\u0111o", -1).index).toBe(1);
  expect(type("ZOE", 0).index).toBe(2);
  expect(typeahead(undefined, "q", labels, none, 0, 0).index).toBe(-1);
  expect(typeahead(undefined, "d", labels, [false, true, false], -1, 0).index).toBe(-1);
});

test("a session starts after the highlighted row, so the same letter finds the next row", () => {
  const rows = ["Brûlée", "Bäcker", "Crème"].map(fold);
  expect(typeahead(undefined, "b", rows, none, -1, 0).index).toBe(0);
  expect(typeahead(undefined, "b", rows, none, 0, 0).index).toBe(1);
  expect(typeahead(undefined, "b", rows, none, 1, 0).index).toBe(0);
});

test("one letter typed again walks through the rows that start with it", () => {
  const rows = ["Brûlée", "Bäcker", "Crème", "Bébé"].map(fold);
  const skip = [false, false, false, false];
  const first = typeahead(undefined, "b", rows, skip, -1, 0);
  const second = typeahead(first.typing, "b", rows, skip, first.index, 100);
  const third = typeahead(second.typing, "b", rows, skip, second.index, 200);
  const fourth = typeahead(third.typing, "b", rows, skip, third.index, 300);
  expect([first.index, second.index, third.index, fourth.index]).toEqual([0, 1, 3, 0]);
});

test("a doubled first letter in some row turns the cycling off: the letters are a word", () => {
  const rows = ["Llama", "Lácteo", "Chéri"].map(fold);
  const skip = [false, false, false];
  const first = typeahead(undefined, "l", rows, skip, -1, 0);
  expect(first.index).toBe(0);
  const second = typeahead(first.typing, "l", rows, skip, first.index, 100);
  expect(second.index).toBe(0);
  expect(second.typing?.text).toBe("ll");
});

test("a longer word narrows from where the session started, and a space continues it", () => {
  const rows = ["Café open", "Café lünch", "Café lünch quick"].map(fold);
  const skip = [false, false, false];
  expect(type("cafe l", -1, 0, skip, rows).index).toBe(1);
  expect(type("cafe lunch q", -1, 0, skip, rows).index).toBe(2);
});

test("the session is over after the reset time, and a key that finds nothing ends it", () => {
  const rows = ["Brûlée", "Bäcker"].map(fold);
  const skip = [false, false];
  const first = typeahead(undefined, "b", rows, skip, -1, 0);
  expect(isTyping(first.typing, TYPING_RESET_MS)).toBe(true);
  expect(isTyping(first.typing, TYPING_RESET_MS + 1)).toBe(false);
  // Late: "a" starts a new word instead of extending "b".
  const late = typeahead(first.typing, "a", rows, skip, first.index, TYPING_RESET_MS + 1);
  expect(late.index).toBe(-1);
  expect(late.typing).toBe(undefined);
  const miss = typeahead(first.typing, "z", rows, skip, first.index, 100);
  expect(miss.index).toBe(-1);
  expect(miss.typing).toBe(undefined);
});

test("offsets add up row heights, and revealing scrolls only as far as it must", () => {
  const offsets = offsetsOf([32, 28, 9, 32, 32]);
  expect(offsets).toEqual([0, 32, 60, 69, 101, 133]);
  expect(revealOffset(offsets, 1, 0, 100)).toBe(undefined);
  expect(revealOffset(offsets, 4, 0, 100)).toBe(33);
  expect(revealOffset(offsets, 0, 33, 100)).toBe(0);
  expect(centerOffset(offsets, 3, 40)).toBe(Math.min(133 - 40, 85 - 20));
  expect(centerOffset(offsets, 0, 40)).toBe(0);
  expect(centerOffset(offsets, 4, 40)).toBe(133 - 40);
});

const AREA = { top: 13, bottom: 787 };

test("a list opens over its trigger: the selected row sits on the trigger's centre", () => {
  // Three rows, none scrolled: the popup hangs from the row's place.
  const near = alignSelected({ target: 200, rowCenter: 16, rowHeight: 32, content: 96, max: 380, area: AREA });
  expect(near).toEqual({ top: 184, height: 96, scroll: 0 });
  // A deep row of a long list: the viewport is as tall as allowed and the content is scrolled to the row.
  const deep = alignSelected({ target: 400, rowCenter: 9600, rowHeight: 32, content: 16000, max: 380, area: AREA });
  expect(deep?.height).toBe(380);
  expect(deep && deep.top + (9600 - deep.scroll)).toBe(400);
  expect(deep && deep.top >= AREA.top && deep.top + deep.height <= AREA.bottom).toBe(true);
});

test("with little room below the trigger the list is made shorter instead of moved", () => {
  const short = alignSelected({ target: 424, rowCenter: 16, rowHeight: 32, content: 2560, max: 384, area: { top: 13, bottom: 786 } });
  expect(short).toEqual({ top: 408, height: 378, scroll: 0 });
});

test("a row near the top of the area scrolls the content instead of leaving the area", () => {
  const high = alignSelected({ target: 40, rowCenter: 500, rowHeight: 32, content: 2000, max: 380, area: AREA });
  expect(high && high.top >= AREA.top).toBe(true);
  expect(high && high.top + (500 - high.scroll)).toBe(40);
});

test("a trigger too near an edge for its row to stay in view gives no alignment", () => {
  expect(alignSelected({ target: 780, rowCenter: 16, rowHeight: 32, content: 3200, max: 380, area: AREA })).toBe(undefined);
  expect(alignSelected({ target: 14, rowCenter: 5000, rowHeight: 32, content: 8000, max: 380, area: AREA })).toBe(undefined);
});

test("the pointer is in transit while it is inside the triangle to a submenu, and not once it strays", () => {
  // The submenu opens to the right: its near edge is x=200, from y=100 to y=300. The pointer was last on its row at (100, 110).
  const menu = { origin: { x: 200, y: 100 }, size: { width: 160, height: 200 } };
  const apex = { x: 100, y: 110 };
  expect(inTransit(apex, menu, { x: 150, y: 150 })).toBe(true);
  expect(inTransit(apex, menu, { x: 190, y: 270 })).toBe(true);
  expect(inTransit(apex, menu, { x: 250, y: 150 })).toBe(true);
  // Straight down from the row, and straight up: the rows beside the trigger take the pointer.
  expect(inTransit(apex, menu, { x: 100, y: 160 })).toBe(false);
  expect(inTransit(apex, menu, { x: 120, y: 60 })).toBe(false);
  expect(inTransit(apex, menu, { x: 60, y: 150 })).toBe(false);
});

test("the triangle points the other way when the submenu opens to the left", () => {
  const menu = { origin: { x: 0, y: 100 }, size: { width: 160, height: 200 } };
  const apex = { x: 260, y: 110 };
  expect(inTransit(apex, menu, { x: 200, y: 150 })).toBe(true);
  expect(inTransit(apex, menu, { x: 260, y: 160 })).toBe(false);
});

/** A clock the test turns by hand. */
function clock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const schedule: Scheduler = {
    set: (run, ms) => {
      pending.set(next, { at: now + ms, run });
      return next++;
    },
    clear: (id) => {
      if (id !== undefined) pending.delete(id);
    },
  };
  return {
    schedule,
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.run();
        }
      }
    },
  };
}

function hover(delay: number, closeDelay: number) {
  const time = clock();
  let open = false;
  const intent = createHoverIntent({
    delay,
    closeDelay,
    isOpen: () => open,
    open: () => {
      open = true;
    },
    close: () => {
      open = false;
    },
    schedule: time.schedule,
  });
  return { intent, time, isOpen: () => open };
}

test("hovering opens after the delay, and leaving first cancels a pending open", () => {
  const h = hover(100, 0);
  h.intent.enterTrigger();
  h.time.tick(99);
  expect(h.isOpen()).toBe(false);
  h.time.tick(1);
  expect(h.isOpen()).toBe(true);
  h.intent.leaveTrigger(false);
  expect(h.isOpen()).toBe(false);

  h.intent.enterTrigger();
  h.time.tick(50);
  h.intent.leaveTrigger(false);
  h.time.tick(500);
  expect(h.isOpen()).toBe(false);
});

test("a close delay holds the popup open, and coming back to the trigger or reaching the popup keeps it", () => {
  const h = hover(0, 200);
  h.intent.enterTrigger();
  expect(h.isOpen()).toBe(true);
  h.intent.leaveTrigger(false);
  h.time.tick(199);
  expect(h.isOpen()).toBe(true);
  h.intent.enterTrigger();
  h.time.tick(500);
  expect(h.isOpen()).toBe(true);
  h.intent.leaveTrigger(false);
  h.intent.enterPopup();
  h.time.tick(500);
  expect(h.isOpen()).toBe(true);
  h.intent.leavePopup();
  h.time.tick(200);
  expect(h.isOpen()).toBe(false);
});

test("a pointer on its way to the popup gets the transit time before the popup closes", () => {
  const h = hover(0, 0);
  h.intent.enterTrigger();
  h.intent.leaveTrigger(true);
  h.time.tick(TRANSIT_MS - 1);
  expect(h.isOpen()).toBe(true);
  h.intent.enterPopup();
  h.time.tick(1000);
  expect(h.isOpen()).toBe(true);

  const strayed = hover(0, 0);
  strayed.intent.enterTrigger();
  strayed.intent.leaveTrigger(true);
  strayed.time.tick(TRANSIT_MS);
  expect(strayed.isOpen()).toBe(false);
});
