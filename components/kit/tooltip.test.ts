import { expect, test } from "nsh/test";

import type { ViewRef } from "nsh/types";

import { createTooltips, GROUP_MS, REST_MS } from "./tooltip";

import type { TipTrigger } from "./tooltip";

let ids = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = () => null as never;

function trigger(over: Partial<TipTrigger> = {}): TipTrigger {
  return {
    node: { id: ++ids } as unknown as ViewRef,
    say,
    disabled: () => false,
    ...over,
  };
}

test("the defaults: a bubble waits half a second and the next one is warm for 400ms", () => {
  expect(REST_MS).toBe(500);
  expect(GROUP_MS).toBe(400);
});

test("the root's timing sets the delay, and the group lasts its timeout", async () => {
  const tips = createTooltips({ delay: 40, timeout: 100 });
  const a = tips.register(trigger());
  const b = tips.register(trigger());
  a.enter();
  await wait(20);
  expect(tips.open()).toBe(false);
  await wait(50);
  expect(tips.open()).toBe(true);
  a.leave();
  expect(tips.open()).toBe(false);
  b.enter();
  expect(tips.open()).toBe(true);
  b.leave();
  await wait(150);
  b.enter();
  expect(tips.open()).toBe(false);
  b.leave();
});

test("the root's closeDelay keeps a bubble after the pointer left, and re-entering cancels it", async () => {
  const tips = createTooltips({ delay: 10, closeDelay: 60 });
  const a = tips.register(trigger());
  a.enter();
  await wait(40);
  a.leave();
  expect(tips.open()).toBe(true);
  a.enter();
  await wait(90);
  expect(tips.open()).toBe(true);
  a.leave();
  await wait(90);
  expect(tips.open()).toBe(false);
});

test("every change says why, and the owner can veto it", async () => {
  const seen: string[] = [];
  let veto = false;
  const tips = createTooltips({
    delay: 5,
    onOpenChange(open, change) {
      seen.push(`${open}:${change.reason}`);
      if (veto) change.cancel();
    },
  });
  const a = tips.register(trigger());
  a.enter();
  await wait(30);
  tips.escape();
  expect(seen).toEqual(["true:trigger-hover", "false:escape-key"]);
  veto = true;
  a.leave();
  a.enter();
  await wait(30);
  expect(tips.open()).toBe(false);
  expect(tips.active()).toBe(null);
});

test("a text that fits has no bubble, and one that stops being cut closes its bubble", async () => {
  const tips = createTooltips({ delay: 5 });
  let cut = false;
  const a = tips.register(trigger({ disabled: () => !cut }));
  a.enter();
  await wait(30);
  expect(tips.open()).toBe(false);
  cut = true;
  a.leave();
  a.enter();
  await wait(30);
  expect(tips.open()).toBe(true);
  cut = false;
  tips.sync();
  expect(tips.open()).toBe(false);
});
