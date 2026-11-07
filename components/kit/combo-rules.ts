import { fold } from "#lib/text";

/**
 * The rules under `Combobox` and `Autocomplete`, with no UI and no signals so each is a function of its arguments:
 * what matches and in which order (a filter that can be cut into time slices, and narrowed from an earlier answer),
 * how the rows and their groups lay out, where the highlight goes, what the input says when, and how a multiple
 * selection changes. `combo.tsx` drives them; `combo.test.ts` pins them.
 */

/** One option of a list, as both components hand it over. `Option` (fields.tsx) and `Suggestion` are mapped onto it. */
export interface Choice {
  value: string;
  title: string;
  /** Secondary text, shown muted after the title and searched. */
  hint?: string;
  /** Options of one group sit under one heading; options without a group come first, without one. */
  group?: string;
  /** Skipped by the arrow keys and not pickable. */
  disabled?: boolean;
  /** Searched, never shown (an agent's alias, a machine's host name). */
  keywords?: string;
}

const ASCII = /^[\x00-\x7f]*$/;

/** `fold` (case and accents ignored), skipping the Unicode pass for text that has no accents: most refs and codes. */
export function foldFast(s: string): string {
  return ASCII.test(s) ? s.toLowerCase() : fold(s);
}

/** What a scan reads of an option: the folded text it searches, and the folded title that a "starts with" is asked of. */
export interface Entry {
  text: string;
  lead: string;
}

const entries = new WeakMap<Choice, Entry>();

/**
 * The folded text of an option, built the first time it is scanned and kept with the option object. Folding 50,000
 * options costs about 100 ms; it must not be paid per keystroke, nor for options nobody has typed near.
 */
export function entryOf(c: Choice): Entry {
  let e = entries.get(c);
  if (e === undefined) {
    const lead = foldFast(c.title);
    e = { text: c.hint || c.keywords ? foldFast(`${c.title} ${c.hint ?? ""} ${c.keywords ?? ""}`) : lead, lead };
    entries.set(c, e);
  }
  return e;
}

/** The words of a query, folded: an option matches when every one of them is in its text. */
export function queryWords(query: string): string[] {
  return foldFast(query).split(/\s+/).filter(Boolean);
}

/** A query's identity for caching: its words, which is what matching depends on. */
export const queryKey = (words: readonly string[]): string => words.join(" ");

/** 0: no match, 1: a match, 2: a match whose title starts with the first word (those lead the list). */
export type Probe = (index: number) => 0 | 1 | 2;

/** The default match: every word in the text of option `index`; a title that starts with the first word leads. */
export function wordProbe(words: readonly string[], choiceAt: (index: number) => Choice): Probe {
  const first = words[0];
  const n = words.length;
  return (index) => {
    const e = entryOf(choiceAt(index));
    for (let w = 0; w < n; w++) if (!e.text.includes(words[w])) return 0;
    return e.lead.startsWith(first) ? 2 : 1;
  };
}

/** A scan in progress: `cursor` candidates are done; `matched` and `lead` (a subset of it) are in ascending order. */
export interface Job {
  probe: Probe;
  /** The indices to test, or `undefined` for options `0..size-1`. */
  source: readonly number[] | undefined;
  size: number;
  cursor: number;
  matched: number[];
  lead: number[];
}

/** Starts a scan of `total` options, or of `source` (an earlier answer that holds every match of this query). */
export function startJob(total: number, probe: Probe, source?: readonly number[]): Job {
  return { probe, source, size: source ? source.length : total, cursor: 0, matched: [], lead: [] };
}

/**
 * Runs the scan for about `budgetMs`, in steps of 64 candidates (at least one step, so it always advances), and says
 * whether it finished. The host kills a call that runs over 2,000 ms and a frame is 8 ms: 50,000 options are scanned
 * in many short calls, each leaving the UI thread free.
 */
export function stepJob(job: Job, budgetMs: number, now: () => number = () => performance.now()): boolean {
  const started = now();
  const { probe, source, size, matched, lead } = job;
  let i = job.cursor;
  while (i < size) {
    const stop = Math.min(size, i + 64);
    for (; i < stop; i++) {
      const index = source ? source[i] : i;
      const hit = probe(index);
      if (hit !== 0) {
        matched.push(index);
        if (hit === 2) lead.push(index);
      }
    }
    if (i < size && now() - started >= budgetMs) break;
  }
  job.cursor = i;
  return i >= size;
}

