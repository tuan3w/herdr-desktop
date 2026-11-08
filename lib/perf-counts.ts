/**
 * Counts of work a screen does that a frame time cannot name: Markdown split into parts, code blocks made, list cells
 * that changed kind. A lab turns counting on (`countWork(true)`) and reads `counts()` to tell, for instance, that a row
 * scrolled away and back is not parsed again. Off (the app), `tally` is one branch on a boolean.
 */

let on = false;
const table = new Map<string, number>();

/** Starts or stops counting; starting clears what was counted. */
export function countWork(enabled: boolean): void {
  on = enabled;
  table.clear();
}

/** Adds `n` to the count of `id` while counting is on. */
export function tally(id: string, n = 1): void {
  if (on) table.set(id, (table.get(id) ?? 0) + n);
}

/** What was counted since counting started or since `resetCounts`, by id. */
export function counts(): Record<string, number> {
  return Object.fromEntries(table);
}

export function resetCounts(): void {
  table.clear();
}
