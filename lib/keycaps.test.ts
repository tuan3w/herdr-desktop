import { expect, test } from "nsh/test";

import { capsWidth, isGlyphCap, keycaps } from "#lib/keycaps";

const table: [string, boolean, string[]][] = [
  ["N", true, ["N"]],
  ["⌘N", true, ["⌘", "N"]],
  ["⇧⌘P", true, ["⇧", "⌘", "P"]],
  ["⌃⇧⇥", true, ["⌃", "⇧", "⇥"]],
  ["⌘,", true, ["⌘", ","]],
  ["⌘↩", true, ["⌘", "↩"]],
  ["F1", true, ["F1"]],
  ["Ctrl+N", false, ["Ctrl", "N"]],
  ["Ctrl+Shift+P", false, ["Ctrl", "Shift", "P"]],
  ["Ctrl+,", false, ["Ctrl", ","]],
  ["Ctrl++", false, ["Ctrl", "+"]],
  ["Ctrl+Shift+Tab", false, ["Ctrl", "Shift", "Tab"]],
  ["F1", false, ["F1"]],
  ["↑↓", false, ["↑", "↓"]],
  ["→", false, ["→"]],
  ["Tab", false, ["Tab"]],
  ["Esc", true, ["Esc"]],
  ["1", false, ["1"]],
  ["r", true, ["R"]],
  ["mod+shift+p", true, ["⇧", "⌘", "P"]],
  ["mod+shift+p", false, ["Ctrl", "Shift", "P"]],
  ["mod+,", false, ["Ctrl", ","]],
  ["mod+enter", true, ["⌘", "↩"]],
  ["mod+up", false, ["Ctrl", "↑"]],
  ["ctrl+shift+tab", true, ["⌃", "⇧", "⇥"]],
  ["f12", false, ["F12"]],
  ["", true, []],
];

test("a shortcut splits into one cap per key, modifiers first", () => {
  for (const [keys, onApple, caps] of table) expect(keycaps(keys, onApple)).toEqual(caps);
});

test("a glyph cap is one character, a word cap is not", () => {
  expect(isGlyphCap("⌘")).toBe(true);
  expect(isGlyphCap("P")).toBe(true);
  expect(isGlyphCap("Ctrl")).toBe(false);
  expect(isGlyphCap("F1")).toBe(false);
});

test("a group's width is its caps and 4 pt between them", () => {
  expect(capsWidth(keycaps("⌘N", true))).toBe(44);
  expect(capsWidth(keycaps("Ctrl+N", false))).toBe(60);
});