/** The matches with the ones that lead first, each group in the options' own order. */
export function ranked(matched: readonly number[], lead: readonly number[]): number[] {
  if (lead.length === 0 || lead.length === matched.length) return matched as number[];
  const out: number[] = lead.slice();
  let l = 0;
  for (let m = 0; m < matched.length; m++) {
    const index = matched[m];
    if (l < lead.length && lead[l] === index) l++;
    else out.push(index);
  }
  return out;
}

/** What a finished scan found: `matched` ascending (the source of a narrower query), `order` as the list shows it. */
export interface Found {
  key: string;
  matched: number[];
  order: number[];
}

export function found(key: string, job: Job): Found {
  return { key, matched: job.matched, order: ranked(job.matched, job.lead) };
}

/**
 * Answers kept while the user types, so that a longer query scans only what the shorter one matched and Backspace
 * scans nothing. A query whose words extend an earlier query's (`ha` -> `hai` -> `hai ph`) can only match what that
 * earlier one matched: every word of the earlier query is inside a word of the later one.
 */
export function createRefiner(maxDepth = 12) {
  const stack: Found[] = [];
  return {
    /** The answer for `key` itself, or the matches of the nearest shorter query that it extends. */
    lookup(key: string): { exact: Found | undefined; source: number[] | undefined } {
      while (stack.length > 0 && !key.startsWith(stack[stack.length - 1].key)) stack.pop();
      const top = stack[stack.length - 1];
      if (top === undefined) return { exact: undefined, source: undefined };
      return top.key === key ? { exact: top, source: undefined } : { exact: undefined, source: top.matched };
    },
    keep(answer: Found) {
      if (stack.length >= maxDepth) stack.shift();
      stack.push(answer);
    },
    reset() {
      stack.length = 0;
    },
  };
}

/** Option rows and group headings, in points: fixed, so a row's place is arithmetic and nothing is measured. */
export const ROW_H = 36;
export const HEAD_H = 32;

/** The group of each option (index into `names`); `names[g]` is empty for options without one. */
export interface Groups {
  of: readonly number[];
  names: readonly string[];
}

/** Groups by first appearance; `undefined` when no option has a group (the common case: nothing to build). */
export function groupChoices(choices: readonly Choice[]): Groups | undefined {
  let any = false;
  for (let i = 0; i < choices.length && !any; i++) any = !!choices[i].group;
  if (!any) return undefined;
  const ids = new Map<string, number>();
  const names: string[] = [];
  const of: number[] = Array.from({ length: choices.length }, () => 0);
  for (let i = 0; i < choices.length; i++) {
    const name = choices[i].group ?? "";
    let g = ids.get(name);
    if (g === undefined) {
      g = names.length;
      ids.set(name, g);
      names.push(name);
    }
    of[i] = g;
  }
  return { of, names };
}

let identity: number[] = [];

/** `0..n-1`, shared: a list of every option is not rebuilt per open. Never mutate it. */
export function ids(n: number): number[] {
  for (let i = identity.length; i < n; i++) identity.push(i);
  return identity.length === n ? identity : identity.slice(0, n);
}

/**
 * What the list draws. `order` is the options in the order the keys walk them (grouped options are gathered under
 * their heading); `rows` are what `List` is given: a position in `order`, or `-(group + 1)` for a heading.
 */
export interface Layout {
  order: readonly number[];
  rows: readonly number[];
  names: readonly string[];
  /** Row of each position, or `undefined` when they are the same (no groups). */
  rowOfPos: readonly number[] | undefined;
  /** Top of each row, plus the end; `undefined` when every row is `ROW_H`. */
  tops: readonly number[] | undefined;
  /** Matches left out by `limit`. */
  hidden: number;
}

