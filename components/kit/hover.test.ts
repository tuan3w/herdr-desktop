import { signal } from "nsh";
import { expect, test } from "nsh/test";

import type { OverlayPosition, ViewRef } from "nsh/types";

import { trackDialog } from "./dialog-stack";
import { createHover, type HoverOptions, type HoverTrigger, TRANSIT_MS } from "./hover";

import type { OpenReason } from "./popup";

let ids = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An open state that records what it was asked, and may refuse. */
function rig(over: Partial<HoverOptions> = {}) {
  const log: string[] = [];
  let open = false;
  let refuse = false;
  const state = {
    open: () => open,
    set(next: boolean, reason: OpenReason) {
      if (next === open || (refuse && !next)) return false;
      open = next;
      log.push(`${next ? "open" : "close"}:${reason}`);
      return true;
    },
  };
  const hover = createHover<HoverTrigger>({
    state,
    delay: 30,
    closeDelay: 0,
    group: 80,
    focusDelay: 0,
    hoverable: false,
    measure: async () => ({ x: 0, y: 0, width: 100, height: 20 }),
    ...over,
  });
  return {
    hover,
    log,
    refuse: (v: boolean) => {
      refuse = v;
    },
    trigger(opts: Partial<HoverTrigger> = {}) {
      const t: HoverTrigger = {
        node: { id: ++ids } as unknown as ViewRef,
        disabled: () => false,
        ...opts,
      };
      return { t, ...hover.register(t) };
    },
  };
}

function placed(x: number, y: number, width = 100, height = 50): OverlayPosition {
  return {
    placement: "bottom",
    bounds: { origin: { x, y }, size: { width, height } },
    available: { width: 400, height: 400 },
  };
}

test("the first popup waits for the pointer to rest, and leaving before that opens nothing", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  a.enter();
  await wait(10);
  a.leave();
  await wait(60);
  expect(log).toEqual([]);
  a.enter();
  expect(hover.open()).toBe(false);
  await wait(60);
  expect(log).toEqual(["open:trigger-hover"]);
  a.leave();
  expect(log).toEqual(["open:trigger-hover", "close:trigger-hover"]);
  expect(hover.active()).toBe(null);
});

test("a trigger's own delay and closeDelay win over the root's, and delay 0 opens at once", async () => {
  const { log, trigger } = rig();
  const slow = trigger({ delay: 120, closeDelay: 60 });
  slow.enter();
  await wait(70);
  expect(log).toEqual([]);
  await wait(90);
  expect(log).toEqual(["open:trigger-hover"]);
  slow.leave();
  expect(log.length).toBe(1);
  await wait(90);
  expect(log).toEqual(["open:trigger-hover", "close:trigger-hover"]);

  const instant = trigger({ delay: 0 });
  instant.enter();
  expect(log.length).toBe(3);
});

test("the next trigger opens at once while one is open or for a while after the pointer left, not after a press or Escape", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  const b = trigger();
  a.enter();
  await wait(60);
  a.leave();
  b.enter();
  expect(log).toEqual(["open:trigger-hover", "close:trigger-hover", "open:trigger-hover"]);
  b.leave();
  await wait(120);
  b.enter();
  expect(hover.open()).toBe(false);
  await wait(60);
  expect(hover.open()).toBe(true);

  hover.press();
  expect(hover.open()).toBe(false);
  a.enter();
  expect(hover.open()).toBe(false);
  a.leave();

  b.enter();
  await wait(60);
  hover.escape();
  a.enter();
  expect(hover.open()).toBe(false);
});

test("moving to another trigger while open moves the popup and is not an open change", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  const b = trigger();
  a.enter();
  await wait(60);
  b.enter();
  expect(hover.active()).toBe(b.t);
  a.leave();
  expect(hover.active()).toBe(b.t);
  expect(log).toEqual(["open:trigger-hover"]);
  b.leave();
  expect(hover.active()).toBe(null);
});

