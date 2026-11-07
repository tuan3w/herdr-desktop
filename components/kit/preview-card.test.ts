import { expect, test } from "nsh/test";
import type { ViewRef } from "nsh/types";
import { CARD_CLOSE_MS, CARD_DELAY_MS, type CardTrigger, createCards } from "./preview-card";

let ids = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function trigger(): CardTrigger {
  return {
    node: { id: ++ids, measure: async () => null } as unknown as ViewRef,
    card: () => null as never,
    label: () => undefined,
    side: () => undefined,
    align: () => undefined,
    disabled: () => false,
  };
}

test("a card opens after 600ms and closes 300ms after the pointer left, as Base UI's", () => {
  expect(CARD_DELAY_MS).toBe(600);
  expect(CARD_CLOSE_MS).toBe(300);
});

test("the card stays while the pointer is over it and goes after it left, and every trigger waits its own turn", async () => {
  const cards = createCards({ delay: 20, closeDelay: 40 });
  const a = cards.register(trigger());
  const b = cards.register(trigger());
  a.enter();
  await wait(50);
  expect(cards.open()).toBe(true);
  a.leave();
  cards.popupEnter();
  await wait(400);
  expect(cards.open()).toBe(true);
  cards.popupLeave();
  await wait(400);
  expect(cards.open()).toBe(false);

  // no group: a second trigger does not skip the delay
  b.enter();
  expect(cards.open()).toBe(false);
  b.leave();
});

test("a keyboard focus opens the card after the delay and a press closes it", async () => {
  const cards = createCards({ delay: 20, closeDelay: 40 });
  const a = cards.register(trigger());
  a.focus();
  expect(cards.open()).toBe(false);
  await wait(50);
  expect(cards.open()).toBe(true);
  expect(cards.reason()).toBe("trigger-focus");
  cards.press();
  expect(cards.open()).toBe(false);
});
