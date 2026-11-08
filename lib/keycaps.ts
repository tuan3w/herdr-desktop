import { apple } from "#lib/shortcuts";

const APPLE_MODS = "⌃⌥⇧⌘";
const ARROWS = "↑↓←→";

const NAMED: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  escape: "Esc",
  esc: "Esc",
  space: "Space",
};

/** Keys Apple draws as a glyph and other platforms spell, as keymap.label does. */
const APPLE_NAMED: Record<string, string> = { enter: "↩", return: "↩", tab: "⇥", backspace: "⌫", delete: "⌦" };

/** A modifier word of a raw keystroke (`mod+shift+p`) as this platform draws it; `undefined` when the word is a key. */
function modifier(word: string, onApple: boolean): string | undefined {
  switch (word) {
    case "mod":
      return onApple ? "⌘" : "Ctrl";
    case "meta":
    case "cmd":
    case "super":
      return onApple ? "⌘" : "Meta";
    case "ctrl":
    case "control":
      return onApple ? "⌃" : "Ctrl";
    case "shift":
      return onApple ? "⇧" : "Shift";
    case "alt":
    case "option":
      return onApple ? "⌥" : "Alt";
    default:
      return undefined;
  }
}

/** One key as it is drawn: a letter in capitals, a named key as its glyph or word, anything else as it is. */
function keyCap(key: string, onApple: boolean): string {
  const lower = key.toLowerCase();
  const named = NAMED[lower] ?? (onApple ? APPLE_NAMED[lower] : undefined);
  if (named) return named;
  return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

/**
 * A shortcut split into one cap per key, as Linear and macOS menus draw it (`⌘⇧P` becomes `⌘`, `⇧`, `P`; `Ctrl+Shift+P`
 * becomes `Ctrl`, `Shift`, `P`). Takes what `keyText` writes, or a raw keystroke (`mod+shift+p`), which is drawn for
 * `onApple`. Plain text such as `Tab` or a letter is one cap; a run of arrows is one cap each.
 */
export function keycaps(keys: string, onApple: boolean = apple()): string[] {
  const text = keys.trim();
  if (text.length === 0) return [];
  if (text.length > 1 && text.includes("+")) {
    // "Ctrl++" is Ctrl and the plus key: a trailing "+" is the key, not a separator.
    const plus = text.endsWith("+");
    const words = (plus ? text.slice(0, -2) : text).split("+").filter((w) => w.length > 0);
    const mods: string[] = [];
    const rest: string[] = [];
    for (const word of words) {
      const mod = modifier(word.toLowerCase(), onApple);
      if (mod) mods.push(mod);
      else rest.push(keyCap(word, onApple));
    }
    // macOS writes modifiers in a fixed order, whatever order the keystroke was declared in.
    if (onApple) mods.sort((a, b) => APPLE_MODS.indexOf(a) - APPLE_MODS.indexOf(b));
    return [...mods, ...rest, ...(plus ? ["+"] : [])];
  }
  const chars = [...text];
  const caps: string[] = [];
  let i = 0;
  while (i < chars.length - 1 && APPLE_MODS.includes(chars[i])) caps.push(chars[i++]);
  const rest = chars.slice(i);
  if (rest.length > 1 && rest.every((c) => ARROWS.includes(c))) return [...caps, ...rest];
  if (rest.length > 0) caps.push(keyCap(rest.join(""), onApple));
  return caps;
}

/** Whether a cap is one glyph (drawn exactly square) rather than a word (drawn as wide as its text needs). */
export const isGlyphCap = (cap: string): boolean => [...cap].length === 1;

/** A cap's width in points: a glyph is exactly 20 square, a word is its text (about 7 pt a character, estimated) and 8 pt of padding, at least 20. */
export const capWidth = (cap: string): number => (isGlyphCap(cap) ? 20 : Math.max(20, [...cap].length * 7 + 8));

/** The width of a group of caps with 4 pt between them: what a menu counts before it builds its rows. */
export const capsWidth = (caps: readonly string[]): number =>
  caps.reduce((w, cap) => w + capWidth(cap), 0) + Math.max(0, caps.length - 1) * 4;