test("a disabled trigger opens nothing, closes another's popup under the pointer, and a popup closes when its trigger becomes disabled", async () => {
  const { hover, log, trigger } = rig();
  let off = false;
  const a = trigger({ disabled: () => off });
  const b = trigger({ disabled: () => true });
  b.enter();
  await wait(60);
  expect(log).toEqual([]);
  b.leave();
  a.enter();
  await wait(60);
  expect(hover.open()).toBe(true);
  b.enter();
  expect(log[1]).toBe("close:trigger-hover");
  b.leave();

  a.enter();
  await wait(5);
  hover.hide("none");
  a.leave();
  a.enter();
  await wait(60);
  expect(hover.open()).toBe(true);
  off = true;
  hover.sync();
  expect(log[log.length - 1]).toBe("close:disabled");
});

test("a press ends the popup: on its trigger when that closes on click, and a trigger that ignores clicks keeps it", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  a.enter();
  await wait(60);
  hover.press();
  expect(log[1]).toBe("close:trigger-press");

  const stays = trigger({ closeOnClick: false });
  stays.enter();
  await wait(60);
  hover.press();
  expect(hover.open()).toBe(true);
  stays.leave();
  a.enter();
  await wait(60);
  a.leave();
  hover.press();
  expect(hover.open()).toBe(false);
});

test("a press on another place closes with outside-press, and a press before the delay cancels the pending open", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  a.enter();
  await wait(60);
  a.leave();
  hover.press();
  expect(log).toEqual(["open:trigger-hover", "close:trigger-hover"]);

  const b = trigger();
  b.enter();
  await wait(5);
  hover.press();
  await wait(60);
  expect(hover.open()).toBe(false);

  const c = trigger({ closeOnClick: false });
  c.enter();
  await wait(5);
  hover.press();
  await wait(60);
  expect(hover.open()).toBe(true);
  c.leave();
  hover.hide("outside-press");
  expect(log[log.length - 1]).toBe("close:outside-press");
});

test("the owner may refuse a close, and the popup then stays", async () => {
  const { hover, refuse, log, trigger } = rig();
  const a = trigger();
  a.enter();
  await wait(60);
  refuse(true);
  a.leave();
  expect(hover.open()).toBe(true);
  expect(hover.active()).toBe(a.t);
  refuse(false);
  hover.escape();
  expect(log[log.length - 1]).toBe("close:escape-key");
});

test("keyboard focus opens at once and blur closes; the focus a press gives does not count", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  hover.press();
  a.focus();
  expect(hover.open()).toBe(false);
  a.blur();
  await wait(300);
  a.focus();
  expect(log).toEqual(["open:trigger-focus"]);
  a.blur();
  expect(log).toEqual(["open:trigger-focus", "close:trigger-focus"]);

  // opened by the pointer, then the focus comes and goes: the pointer's popup stays until the pointer leaves
  a.enter();
  await wait(60);
  a.focus();
  a.blur();
  expect(hover.open()).toBe(true);
  a.leave();
  expect(hover.open()).toBe(false);

  // opened by focus: the pointer leaving does not close it
  a.focus();
  a.enter();
  a.leave();
  expect(hover.open()).toBe(true);
  a.blur();
  expect(hover.open()).toBe(false);
});

test("a trigger that is disabled does not open on focus, and a focus delay waits", async () => {
  const { hover, trigger } = rig({ focusDelay: 40 });
  const off = trigger({ disabled: () => true });
  off.focus();
  await wait(70);
  expect(hover.open()).toBe(false);
  const a = trigger();
  await wait(300);
  a.focus();
  expect(hover.open()).toBe(false);
  await wait(70);
  expect(hover.open()).toBe(true);
  const b = trigger();
  await wait(300);
  hover.hide("none");
  b.focus();
  b.blur();
  await wait(70);
  expect(hover.open()).toBe(false);
});

