import { effect, signal, Storage } from "nsh";

import type { BoardCheckout, BoardData, BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";

import { SIDEBAR_WIDTH } from "#lib/layout";
import { save } from "#lib/save";
import { statusText } from "#lib/status";
import { fold } from "#lib/text";

/**
 * What the sidebar lists and how it reads it aloud. The list is the board's projects in the board's order: a project
 * names its machine in its own header (unless it is this computer) and holds its checkouts (when it has more than one)
 * and its agents. A machine is never a line of its own: its link is the footer's. The home shows the same projects, so the two never disagree; folding a project or the search
 * narrows what is listed, nothing else.
 */

/** One line of the tree. The list is virtualized, so a line is plain data and its view keeps no state. */
export type SidebarItem =
  | {
      kind: "project";
      key: string;
      project: BoardProject;
      folded: boolean;
      /** The machine's name for the header, or null for this computer (the usual case says nothing). */
      machine: string | null;
      /** The machine is not online: the header's machine name turns amber and the rows are dashed. */
      stale: boolean;
    }
  | { kind: "checkout"; key: string; project: string; checkout: BoardCheckout }
  | { kind: "row"; key: string; project: string; row: BoardRow; nested: boolean }
  | { kind: "more"; key: string; project: string; count: number; open: boolean };

const KEY = "herdr.sidebar.v1";

/** The id of this computer's machine (`store::LOCAL_ID` in the core): `BoardProject.machine` is this for its projects. */
const LOCAL_MACHINE = "local";

/** The sidebar's width in points: the person drags its edge, and a compact window overrides it with the rail. */
export const sidebarWidth = signal<number>(SIDEBAR_WIDTH.default);

/**
 * Projects the person folded, by `BoardProject.key`, in the sidebar and on the home alike: one state for both lists. A
 * project that needs the person is never hidden by it (its header still says so).
 */
export const foldedProjects = signal<readonly string[]>([]);
/** Projects whose idle agents beyond the first few are all listed (`QUIET_SHOWN`), in memory only. */
export const moreOpen = signal<readonly string[]>([]);
export const sidebarReady = signal(false);
/** How far the tree is scrolled, in points: where the person is in a long list. */
export const treeOffset = signal(0);

export function toggleProject(key: string): void {
  foldedProjects.update((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]));
}

export function toggleMore(key: string): void {
  moreOpen.update((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]));
}

export async function loadSidebar(): Promise<void> {
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (typeof saved === "object" && saved !== null) {
        if ("foldedProjects" in saved && Array.isArray(saved.foldedProjects)) {
          foldedProjects.set(saved.foldedProjects.filter((k): k is string => typeof k === "string"));
        }
        if (
          "width" in saved &&
          typeof saved.width === "number" &&
          saved.width >= SIDEBAR_WIDTH.min &&
          saved.width <= SIDEBAR_WIDTH.max
        ) {
          sidebarWidth.set(saved.width);
        }
      }
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read the sidebar state", e);
  }
  sidebarReady.set(true);
}

effect(() => {
  const state = { foldedProjects: foldedProjects(), width: sidebarWidth() };
  if (sidebarReady()) save(KEY, JSON.stringify(state));
});

/** How many idle agents a project lists before the rest fold behind `N more idle`: idle is inventory, not a decision. */
export const QUIET_SHOWN = 3;

const isQuiet = (row: BoardRow) => row.status === "idle" || row.status === "unknown";

/**
 * The rows of a project to list now: everyone who is doing or asking something, and the first `QUIET_SHOWN` idle ones
 * (the rows arrive in the order the person reads them, so those are the newest); `open` lists them all. `hidden` is how
 * many are folded.
 */
export function shownRows(rows: readonly BoardRow[], open: boolean): { shown: BoardRow[]; hidden: number } {
  if (open) return { shown: [...rows], hidden: 0 };
  const shown: BoardRow[] = [];
  let quiet = 0;
  for (const row of rows) {
    if (!isQuiet(row) || quiet++ < QUIET_SHOWN) shown.push(row);
  }
  return { shown, hidden: rows.length - shown.length };
}