/** `order` (ranked matches) cut to `limit` (negative: none), gathered into groups when there are any. */
export function layout(order: readonly number[], groups: Groups | undefined, limit: number): Layout {
  const hidden = limit >= 0 && order.length > limit ? order.length - limit : 0;
  const taken = hidden > 0 ? order.slice(0, limit) : order;
  if (groups === undefined)
    return { order: taken, rows: ids(taken.length), names: [], rowOfPos: undefined, tops: undefined, hidden };
  const buckets: number[][] = groups.names.map(() => []);
  for (let p = 0; p < taken.length; p++) buckets[groups.of[taken[p]]].push(taken[p]);
  const out: number[] = [];
  const rows: number[] = [];
  const rowOfPos: number[] = [];
  const tops: number[] = [];
  let top = 0;
  for (let g = 0; g < buckets.length; g++) {
    const bucket = buckets[g];
    if (bucket.length === 0) continue;
    if (groups.names[g] !== "") {
      rows.push(-(g + 1));
      tops.push(top);
      top += HEAD_H;
    }
    for (let k = 0; k < bucket.length; k++) {
      rowOfPos.push(rows.length);
      rows.push(out.length);
      out.push(bucket[k]);
      tops.push(top);
      top += ROW_H;
    }
  }
  tops.push(top);
  return { order: out, rows, names: groups.names, rowOfPos, tops, hidden };
}

export const rowTop = (l: Layout, row: number): number => (l.tops ? l.tops[row] : row * ROW_H);
export const rowHeight = (l: Layout, row: number): number => (l.tops ? l.tops[row + 1] - l.tops[row] : ROW_H);
export const contentHeight = (l: Layout): number => (l.tops ? l.tops[l.rows.length] : l.rows.length * ROW_H);
export const rowOf = (l: Layout, pos: number): number => (l.rowOfPos ? l.rowOfPos[pos] : pos);

/**
 * Where to scroll so that position `pos` is fully in view, or `undefined` when it already is. The first option of a
 * group brings its heading along; scrolling is the least that does it (up: its top at the top, down: its bottom at the
 * bottom), as `scrollIntoView({ block: "nearest" })` does.
 */
export function revealOffset(l: Layout, pos: number, scrollTop: number, viewport: number): number | undefined {
  const row = rowOf(l, pos);
  let top = rowTop(l, row);
  const bottom = top + rowHeight(l, row);
  if (row > 0 && l.rows[row - 1] < 0) top = rowTop(l, row - 1);
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return Math.max(0, bottom - viewport);
  return undefined;
}

/** The first position the keys may land on, or -1. */
export function firstEnabled(count: number, disabled?: (pos: number) => boolean): number {
  for (let p = 0; p < count; p++) if (!disabled?.(p)) return p;
  return -1;
}

/**
 * One Up or Down step from `current` (-1: nothing highlighted), as Base UI's `getNextListIndex`: disabled positions are
 * skipped; with `loop` the step past an end wraps to the other end, except with `escape` (the input is the place
 * between the ends): the first step past an end highlights nothing, the next enters at the far end. Without `loop` the
 * highlight stops at the ends. Returns -1 for "nothing".
 */
export function nextHighlight(
  count: number,
  current: number,
  dir: 1 | -1,
  o: { loop: boolean; escape: boolean; disabled?: (pos: number) => boolean },
): number {
  if (count === 0) return -1;
  const off = (p: number) => o.disabled?.(p) === true;
  const find = (from: number, d: 1 | -1) => {
    let i = from;
    do i += d;
    while (i >= 0 && i < count && off(i));
    return i;
  };
  const min = find(-1, 1);
  const max = find(count, -1);
  if (min >= count) return -1;
  let index: number;
  if (!o.loop) index = dir < 0 ? Math.max(min, find(current, -1)) : Math.min(max, find(current, 1));
  else if (dir < 0 ? current <= min : current >= max) {
    const outside = dir < 0 ? -1 : count;
    index = o.escape && current !== outside ? -1 : dir < 0 ? max : min;
  } else index = find(current, dir);
  return index < 0 || index >= count ? -1 : index;
}

/** PageUp and PageDown: `page` positions on, stopping at the ends, on the nearest position the keys may land on. */
export function pageHighlight(
  count: number,
  current: number,
  dir: 1 | -1,
  page: number,
  disabled?: (pos: number) => boolean,
): number {
  if (count === 0) return -1;
  const from = current >= 0 ? current : dir > 0 ? -1 : count;
  const target = Math.max(0, Math.min(count - 1, from + dir * page));
  for (let d = 0; d < count; d++) {
    for (const p of [target + d * dir, target - d * dir]) {
      if (p >= 0 && p < count && !disabled?.(p)) return p;
    }
  }
  return -1;
}

