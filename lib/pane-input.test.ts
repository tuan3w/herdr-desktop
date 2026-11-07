import { PaneKeys } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import { captureKeystrokes, matchRows } from "#lib/pane-input";
import { capturedBy, GLOBAL, keysOf } from "#lib/shortcuts";

/** Which keys capture mode takes for the pane and which it leaves to the app. */
test("on Windows and Linux every plain Ctrl letter is the pane's while typing into it, and only what a terminal cannot send stays the app's", () => {
  const keys = captureKeystrokes(false);
  // The palette, new agent, next attention, find, close tab, sidebar, undo and the switcher are Ctrl+K, N, J, F, W, B, Z, E
  // outside the mode: inside it a terminal's own Ctrl+K (kill to the end), N, J, F, W, B, E, P all reach the pane.
  for (const letter of ["k", "n", "j", "f", "w", "b", "z", "e", "p", "c", "d", "a", "r", "l", "u"])
    expect(keys).toContain(`ctrl+${letter}`);
  // Paste stays paste: the pasted text goes as text.
  expect(keys).not.toContain("ctrl+v");
  // Ctrl+[ is Escape's byte, and the other three punctuation keys have a control byte too.
  for (const key of ["ctrl+[", "ctrl+]", "ctrl+\\", "ctrl+/"]) expect(keys).toContain(key);
});

test("on Apple platforms every Ctrl+letter is the pane's, because the app's keys are on Command", () => {
  const keys = captureKeystrokes(true);
  for (const letter of ["k", "j", "n", "f", "w", "v", "z"]) expect(keys).toContain(`ctrl+${letter}`);
  expect(keys).toContain("ctrl+[");
});

test("Escape, Tab, the arrows and the editing keys are the pane's, and every key bound has a name in herdr", () => {
  for (const onApple of [false, true]) {
    const keys = captureKeystrokes(onApple);
    for (const key of [
      "escape",
      "enter",
      "tab",
      "shift+tab",
      "backspace",
      "delete",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
    ]) {
      expect(keys).toContain(key);
    }
    for (const key of keys) expect(PaneKeys.herdrKey(key)).not.toBeNull();
  }
});

test("no key the app keeps while typing into a pane is taken from it, on any platform", () => {
  for (const onApple of [false, true]) {
    const keys = captureKeystrokes(onApple);
    for (const shortcut of Object.values(GLOBAL)) {
      for (const stroke of keysOf(shortcut, onApple)) {
        if (capturedBy(stroke, onApple) === "pane") continue;
        // `mod` is Ctrl on the other platforms, so a clash is the same chord spelled with Ctrl.
        expect(keys).not.toContain(onApple ? stroke : stroke.replace(/^mod\b/, "ctrl"));
      }
    }
  }
});

test("find: rows match ignoring case, diacritics and invisible characters, and an empty query matches nothing", () => {
  const rows = ["Building…", "Crème brûlée", "wor\u200bk done", "", "build again"];
  expect(matchRows(rows, "build")).toEqual([0, 4]);
  expect(matchRows(rows, "CREME")).toEqual([1]);
  expect(matchRows(rows, "work")).toEqual([2]);
  expect(matchRows(rows, "  ")).toEqual([]);
  expect(matchRows(rows, "zzz")).toEqual([]);
});
