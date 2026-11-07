import { keymap } from "nsh";
import { expect, test } from "nsh/test";

import { GLOBAL, keysOf, LOCAL, SHORTCUTS } from "#lib/shortcuts";

/** The two key families: Apple platforms take Command for `mod`, every other Ctrl. */
const FAMILIES = [true, false] as const;
const every = (f: (keys: string, onApple: boolean) => void) => {
  for (const onApple of FAMILIES) for (const s of SHORTCUTS) for (const k of keysOf(s, onApple)) f(k, onApple);
};

test("every key is a keystroke nsh accepts, so binding them cannot throw at startup", () => {
  every((k) => expect(keymap.label(k).length).toBeGreaterThan(0));
});

test("a global shortcut cannot steal typing: it carries mod, is a function key, or is ctrl+tab", () => {
  for (const onApple of FAMILIES) {
    for (const s of Object.values(GLOBAL))
      for (const k of keysOf(s, onApple)) expect(/^mod\+|^f\d+$|^ctrl\+(shift\+)?tab$/.test(k)).toBe(true);
  }
});

test("no shortcut uses alt: it types characters on a Mac (Option) and on many Windows layouts (AltGr)", () => {
  every((k) => expect(k.split("+").includes("alt")).toBe(false));
});

test("two shortcuts never share a key on one platform", () => {
  for (const onApple of FAMILIES) {
    const keys = SHORTCUTS.flatMap((s) => keysOf(s, onApple));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  }
});

test("a platform's own keys replace the shared ones, and F1 is Help only where it is the habit", () => {
  expect(keysOf(GLOBAL.shortcuts, true)).toEqual(["mod+/"]);
  expect(keysOf(GLOBAL.shortcuts, false)).toEqual(["f1", "mod+/"]);
  expect(keysOf(GLOBAL.newAgent, true)).toEqual(keysOf(GLOBAL.newAgent, false));
});

test("the local keys are the ones controls take natively, so none is bound twice", () => {
  const global = new Set(Object.values(GLOBAL).flatMap((s) => s.keys));
  for (const s of LOCAL) for (const k of s.keys) expect(global.has(k)).toBe(false);
});

test("nsh keeps Quit and Full screen: no shortcut binds them", () => {
  every((k) => expect(["mod+q", "f11"].includes(k)).toBe(false));
});

test("Escape belongs to the agent: it is never a global shortcut, so a program in a terminal can have it", () => {
  for (const s of Object.values(GLOBAL))
    for (const onApple of FAMILIES) expect(keysOf(s, onApple).some((k) => k.split("+").includes("escape"))).toBe(false);
});

test("the nine tab shortcuts are mod+shift+digit, so no digit alone or mod+digit is taken from the screens", () => {
  for (let n = 1; n <= 9; n++) expect(GLOBAL[`tab${n}` as keyof typeof GLOBAL].keys).toEqual([`mod+shift+${n}`]);
});

test("ctrl+tab is spelled with ctrl, never mod: on Apple platforms cmd+tab belongs to the system", () => {
  expect(GLOBAL.previousAgent.keys).toEqual(["ctrl+tab"]);
  expect(GLOBAL.previousProject.keys).toEqual(["ctrl+shift+tab"]);
  // The keymap counts Tab among the keys a text field uses, so only `always` fires it in a message box.
  expect(GLOBAL.previousAgent.always).toBe(true);
  expect(GLOBAL.previousProject.always).toBe(true);
});
