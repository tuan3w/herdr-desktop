import { computed, effect, signal } from "nsh";

import { allRows, board, started } from "#lib/herdr";

/**
 * Which agents are picked for a bulk action, by `BoardRow.key`. One selection for the whole window: the board and the
 * sidebar show the same marks and `BulkBar` acts on them. It lives in memory only (a restart is a fresh look), and an
 * agent that leaves the board leaves the selection, so a bulk action never reaches something that is not on screen.
 */
const picked = signal<readonly string[]>([]);
/** Where a Shift range starts: the row picked last by itself. */
let anchor: string | undefined;

/** The picked keys, in the order they were picked. */
export const selected = () => picked();

/** A row asks this once per key, so membership is a set built once per change, not a scan of the picks. */
const members = computed(() => new Set(picked()));

export const isSelected = (key: string) => members().has(key);

/** Picks or unpicks one row and makes it the start of the next Shift range. */
export function toggle(key: string): void {
  anchor = key;
  picked.update((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]));
}

/**
 * Picks every row from the last toggled one to `key` (both ends included) in the order the person sees them
 * (`orderedKeys`); the picks outside the range stay. With no usable start it picks `key` alone.
 */
export function rangeTo(key: string, orderedKeys: readonly string[]): void {
  const from = anchor === undefined ? -1 : orderedKeys.indexOf(anchor);
  const to = orderedKeys.indexOf(key);
  if (from < 0 || to < 0) {
    anchor = key;
    picked.update((all) => (all.includes(key) ? all : [...all, key]));
    return;
  }
  const range = orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
  picked.update((all) => [...all, ...range.filter((k) => !all.includes(k))]);
}

/** Replaces the selection (`3 to review` picks exactly the finished agents). */
export function select(keys: readonly string[]): void {
  anchor = undefined;
  picked.set([...new Set(keys)]);
}

export function clear(): void {
  anchor = undefined;
  picked.set([]);
}

effect(() => {
  const now = picked();
  // Before the engine runs the board is empty by default, which says nothing about the agents.
  if (now.length === 0 || !started()) return;
  const live = new Set(allRows(board()).map((r) => r.key));
  const kept = now.filter((k) => live.has(k));
  if (kept.length !== now.length) picked.set(kept);
});