/** `2 need you · 1 working · 3 to review`: a project's header said aloud, only what is not zero. Empty when all are. */
export function projectState(project: Pick<BoardProject, "needsYou" | "working" | "toReview">): string {
  const parts: string[] = [];
  if (project.needsYou > 0) parts.push(project.needsYou === 1 ? "1 needs you" : `${project.needsYou} need you`);
  if (project.working > 0) parts.push(`${project.working} working`);
  if (project.toReview > 0) parts.push(`${project.toReview} to review`);
  return parts.join(", ");
}

/**
 * What a project's header says in words, the quiet half of its one aggregate (the signal dot, when something waits, is the
 * other half). `compact` (a folded sidebar header) is the one number that matters, how many wait: `2`, empty when none do
 * (the rows that are not asking are visible or can be unfolded); the card lists every part: `2 waiting · 2 working · 1 to
 * review`. Empty when all are zero.
 */
export function projectSummary(
  project: Pick<BoardProject, "needsYou" | "working" | "toReview">,
  compact: boolean,
): string {
  if (compact) return project.needsYou > 0 ? `${project.needsYou}` : "";
  const parts: string[] = [];
  if (project.needsYou > 0) parts.push(`${project.needsYou} waiting`);
  if (project.working > 0) parts.push(`${project.working} working`);
  if (project.toReview > 0) parts.push(`${project.toReview} to review`);
  return parts.join(" · ");
}

/** `payments-api` or, when the board spans several machines, `payments-api on build-box`. */
export function projectTitle(project: Pick<BoardProject, "name" | "machineName">, several: boolean): string {
  return several ? `${project.name} on ${project.machineName}` : project.name;
}

/** What a screen reader says for a project: `<name>, <machine>, 2 need you, 1 working`, plus `pinned` and `offline`. */
export function projectLabel(project: BoardProject): string {
  return [
    project.name,
    project.machineName,
    projectState(project),
    project.pinned ? "pinned" : "",
    project.offline ? "offline" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Whether `row` answers `query`: every word of it appears in the project, name, agent, machine or folder, ignoring case and accents. */
export function matches(row: BoardRow, projectName: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(`${projectName} ${row.name} ${row.agent} ${row.machineName} ${row.cwd ?? ""}`);
  return words.every((w) => hay.includes(w));
}

/** The folder a project's new sessions start in: its main checkout, else the first checkout, else where its first agent works. */
export function projectFolder(project: Pick<BoardProject, "checkouts" | "rows">): string {
  const main = project.checkouts.find((c) => !c.linked) ?? project.checkouts[0];
  return main?.path ?? project.rows.find((r) => r.cwd)?.cwd ?? "";
}

/** How many tints a monogram can have (`Monogram` maps each to a theme token). */
export const MONOGRAM_TONES = 4;

/**
 * The letters and the tint of a project's tile: the first letters of its first two words (`payments-api` is `PA`, `web` is
 * `W`) and a tint chosen by a hash of the name, so a project keeps its look across runs, machines and sorting.
 */
export function monogram(name: string): { letters: string; tone: number } {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 1)).toUpperCase();
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return { letters, tone: hash % MONOGRAM_TONES };
}

/** The shown rows grouped by checkout, in the project's order of checkouts; rows with none lead. Empty groups are dropped. */
function byCheckout(
  project: BoardProject,
  rows: readonly BoardRow[],
): { checkout: BoardCheckout | null; rows: BoardRow[] }[] {
  const groups: { checkout: BoardCheckout | null; rows: BoardRow[] }[] = [
    { checkout: null, rows: rows.filter((r) => !r.checkout) },
  ];
  for (const checkout of project.checkouts)
    groups.push({ checkout, rows: rows.filter((r) => r.checkout === checkout.path) });
  return groups.filter((g) => g.rows.length > 0);
}

/**
 * The lines to show, the board's projects in the board's order. A project carries its machine (null for this computer)
 * and whether that machine is not online. A search lists every match (open, without the idle cut: a hit must not hide
 * behind `22 more idle`) and drops projects with no match; a project that is folded lists only its header, and a search
 * overrides folds.
 */
