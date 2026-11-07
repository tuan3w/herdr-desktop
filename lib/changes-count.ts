import { Git } from "herdr-desktop/native";
import { signal } from "nsh";

import type { Accessor, Signal } from "nsh";

import { branchText } from "#lib/changes";

/**
 * How many files a checkout has changed, as the last read of git said, for the `Changes` chip of a chat's header. It is a cache:
 * nothing here reads on a timer. The Changes tab files what it reads (`noteCount`), and a chat header that is in front asks
 * for one read when it appears and again when its agent changes state (`readCount`), so a hidden tab costs nothing.
 */

/** A read this soon after the last one for the same folder is skipped: the number cannot have moved far. */
export const FRESH_MS = 3000;

const counts = new Map<string, Signal<number | null>>();
const readAt = new Map<string, number>();

const slot = (machine: string, cwd: string) => {
  const key = `${machine}\n${cwd}`;
  let s = counts.get(key);
  if (!s) {
    s = signal<number | null>(null);
    counts.set(key, s);
  }
  return s;
};

/** The count for a folder on a machine, `null` while it is unknown (never read, not a repository). Reactive. */
export const changedFiles = (machine: string, cwd: string): Accessor<number | null> => slot(machine, cwd);

const branches = new Map<string, Signal<string | null>>();
const branchSlot = (machine: string, cwd: string) => {
  const key = `${machine}\n${cwd}`;
  let s = branches.get(key);
  if (!s) {
    s = signal<string | null>(null);
    branches.set(key, s);
  }
  return s;
};

/** The branch line (`main`, `main · 2 ahead`) the last read of git found, for a chat's header; `null` while unknown. Reactive. */
export const changedBranch = (machine: string, cwd: string): Accessor<string | null> => branchSlot(machine, cwd);

/** Files what a read of git found: `null` when there is nothing to count. */
export function noteCount(machine: string, cwd: string, count: number | null): void {
  readAt.set(`${machine}\n${cwd}`, Date.now());
  slot(machine, cwd).set(count);
}

/** Reads git once for the folder unless it was read in the last `FRESH_MS`. A failure leaves the old number. */
export async function readCount(machine: string, cwd: string): Promise<void> {
  const key = `${machine}\n${cwd}`;
  if (Date.now() - (readAt.get(key) ?? 0) < FRESH_MS) return;
  readAt.set(key, Date.now());
  try {
    const status = await Git.status(machine, cwd);
    slot(machine, cwd).set(status.problem ? null : status.files.length);
    branchSlot(machine, cwd).set(status.problem ? null : branchText(status));
  } catch {
    // The chip is a hint: the Changes tab says what went wrong when it is opened.
  }
}
