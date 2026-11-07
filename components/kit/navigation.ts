import type { Bounds, Point } from "nsh/types";
import { fold } from "#lib/text";
import { TRANSIT_MS } from "./hover";

/**
 * The rules menus and selects share (Base UI's `useListNavigation`, `useTypeahead`, hover intent and safe polygon),
 * pure and without a view: a list is described by arrays that line up with its rows (`skip[i]` is true for a row that
 * cannot take the highlight: a heading, a divider), and a key or a pointer gives a new index. A combobox may adopt them.
 * `-1` is "no row" everywhere.
 */

export type Dir = 1 | -1;

/** The first row (`1`) or the last (`-1`) that can take the highlight. */
export function edgeIndex(skip: readonly boolean[], dir: Dir): number {
  const count = skip.length;
  for (let k = 0; k < count; k++) {
    const i = dir > 0 ? k : count - 1 - k;
    if (!skip[i]) return i;
  }
  return -1;
}

/**
 * The row after `from` in direction `dir`. With nothing highlighted (`from` -1) it enters at the near end. At an end it
 * wraps round when `loop`, else stays where it is (Base UI's `loopFocus`).
 */
export function stepIndex(skip: readonly boolean[], from: number, dir: Dir, loop: boolean): number {
  const count = skip.length;
  if (from < 0 || from >= count) return edgeIndex(skip, dir);
  for (let k = 1; k <= count; k++) {
    const next = from + dir * k;
    if (next < 0 || next >= count) {
      if (!loop) return from;
      const wrapped = ((next % count) + count) % count;
      if (!skip[wrapped]) return wrapped;
      continue;
    }
    if (!skip[next]) return next;
  }
  return from;
}

/** Page Up and Page Down: `amount` rows on, never wrapping; lands on the nearest row that can take the highlight before `from`. */
export function pageIndex(skip: readonly boolean[], from: number, dir: Dir, amount: number): number {
  const count = skip.length;
  if (from < 0 || from >= count) return edgeIndex(skip, dir);
  let target = Math.min(count - 1, Math.max(0, from + dir * amount));
  while (target !== from && skip[target]) target -= dir;
  return target;
}

/** The keys that type a word to find (the plain letters and digits: Telex and VNI type with letters). */
export const TYPING_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** Letters typed this close together are one word to find (Base UI's `TYPEAHEAD_RESET_MS`). */
export const TYPING_RESET_MS = 750;

/** One typing session: what was typed, when, the row it started from and the last row it found. */
export interface Typing {
  text: string;
  at: number;
  origin: number;
  last: number;
}

/** Whether a session is running at `now`: then a space is part of the word, not a choice. */
export function isTyping(typing: Typing | undefined, now: number): boolean {
  return typing !== undefined && now - typing.at <= TYPING_RESET_MS;
}

/**
 * Typeahead as Base UI does it, with the clock passed in (no timer to cancel) and accents ignored. A session starts at the
 * row after `active`; each key narrows the word and the search starts again from the session's first row. One letter typed
 * again and again walks through the rows that start with it, unless some row starts with a doubled letter ("llama"). A key
 * that finds nothing ends the session, except a space. `folded` are the labels through `fold`.
 */
export function typeahead(
  typing: Typing | undefined,
  key: string,
  folded: readonly string[],
  skip: readonly boolean[],
  active: number,
  now: number,
): { typing: Typing | undefined; index: number } {
  const live = isTyping(typing, now) ? typing : undefined;
  const letter = fold(key);
  let text = live?.text ?? "";
  let origin = live ? live.origin : active;
  const last = live?.last ?? -1;
  if (text === letter && letter !== " " && folded.every((label, i) => skip[i] || label[0] !== label[1])) {
    text = "";
    origin = last;
  }
  text += letter;
  const count = folded.length;
  for (let k = 0; k < count; k++) {
    const i = (((origin + 1 + k) % count) + count) % count;
    if (!skip[i] && folded[i].startsWith(text)) return { typing: { text, at: now, origin, last: i }, index: i };
  }
  return { typing: letter === " " ? { text, at: now, origin, last } : undefined, index: -1 };
}

/** Where each row starts: `heights` summed, one more entry at the end for the content's height. */
export function offsetsOf(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  let sum = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = sum;
    sum += heights[i];
  }
  offsets[heights.length] = sum;
  return offsets;
}

/** The scroll offset that brings row `index` fully into a viewport of `height` scrolled to `scroll`; undefined when it already is. */
export function revealOffset(offsets: readonly number[], index: number, scroll: number, height: number): number | undefined {
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (top < scroll) return top;
  if (bottom > scroll + height) return bottom - height;
  return undefined;
}

/** The scroll offset that puts row `index` in the middle of the viewport as far as the content allows (a list opening on its value). */
export function centerOffset(offsets: readonly number[], index: number, height: number): number {
  const content = offsets[offsets.length - 1];
  const middle = (offsets[index] + offsets[index + 1]) / 2;
  return Math.max(0, Math.min(content - height, middle - height / 2));
}