export function sidebarItems(
  data: BoardData,
  statuses: readonly MachineStatus[],
  query: string,
  folds: readonly string[],
  opened: readonly string[],
): SidebarItem[] {
  const searching = fold(query).trim() !== "";
  const out: SidebarItem[] = [];
  for (const project of data.projects) {
    const rows = searching ? project.rows.filter((r) => matches(r, project.name, query)) : project.rows;
    if (rows.length === 0) continue;
    const host = statuses.find((s) => s.id === project.machine);
    const isFolded = !searching && folds.includes(project.key);
    out.push({
      kind: "project",
      key: `p:${project.key}`,
      project,
      folded: isFolded,
      machine: project.machine === LOCAL_MACHINE ? null : (host?.name ?? project.machineName),
      stale: host !== undefined && host.state !== "online",
    });
    if (isFolded) continue;
    const all = searching || opened.includes(project.key);
    const { shown } = shownRows(rows, all);
    const grouped = project.checkouts.length > 1;
    for (const group of byCheckout(project, shown)) {
      if (grouped && group.checkout)
        out.push({
          kind: "checkout",
          key: `c:${project.key}:${group.checkout.path}`,
          project: project.key,
          checkout: group.checkout,
        });
      for (const row of group.rows)
        out.push({ kind: "row", key: row.key, project: project.key, row, nested: grouped && group.checkout !== null });
    }
    const quiet = rows.filter(isQuiet).length;
    if (!searching && quiet > QUIET_SHOWN)
      out.push({ kind: "more", key: `m:${project.key}`, project: project.key, count: quiet - QUIET_SHOWN, open: all });
  }
  return out;
}

/**
 * Whether `a` and `b` draw the same line: equal all the way down, except that a time (`sinceSecs`, which the engine
 * measures anew at every read) is the same while it reads the same (`ageText`).
 */
function sameLine(a: unknown, b: unknown, key = ""): boolean {
  if (a === b) return true;
  if (key === "sinceSecs") return ageText(a as number | null | undefined) === ageText(b as number | null | undefined);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameLine(x, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => sameLine((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], k));
}

/**
 * `next` with every line that did not change replaced by the object it was: the list tells which lines are new by
 * identity, and the engine hands out new objects at every read. Without this each tick (a pane's output, the clock)
 * made every line new, the list dropped what it had measured of them and, with rows of other heights than its estimate,
 * the person's place in a long sidebar slid towards the top (`sidebar-scroll.test.tsx`).
 */
export function keepItems(prev: readonly SidebarItem[], next: SidebarItem[]): SidebarItem[] {
  const before = new Map(prev.map((i) => [i.key, i]));
  return next.map((item) => {
    const old = before.get(item.key);
    return old && sameLine(old, item) ? old : item;
  });
}

/** How long, as a glance wants it: `just now`, `4 min`, `2 h`, `3 d`. Empty when herdr gave no time. */
export function ageText(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} d`;
}

/**
 * What a screen reader says for a row: `<name>, <agent>, <status>, <project>, <machine>, <age>`, plus `offline` when the
 * last state is all we know. `kind` adds nothing: a chat and a terminal are both an agent, and the list says which.
 */
export function rowLabel(row: BoardRow, projectName: string): string {
  return [
    row.name,
    row.agent,
    statusText(row.status, row.reviewed),
    projectName,
    row.machineName,
    ageText(row.sinceSecs),
    row.offline ? "offline" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** How many broken machines the footer names before it folds the rest into one line. */
export const FOOTER_SHOWN = 3;

/**
 * The machines the sidebar footer names: those whose link is an exception (not online, and not switched off, which the
 * person chose). `more` is how many a fold hides: past `FOOTER_SHOWN` the rest wait behind one line, so a bad day with
 * ten machines does not push the projects out of the sidebar.
 */
export function footerMachines(
  statuses: readonly MachineStatus[],
  expanded: boolean,
): { lines: MachineStatus[]; more: number } {
  const broken = statuses.filter((s) => s.state !== "online" && s.state !== "off");
  if (expanded || broken.length <= FOOTER_SHOWN + 1) return { lines: broken, more: 0 };
  return { lines: broken.slice(0, FOOTER_SHOWN), more: broken.length - FOOTER_SHOWN };
}