test("nested triggers: the inner one opens, and leaving it for the outer one opens the outer again", async () => {
  const { hover, log, trigger } = rig();
  const outer = trigger();
  const inner = trigger();
  outer.enter();
  await wait(60);
  inner.enter();
  expect(hover.active()).toBe(inner.t);
  inner.leave();
  expect(hover.open()).toBe(true);
  expect(hover.active()).toBe(outer.t);
  expect(log.filter((l) => l.startsWith("open")).length).toBe(2);
  outer.leave();
  expect(hover.open()).toBe(false);
});

test("a trigger that goes away takes its popup and its pending open with it", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  a.enter();
  await wait(60);
  a.gone();
  expect(log).toEqual(["open:trigger-hover", "close:none"]);
  const b = trigger();
  b.enter();
  b.gone();
  await wait(60);
  expect(hover.open()).toBe(false);
});

test("a hoverable popup waits for the pointer: over it, in the gap, or for the close delay", async () => {
  const { hover, log, trigger } = rig({ hoverable: true, closeDelay: 20, group: 0 });
  const a = trigger();
  a.enter();
  await wait(60);
  hover.placed(placed(0, 30));
  a.leave();
  expect(hover.tracking()).toBe(true);
  await wait(5);
  hover.popupEnter();
  expect(hover.tracking()).toBe(false);
  await wait(TRANSIT_MS + 60);
  expect(hover.open()).toBe(true);

  hover.popupLeave();
  expect(hover.tracking()).toBe(true);
  hover.popupEnter();
  hover.popupLeave();
  a.enter();
  expect(hover.tracking()).toBe(false);
  a.leave();
  await wait(5);
  hover.track({ x: 50, y: 22 });
  await wait(100);
  expect(hover.open()).toBe(true);
  await wait(TRANSIT_MS);
  expect(log[log.length - 1]).toBe("close:trigger-hover");
});

test("a hoverable popup closes once the pointer leaves the safe zone, and a click makes it stay", async () => {
  const { hover, log, trigger } = rig({ hoverable: true, closeDelay: 0, group: 0 });
  const a = trigger();
  a.enter();
  await wait(60);
  hover.placed(placed(0, 30));
  a.leave();
  await wait(5);
  hover.track({ x: 50, y: 22 });
  hover.track({ x: 50, y: 28 });
  expect(hover.open()).toBe(true);
  hover.track({ x: 400, y: 28 });
  expect(log[log.length - 1]).toBe("close:trigger-hover");

  a.enter();
  await wait(60);
  hover.stick();
  a.leave();
  expect(hover.tracking()).toBe(false);
  await wait(TRANSIT_MS + 60);
  expect(hover.open()).toBe(true);
  a.enter();
  a.leave();
  expect(hover.open()).toBe(true);
  hover.press();
  expect(hover.open()).toBe(false);
});

test("a press on the popup itself does not close it, and the anchor moving does", async () => {
  const { hover, log, trigger } = rig({ hoverable: true, closeDelay: 300, group: 0 });
  const a = trigger();
  a.enter();
  await wait(60);
  a.leave();
  hover.popupEnter();
  hover.press();
  expect(hover.open()).toBe(true);
  hover.popupLeave();
  hover.moved();
  expect(log[log.length - 1]).toBe("close:anchor-moved");
  expect(hover.active()).toBe(null);
});

test("a dialog that opens after the popup covers it, so the popup closes; one that was already open does not", async () => {
  const { hover, log, trigger } = rig();
  const a = trigger();
  const shown = signal(false);
  trackDialog("hover-test", () => shown());
  a.enter();
  await wait(60);
  hover.sync();
  expect(hover.open()).toBe(true);
  shown.set(true);
  hover.sync();
  expect(log[log.length - 1]).toBe("close:imperative");
  // a popup opened above the dialog (its own root view) lives on
  a.leave();
  a.enter();
  await wait(60);
  hover.sync();
  expect(hover.open()).toBe(true);
  shown.set(false);
});