/** A list laid over its trigger: where its viewport goes, how tall it is and how far its content is scrolled. */
export interface Alignment {
  top: number;
  height: number;
  scroll: number;
}

/**
 * The pop-up button look (Base UI's `alignItemWithTrigger`): the selected row's centre (`rowCenter`, from the content's
 * top) lands on `target` (the trigger's centre), with the viewport inside `area`. The list shows as much as `max` and the
 * area allow, scrolled as little as it must be; when the room under the trigger is short it is made shorter, as Base UI
 * does, rather than moved. Undefined when no placement keeps the row and a few rows around it in view (the trigger is
 * too near an edge of the area, as Base UI's 20pt collision threshold): the caller puts the list under the trigger.
 */
export function alignSelected(input: {
  target: number;
  rowCenter: number;
  rowHeight: number;
  content: number;
  max: number;
  area: { top: number; bottom: number };
}): Alignment | undefined {
  const { target, rowCenter, rowHeight, content, max, area } = input;
  const half = rowHeight / 2;
  const full = Math.min(content, max, area.bottom - area.top);
  // `at` is the row's centre inside the viewport; every limit below is one rule on it.
  const lowest = Math.max(target - (area.bottom - full), rowCenter - (content - full), half);
  const highest = Math.min(target - area.top, rowCenter, full - half);
  if (lowest <= highest) {
    const at = Math.min(highest, Math.max(lowest, Math.min(rowCenter, full / 2)));
    return { top: target - at, height: full, scroll: rowCenter - at };
  }
  const at = Math.min(target - area.top, rowCenter, Math.max(half, Math.min(rowCenter, full / 2)));
  if (at < half) return undefined;
  const top = target - at;
  const scroll = rowCenter - at;
  const height = Math.min(full, area.bottom - top, content - scroll);
  return height >= Math.min(content, rowHeight * 3) && height >= at + half ? { top, height, scroll } : undefined;
}

function side(p: Point, a: Point, b: Point): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/**
 * Whether the pointer at `at` is on its way from `apex` (where it last was on a submenu's row) to the submenu at
 * `menu`: inside the triangle from `apex` to the submenu's near edge, or over the submenu. While it is, the rows it
 * crosses on the way must not take the highlight or close the submenu (Base UI's `safePolygon`).
 */
export function inTransit(apex: Point, menu: Bounds, at: Point): boolean {
  const { x, y } = menu.origin;
  const { width, height } = menu.size;
  if (at.x >= x && at.x <= x + width && at.y >= y && at.y <= y + height) return true;
  const edge = x >= apex.x ? x : x + width;
  const top = { x: edge, y };
  const bottom = { x: edge, y: y + height };
  const d1 = side(at, apex, top);
  const d2 = side(at, top, bottom);
  const d3 = side(at, bottom, apex);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Timers, so a test can run the clock by hand. */
export interface Scheduler {
  set: (run: () => void, ms: number) => number;
  clear: (id: number | undefined) => void;
}

const REAL: Scheduler = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id) };

/**
 * When hovering opens and closes one popup (Base UI's `openOnHover` with `delay` and `closeDelay`). The pointer must stay
 * on the trigger for `delay` before it opens (a timer from the hover event: no per-frame handler). It closes `closeDelay`
 * after the pointer left the trigger and the popup both, and waits `TRANSIT_MS` instead when it left on its way to the
 * popup (`inTransit`); touching the popup, or the trigger again, cancels the close.
 */
export function createHoverIntent(options: {
  delay: number;
  closeDelay: number;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  schedule?: Scheduler;
}) {
  const clock = options.schedule ?? REAL;
  let timer: number | undefined;
  let overTrigger = false;
  let overPopup = false;
  const cancel = () => {
    clock.clear(timer);
    timer = undefined;
  };
  const closeAfter = (ms: number) => {
    cancel();
    if (!options.isOpen()) return;
    if (ms <= 0) options.close();
    else timer = clock.set(options.close, ms);
  };
  return {
    enterTrigger() {
      overTrigger = true;
      cancel();
      if (options.isOpen()) return;
      if (options.delay <= 0) options.open();
      else timer = clock.set(options.open, options.delay);
    },
    leaveTrigger(towardPopup: boolean) {
      overTrigger = false;
      if (overPopup) return;
      closeAfter(towardPopup ? Math.max(options.closeDelay, TRANSIT_MS) : options.closeDelay);
    },
    enterPopup() {
      overPopup = true;
      cancel();
    },
    leavePopup() {
      overPopup = false;
      if (!overTrigger) closeAfter(options.closeDelay);
    },
    /** The popup closed by another way, or its owner is gone. */
    cancel() {
      cancel();
      overTrigger = false;
      overPopup = false;
    },
  };
}
