import { expect, test } from "nsh/test";

import { largeTargets } from "#lib/settings";

import { spoken } from "./check";
import { INPUT_CLASS, inputHeight, inputLook } from "./fields";

test("a text input is as tall as the other controls under Large hit targets", () => {
  const before = largeTargets();
  largeTargets.set(false);
  expect(inputHeight()).toBe("min-h-8");
  expect(inputHeight(true)).toBe("min-h-7");
  largeTargets.set(true);
  expect(inputHeight()).toBe("min-h-11");
  expect(inputHeight(true)).toBe("min-h-11");
  largeTargets.set(before);
});

test("a required or read-only field says so, then what its field says", () => {
  expect(spoken({ required: true }, undefined)).toBe("required");
  expect(spoken({ required: true, readOnly: true }, "Enter a value.")).toBe("required, read only. Enter a value.");
  expect(spoken({}, undefined)).toBe(undefined);
});

const has = (look: string, cls: string) => look.split(/\s+/).includes(cls);

test("each state of a text input looks like itself: disabled fades, read-only is recessed and still, invalid stays red", () => {
  const before = largeTargets();
  largeTargets.set(false);
  const cases: [state: Parameters<typeof inputLook>[0], present: string[], absent: string[]][] = [
    [
      {},
      ["bg-card", "border-input", "hover:border-muted-foreground/50", "min-h-8"],
      ["opacity-50", "border-destructive"],
    ],
    // The bug: a disabled field drew exactly like an enabled one; only its label faded.
    [{ disabled: true }, ["opacity-50", "border-input"], ["hover:border-muted-foreground/50"]],
    [{ readOnly: true }, ["bg-muted/50"], ["bg-card", "hover:border-muted-foreground/50"]],
    [{ invalid: true }, ["border-destructive", "focus:outline-destructive"], ["border-input", "focus:border-ring"]],
    [{ invalid: true, disabled: true }, ["border-destructive", "opacity-50"], ["border-input"]],
    [{ small: true }, ["min-h-7"], ["min-h-8"]],
    [{ height: "h-24 py-2" }, ["h-24"], ["min-h-8"]],
  ];
  for (const [state, present, absent] of cases) {
    const look = inputLook(state);
    for (const c of present)
      expect(`${JSON.stringify(state)} ${c} ${has(look, c)}`).toBe(`${JSON.stringify(state)} ${c} true`);
    for (const c of absent)
      expect(`${JSON.stringify(state)} ${c} ${has(look, c)}`).toBe(`${JSON.stringify(state)} ${c} false`);
  }
  largeTargets.set(before);
  // A bare input placed by a screen keeps its fixed 32.
  expect(has(INPUT_CLASS, "h-8")).toBe(true);
});