export type AutoHighlight = false | "input-change" | "always";

/**
 * Where the highlight starts: on the chosen option when the list opens without a query (the first chosen one, in the
 * order shown, for a multiple choice); else, after typing, on the first option when `auto` is on; else on the first
 * only when `auto` is `"always"`; else nowhere, so Enter picks nothing.
 */
export function initialHighlight(o: {
  count: number;
  chosen: readonly number[];
  typing: boolean;
  auto: AutoHighlight;
  disabled?: (pos: number) => boolean;
}): number {
  if (o.count === 0) return -1;
  if (!o.typing && o.chosen.length > 0) return Math.min(...o.chosen);
  if (o.typing ? o.auto !== false : o.auto === "always") return firstEnabled(o.count, o.disabled);
  return -1;
}

export type TypedEvent = "type" | "close" | "pick" | "clear" | "value";

/**
 * What the input holds besides the chosen title: `undefined` while it shows the title, else the text typed.
 * - `type`: the text typed.
 * - `close` (an Escape, an outside press, the field losing the focus), `clear`: back to the title.
 * - `pick`: back to the title for a single choice; a multiple choice keeps the filter until the list closes, so that
 *   an owner that keeps the list open (`onOpenChange` cancelling an `item-press`) keeps the filter too.
 * - `value` (the chosen value changed under the field): a user in the middle of typing keeps their text.
 */
export function reconcileTyped(o: {
  event: TypedEvent;
  typed: string | undefined;
  text?: string;
  multiple: boolean;
  open: boolean;
}): string | undefined {
  switch (o.event) {
    case "type":
      return o.text;
    case "pick":
      return o.multiple ? o.typed : undefined;
    case "value":
      return o.open ? o.typed : undefined;
    default:
      return undefined;
  }
}

/** What a filter may use: nothing while the input still shows the chosen title (every option is offered), else the text settled on. */
export const filterQuery = (typed: string | undefined, settled: string): string => (typed === undefined ? "" : settled);

/**
 * What typing does to the list: text opens it (the first keystroke after Escape, a paste); emptying the field closes it
 * only when a click does not open it (an empty field has nothing to find, but the list is still a menu to browse);
 * half-composed text (Telex, VNI) changes nothing until it is settled.
 */
export function typingOpens(o: {
  text: string;
  composing: boolean;
  openOnInputClick: boolean;
  readOnly: boolean;
}): "open" | "close" | "keep" {
  if (o.readOnly) return "keep";
  if (o.text.trim() !== "") return "open";
  return o.composing || o.openOnInputClick ? "keep" : "close";
}

export type HighlightReason = "keyboard" | "pointer" | "none";
export type AutocompleteMode = "list" | "both" | "inline" | "none";

/** Modes whose options are filtered by the text typed (`list`, `both`); the others show every option. */
export const filtersByText = (mode: AutocompleteMode): boolean => mode === "list" || mode === "both";

/**
 * The text an Autocomplete shows in place of what was typed while a row is highlighted: the row's text in `both` and
 * `inline`, never for a pointer highlight (the pointer passing over a row must not rewrite the field), never read-only.
 */
export function inlineText(
  mode: AutocompleteMode,
  title: string | undefined,
  reason: HighlightReason,
  readOnly: boolean,
): string | undefined {
  if (readOnly || title === undefined || reason === "pointer") return undefined;
  return mode === "both" || mode === "inline" ? title : undefined;
}

/** A value added to the end, or taken out when it is there. */
export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** The values without the one at `index` (an out-of-range index removes nothing). */
export function removeAt<T>(values: readonly T[], index: number): T[] {
  return values.filter((_, i) => i !== index);
}

/** The chip a cursor lands on after chip `index` of `count` is removed (the one before it at the end), or -1 for none. */
export function chipAfterRemoval(index: number, count: number): number {
  const next = index >= count - 1 ? count - 2 : index;
  return next >= 0 ? next : -1;
}

/** Left from the caret at the start of the field enters the chips at the last one; Left and Right then walk them; Right past the last returns to the field (-1). */
export function chipStep(cursor: number, dir: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (cursor < 0) return dir < 0 ? count - 1 : -1;
  const next = cursor + dir;
  return next < 0 ? 0 : next >= count ? -1 : next;
}
