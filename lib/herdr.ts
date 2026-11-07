import { Herdr } from "herdr-desktop/native";
import { computed, signal } from "nsh";

import type { BoardData, BoardProject, BoardRow, PaneMeta } from "herdr-desktop/native";
import type { Accessor } from "nsh";

import { notify } from "#kit";

/**
 * The one window onto the Rust engine for every screen: a revision counter and what is pulled when it moves.
 * `Herdr.onChange` carries no data (a burst of events is one tick), so a screen reads `board()` or `meta(...)` and
 * is told to read again when `revision()` changes. There is one subscription per process, made by `startHerdr`.
 */

/** What the board shows before the engine runs: nothing, so a screen can render without a guard. */
const EMPTY: BoardData = {
  projects: [],
  needsYou: [],
  counts: { needsYou: 0, toReview: 0, working: 0, idle: 0, offline: 0, machinesNotConnected: 0 },
  statusLine: "nothing running",
  title: "Herdr Desktop",
  revision: 0,
};

const tick = signal(0);
const running = signal(false);
let stop: (() => void) | undefined;

/** Moves once per engine tick (and once per start): a counter of this window's reads, not herdr's revision. */
export const revision: Accessor<number> = tick;

/** Whether `startHerdr` has run: before it, `board()` is the empty board, not the engine's. */
export const started: Accessor<boolean> = running;

/** The board now, pulled once per revision and shared by every reader. Empty until `startHerdr`. */
export const board: Accessor<BoardData> = computed(() => {
  if (!running()) return EMPTY;
  tick();
  return Herdr.board();
});

/** The board's projects and rows by key, built once per revision for the screens that look one up. */
const index = computed(() => {
  const data = board();
  return {
    projects: new Map(data.projects.map((p) => [p.key, p])),
    rows: new Map(allRows(data).map((r) => [r.key, r])),
  };
});

/** The project with this key (`BoardRow.project`), `undefined` when the board has none. */
export const projectOf = (key: string): BoardProject | undefined => index().projects.get(key);

/** The row with this key (`BoardRow.key`), `undefined` when the board has none. */
export const rowOf = (key: string): BoardRow | undefined => index().rows.get(key);

/**
 * Starts the engine for this window and listens to it. `dataDir` is `process.dataDir`; an empty one uses a fresh
 * temporary directory. `fixture` names a scripted herdr in `fixtures/herdr` and is honoured only when the environment
 * variable `HERDR_DESKTOP_TEST` is `1`: labs and tests pass it here and do not call `Herdr.configure` themselves,
 * because configuring again replaces the engine. Calling it again restarts the engine.
 */
export function startHerdr(dataDir: string, fixture?: string): void {
  Herdr.configure({ dataDir, fixture: fixture ?? null });
  listenHerdr();
}

/** Listens to an engine somebody else already configured (a lab that needs its own `Herdr.configure` options). */
export function listenHerdr(): void {
  stop?.();
  stop = Herdr.onChange(() => tick.update((n) => n + 1));
  running.set(true);
  tick.update((n) => n + 1);
}

/** One pane's header facts, read again at every revision; `null` for a machine that is not listed. A pane herdr dropped reads `feedState: "gone"`. */
export function meta(machine: string, pane: string): Accessor<PaneMeta | null> {
  return computed(() => {
    if (!running()) return null;
    tick();
    return Herdr.paneMeta(machine, pane);
  });
}

/** Every row of the board, project by project in the order the projects are listed. */
export function allRows(data: BoardData): BoardRow[] {
  return data.projects.flatMap((p) => p.rows);
}

/** Finished agents of `rows` that can be marked: not reviewed yet and on a machine that is connected. */
export function reviewable(rows: readonly BoardRow[]): BoardRow[] {
  return rows.filter((r) => r.status === "done" && !r.offline);
}

/**
 * Marks the finished agents among `rows` reviewed and says so, with one `Undo` that takes every mark back.
 * Returns how many were marked: 0 means nothing was finished and no toast was shown. This is a mark in this app only;
 * herdr's own state is not touched.
 */
export function reviewWithUndo(rows: readonly BoardRow[]): number {
  const keys = reviewable(rows).map((r) => r.reviewKey);
  if (keys.length === 0) return 0;
  Herdr.review(keys);
  notify(keys.length === 1 ? "Marked reviewed" : `Marked ${keys.length} reviewed`, {
    undo: () => Herdr.unreview(keys),
  });
  return keys.length;
}
