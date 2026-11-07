import { Herdr } from "herdr-desktop/native";
import { announce, computed, signal } from "nsh";

import type { BoardProject, BoardRow } from "herdr-desktop/native";

import { BOARD, focused, onArrival, rowKeyOf, showBoard } from "#lib/dock";
import { board, projectOf, rowOf } from "#lib/herdr";
import { openAgent } from "#lib/open-agent";
import { ageText, projectSummary, rowLabel } from "#lib/sidebar";
import { stateWord, statusText } from "#lib/status";
import type { AgentStatus } from "#lib/status";

/**
 * Where the person has been and the ways back, the part of "switch context" that is about memory:
 *
 * - **Visits** (`Herdr.visit`, kept in `recents.json`): an agent is visited when its tab comes to the front by a command,
 *   or has stayed in front for a second (a click, which may be passing through); a project when the person arrives in an
 *   agent of another project. The list is newest first, one entry per agent and per project, and is what `previous`
 *   and the Switcher read. Entries whose row is gone are skipped, never shown.
 * - **History** (this run only): the places the person went to by a command, `back` and `forward` as in a browser. A
 *   click between tabs replaces where you are, it does not add a step; a new command drops the forward steps; at most
 *   `HISTORY_CAP`; a place whose agent is gone is skipped.
 * - **Previous**: `ctrl+tab` swaps the two agents visited last, `ctrl+shift+tab` the two projects; repeating returns.
 *
 * The pure parts are tested without a window (`nav.test.ts`); the rest is wiring to `lib/dock.ts` and the engine.
 */

const AGENT = "agent:";
const PROJECT = "project:";

/** Steps `back` can take. */
export const HISTORY_CAP = 50;

/** The places gone to, oldest first, and which one the person is at. */
export interface History {
  places: readonly string[];
  at: number;
}

export const emptyHistory = (): History => ({ places: [], at: -1 });

/** A command went to `place`: it becomes the newest step and the steps ahead are dropped. Where you already are adds nothing. */
export function pushPlace(history: History, place: string, cap: number = HISTORY_CAP): History {
  if (history.places[history.at] === place) return history;
  const places = [...history.places.slice(0, history.at + 1), place];
  const extra = Math.max(0, places.length - cap);
  return { places: places.slice(extra), at: places.length - extra - 1 };
}

/** A click moved the person to `place`: where they are is now that place, no step is added (a repeat of a neighbour collapses). */
export function replacePlace(history: History, place: string): History {
  if (history.at < 0) return pushPlace(history, place);
  const places = history.places.slice();
  places[history.at] = place;
  let at = history.at;
  if (at > 0 && places[at - 1] === place) {
    places.splice(at, 1);
    at -= 1;
  }
  if (places[at + 1] === place) places.splice(at + 1, 1);
  return { places, at };
}

/** The nearest place in direction `step` that `valid` accepts, with the history moved there; `null` when there is none. */
export function stepPlace(
  history: History,
  step: 1 | -1,
  valid: (place: string) => boolean,
): { history: History; place: string } | null {
  for (let at = history.at + step; at >= 0 && at < history.places.length; at += step) {
    if (valid(history.places[at])) return { history: { places: history.places, at }, place: history.places[at] };
  }
  return null;
}

/** The first of `order` (newest first) that is not `current` and still exists: what `ctrl+tab` swaps to. */
export function previousOf(
  order: readonly string[],
  current: string | null,
  alive: (key: string) => boolean,
): string | undefined {
  return order.find((key) => key !== current && alive(key));
}

