import { expect, test } from "nsh/test";

import { largeTargets } from "#lib/settings";

import { btnClass, type Variant } from "./button";

const classes = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

test("a disabled button is its own variant faded, never a grey fill that turns a ghost or danger into another kind", () => {
  const before = largeTargets();
  largeTargets.set(false);
  const variants: Variant[] = ["primary", "outline", "ghost", "danger"];
  for (const v of variants) {
    const off = classes(btnClass(v, { disabled: true }));
    const on = classes(btnClass(v, {}));
    expect(`${v} ${off.has("opacity-50")}`).toBe(`${v} true`);
    // The bug: every disabled button was `bg-muted`, so a ghost Cancel became a filled grey button.
    expect(`${v} ${off.has("bg-muted")}`).toBe(`${v} false`);
    // Its fill and edge are the enabled ones', without hover or press.
    for (const c of on)
      if (!c.includes(":") && (c.startsWith("bg-") || c.startsWith("border"))) expect(off.has(c)).toBe(true);
    expect([...off].some((c) => c.startsWith("hover:") || c.startsWith("active:"))).toBe(false);
  }
  largeTargets.set(before);
});

test("a button never grows past a narrow container: it may shrink, and every size is a min-height on the ladder", () => {
  const before = largeTargets();
  largeTargets.set(false);
  expect(classes(btnClass("outline", {})).has("max-w-full")).toBe(true);
  expect(classes(btnClass("outline", {})).has("min-h-8")).toBe(true);
  expect(classes(btnClass("outline", { small: true })).has("min-h-7")).toBe(true);
  largeTargets.set(true);
  expect(classes(btnClass("outline", { small: true })).has("min-h-11")).toBe(true);
  largeTargets.set(before);
});
