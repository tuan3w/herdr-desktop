import { signal } from "nsh";
import { expect, test } from "nsh/test";

import { createOpenState, type OpenReason } from "./popup";

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