/** The key after (`1`) or before (`-1`) `current` in `order`, wrapping; from outside `order`: the first, or the last going back. */
export function around(order: readonly string[], current: string | null, step: 1 | -1): string | undefined {
  if (order.length === 0) return undefined;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

// ---- what was visited ----

const visited = signal<readonly string[]>([]);

/** Keys newest first, of one kind, whose row still exists. */
function mru(kind: "agent" | "project"): string[] {
  const prefix = kind === "agent" ? AGENT : PROJECT;
  const alive = kind === "agent" ? rowOf : projectOf;
  return visited()
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((k) => alive(k) !== undefined);
}

function visitNow(key: string): void {
  visited.update((all) => [key, ...all.filter((k) => k !== key)].slice(0, 500));
  try {
    Herdr.visit(key);
  } catch (e) {
    console.error("herdr-desktop: cannot note a visit", e);
  }
}

/** The agent in front (`BoardRow.key`), `null` on the board. */
const hereAgent = computed(() => rowKeyOf(focused()));

/** The project of the agent in front, `null` on the board and where no agent is open. */
const hereProject = computed(() => {
  const key = hereAgent();
  return (key !== null ? rowOf(key)?.project : undefined) ?? null;
});

let lastProject: string | null = null;

/** The agent `rowKey` was arrived at: its project first when that is a change of project, so the agent is the newest entry. */
function visitAgent(rowKey: string): void {
  const row = rowOf(rowKey);
  if (row && row.project !== lastProject) {
    lastProject = row.project;
    visitNow(PROJECT + row.project);
  }
  visitNow(AGENT + rowKey);
}

const PASSING_MS = 1000;
let pending: ReturnType<typeof setTimeout> | undefined;

// ---- history ----

let history = emptyHistory();
/** The place a back or forward is opening: its arrival moves along the history, it does not add to it. */
let expected: string | null = null;
let lastArrived: string | null = null;

/** A place is the board or an agent (its row key, whichever view of it is open). */
const placeOf = (panel: string): string => rowKeyOf(panel) ?? BOARD;

const placeAlive = (place: string): boolean => place === BOARD || rowOf(place) !== undefined;

function arrived(panel: string, deliberate: boolean): void {
  clearTimeout(pending);
  const place = placeOf(panel);
  const same = place === lastArrived;
  lastArrived = place;
  if (place !== expected) history = deliberate ? pushPlace(history, place) : replacePlace(history, place);
  if (place === BOARD) return;
  if (deliberate || place === expected) visitAgent(place);
  else if (!same) pending = setTimeout(() => visitAgent(place), PASSING_MS);
}

/**
 * Starts remembering: loads what was visited and listens to the dock for arrivals. Called once by the app, after the
 * engine runs.
 */
export function startNav(): void {
  history = emptyHistory();
  lastArrived = null;
  lastProject = null;
  try {
    visited.set(Herdr.recents().map((r) => r.key));
  } catch (e) {
    console.error("herdr-desktop: cannot read the recent visits", e);
    visited.set([]);
  }
  onArrival(arrived);
  arrived(focused(), false);
}

// ---- going somewhere ----

const named = (row: BoardRow): string => {
  const project = projectOf(row.project);
  return project && project.name !== row.name ? `${row.name}, ${project.name}` : row.name;
};

async function goAgent(row: BoardRow): Promise<void> {
  await openAgent(row);
  announce(`Switched to ${named(row)}`);
}

/** Opens the project `key`: the agent of it visited last, else its first one (those that need you come first). */
export async function openProject(key: string): Promise<boolean> {
  const project = projectOf(key);
  if (!project) return false;
  const last = mru("agent")
    .map((k) => rowOf(k))
    .find((r) => r?.project === key);
  const row = last ?? project.rows[0];
  if (!row) {
    announce(`${project.name} has no agents`);
    return false;
  }
  await goAgent(row);
  return true;
}

/** `ctrl+tab`: the agent visited before this one (from the board: the last one visited). */
export function previousAgent(): void {
  const key = previousOf(mru("agent"), hereAgent(), (k) => rowOf(k) !== undefined);
  const row = key === undefined ? undefined : rowOf(key);
  if (row) void goAgent(row);
  else announce("No other agent visited yet");
}

/** `ctrl+shift+tab`: the project visited before this one. */
export function previousProject(): void {
  const key = previousOf(mru("project"), hereProject(), (k) => projectOf(k) !== undefined);
  if (key === undefined) announce("No other project visited yet");
  else void openProject(key);
}

/** `mod+shift+]` and `mod+shift+[`: the project after or before this one in the sidebar's order, wrapping. */
export function stepProject(step: 1 | -1): void {
  const order = board().projects.map((p) => p.key);
  const key = around(order, hereProject(), step);
  if (key === undefined) announce("No projects");
  else if (order.length === 1 && key === hereProject()) announce("There is only one project");
  else void openProject(key);
}

async function walk(step: 1 | -1): Promise<void> {
  const found = stepPlace(history, step, placeAlive);
  if (!found) {
    announce(step === -1 ? "Nothing to go back to" : "Nothing to go forward to");
    return;
  }
  history = found.history;
  expected = found.place;
  try {
    if (found.place === BOARD) {
      await showBoard();
      announce("Board");
    } else {
      const row = rowOf(found.place);
      if (row) await goAgent(row);
    }
  } finally {
    expected = null;
  }
}

/** `mod+[`. */
export const back = (): Promise<void> => walk(-1);

/** `mod+]`. */
export const forward = (): Promise<void> => walk(1);

// ---- the Switcher ----

/** The Switcher: open or not. */
export const switcherOpen = signal(false);
let cycler: ((step: 1 | -1) => void) | undefined;
let startStep: 1 | -1 = 1;

/** The Switcher registers how to move its highlight while it is open. */
export function onSwitcherStep(step: ((step: 1 | -1) => void) | undefined): void {
  cycler = step;
}

/** Where the highlight starts when the Switcher opens: `1` the second row (the way back), `-1` the last. */
export const switcherStart = (): 1 | -1 => startStep;

/** `mod+e` (`1`) and `mod+shift+e` (`-1`): open the Switcher, or, when it is open, move the highlight. */
export function switcherKey(step: 1 | -1): void {
  if (switcherOpen()) {
    cycler?.(step);
    return;
  }
  startStep = step;
  switcherOpen.set(true);
}

/** One row of the Switcher: an agent or a project visited, and what it says about itself. */
export interface SwitcherItem {
  /** `agent:<BoardRow.key>` or `project:<BoardProject.key>`. */
  id: string;
  kind: "agent" | "project";
  title: string;
  /** The muted line: project, checkout and machine for an agent; the agents and what waits for a project. */
  meta: string;
  /** An agent's state, for its shape; a project has none. */
  status?: AgentStatus;
  /** The quiet word for the state (`waiting for you`), empty when the agent is idle. */
  word: string;
  age: string;
  /** The agent in front: row one, the way back to where the person was. */
  here: boolean;
  /** The whole row as a screen reader says it. */
  spoken: string;
}

/** How many rows the Switcher lists: the places of a working session, not the history of a year. */
export const SWITCHER_ROWS = 12;

/** What a Switcher is opened with: the places to list, in order, and which is the agent in front. Both are fixed from here on. */
export interface SwitcherPlaces {
  /** `SwitcherItem.id`s: the agent in front first, then those visited, newest first, as many as `SWITCHER_ROWS`. */
  ids: string[];
  here: string | null;
}

/** The places to list, taken once when the Switcher opens: a row never moves while it is open. */
export function switcherPlaces(): SwitcherPlaces {
  const current = hereAgent();
  const here = current !== null && rowOf(current) ? AGENT + current : null;
  // The project the agent in front is in is where you are: it is listed again once you leave it.
  const inside = hereProject() === null ? null : PROJECT + hereProject();
  const ids = [...(here ? [here] : []), ...visited().filter((k) => k !== here && k !== inside)].filter((id) =>
    switcherItem(id, null, false),
  );
  return { ids: ids.slice(0, SWITCHER_ROWS), here };
}

/** The rows for `places`, read from the board now: the order is fixed, what a row says (its shape, its age) is live. A place that is gone drops out. */
export function switcherItems(places: SwitcherPlaces): SwitcherItem[] {
  const several = new Set(board().projects.map((p) => p.machine)).size > 1;
  return places.ids.flatMap((id) => switcherItem(id, places.here, several) ?? []);
}

function switcherItem(id: string, here: string | null, several: boolean): SwitcherItem | undefined {
  if (id.startsWith(AGENT)) {
    const row = rowOf(id.slice(AGENT.length));
    const project = row && projectOf(row.project);
    return row && project ? agentItem(row, project, id === here, several) : undefined;
  }
  const project = id.startsWith(PROJECT) ? projectOf(id.slice(PROJECT.length)) : undefined;
  return project && projectItem(project, several);
}

function agentItem(row: BoardRow, project: BoardProject, isHere: boolean, several: boolean): SwitcherItem {
  const checkout = project.checkouts.length > 1 ? project.checkouts.find((c) => c.path === row.checkout)?.name : "";
  return {
    id: AGENT + row.key,
    kind: "agent",
    title: row.name,
    meta: [project.name, checkout, several ? row.machineName : ""].filter(Boolean).join(" · "),
    status: row.status,
    word: stateWord(row.status, row.reviewed),
    age: ageText(row.sinceSecs),
    here: isHere,
    spoken: [rowLabel(row, project.name), isHere ? "here" : ""].filter(Boolean).join(", "),
  };
}

function projectItem(project: BoardProject, several: boolean): SwitcherItem {
  const agents = project.rows.length === 1 ? "1 agent" : `${project.rows.length} agents`;
  return {
    id: PROJECT + project.key,
    kind: "project",
    title: project.name,
    meta: [agents, projectSummary(project, false), several ? project.machineName : ""].filter(Boolean).join(" · "),
    word: "",
    age: "",
    here: false,
    spoken: [
      project.name,
      "project",
      agents,
      project.needsYou > 0 ? statusText("blocked") : "",
      several ? project.machineName : "",
    ]
      .filter(Boolean)
      .join(", "),
  };
}

/** Opens what a Switcher row stands for. The agent in front stays where it is. */
export async function openSwitcherItem(item: SwitcherItem): Promise<void> {
  if (item.here) return;
  if (item.kind === "project") {
    await openProject(item.id.slice(PROJECT.length));
    return;
  }
  const row = rowOf(item.id.slice(AGENT.length));
  if (row) await goAgent(row);
}
