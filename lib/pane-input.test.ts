import { expect, test } from "nsh/test";
import { PaneKeys } from "herdr-desktop/native";
import { captureKeystrokes, matchRows } from "./pane-input";
import { GLOBAL, keysOf } from "./shortcuts";

/** Which keys capture mode takes for the pane and which it leaves to the app. */
test("on Windows and Linux Ctrl is the app's key, so the app's shortcuts stay the app's and the rest of Ctrl is the pane's", () => {
  const keys = captureKeystrokes(false);
  // The palette, next attention, new agent, find, close tab, sidebar and undo are Ctrl+K, J, N, F, W, B, Z there.
  for (const letter of ["k", "j", "n", "f", "w", "b", "z"]) expect(keys).not.toContain(`ctrl+${letter}`);
  // Paste stays paste, and the app's own `capture` key is not forwarded.
  expect(keys).not.toContain("ctrl+v");
  for (const taken of ["ctrl+c", "ctrl+d", "ctrl+a", "ctrl+e", "ctrl+r", "ctrl+l", "ctrl+u"]) expect(keys).toContain(taken);
});

test("on Apple platforms every Ctrl+letter is the pane's, because the app's keys are on Command", () => {
  const keys = captureKeystrokes(true);
  for (const letter of ["k", "j", "n", "f", "w", "v", "z"]) expect(keys).toContain(`ctrl+${letter}`);
});

test("Escape, Tab, the arrows and the editing keys are the pane's, and every key bound has a name in herdr", () => {
  for (const onApple of [false, true]) {
    const keys = captureKeystrokes(onApple);
    for (const key of ["escape", "enter", "tab", "shift+tab", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]) {
      expect(keys).toContain(key);
    }
    for (const key of keys) expect(PaneKeys.herdrKey(key)).not.toBeNull();
  }
});

test("no key the app binds globally is taken from it, on any platform", () => {
  for (const onApple of [false, true]) {
    const keys = captureKeystrokes(onApple);
    for (const shortcut of Object.values(GLOBAL)) {
      for (const stroke of keysOf(shortcut, onApple)) {
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
