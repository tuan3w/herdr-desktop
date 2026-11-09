import { effect, host, signal, Storage } from "nsh";

import type {
  BoardCheckout,
  BoardData,
  BoardProject,
  BoardRow,
  LinkStateName,
  MachineStatus,
} from "herdr-desktop/native";

import { SIDEBAR_WIDTH } from "#lib/layout";
import { save } from "#lib/save";
import { clampSidebar } from "#lib/sidebar-width";
import { statusText } from "#lib/status";
import { fold } from "#lib/text";

/**
 * What the sidebar lists and how it reads it aloud. The board's projects in sections: `Pinned` (the projects the person
 * pinned), then `This computer`, then every other machine by name. A project is listed once, in `Pinned` or in its
 * machine's section; inside a machine its header says no machine (the section does), and holds its checkouts (when it has
 * more than one) and its agents. A section's quiet projects (nothing working, waiting, to review, stale or open) wait
 * behind one line. The home shows the same projects and rows as one table; folding or the search narrows what is listed,
 * nothing else.
 */

/** One line of the tree. The list is virtualized, so a line is plain data and its view keeps no state. */
export type SidebarItem =
  | {
      kind: "section";
      key: string;
      /** `pinned` or `machine:<id>`: what its fold is remembered by. */
      section: string;
      label: string;
      /** The machine's link in one word while it is not live (`stale`, `offline`), else null. */
      state: string | null;
      folded: boolean;
      /** How many of its agents wait: what a folded section says. */
      needsYou: number;
    }
  | {
      kind: "project";
      key: string;
      project: BoardProject;
      folded: boolean;
      /** The machine's name for the header: only in `Pinned`, and null for this computer (a machine's section says it). */
      machine: string | null;
      /** The machine is not online: the header's machine name turns amber and the rows are dashed. */
      stale: boolean;
      /** The end of its folder, only when another project of its section has the same name (`~/old`), else null. */
      tail: string | null;
      /** Its section (`pinned`, `machine:<id>`), and its neighbours in the list it is shown in: where a move takes it. */
      section: string;
      above: string | null;
      below: string | null;
    }
  | { kind: "quiet"; key: string; section: string; label: string; count: number; open: boolean }
  | { kind: "checkout"; key: string; project: string; checkout: BoardCheckout }
  | { kind: "row"; key: string; project: string; row: BoardRow }
  | { kind: "more"; key: string; project: string; count: number; open: boolean };

const KEY = "herdr.sidebar.v1";

/** The id of this computer's machine (`store::LOCAL_ID` in the core): `BoardProject.machine` is this for its projects. */
const LOCAL_MACHINE = "local";
const PINNED = "pinned";

/** The sidebar's width in points: the person drags its edge, and a compact window overrides it with the rail. */
export const sidebarWidth = signal<number>(SIDEBAR_WIDTH.default);

/**
 * Projects the person folded, by `BoardProject.key`, in the sidebar and on the home alike: one state for both lists. A
 * project that needs the person is never hidden by it (its header still says so).
 */
export const foldedProjects = signal<readonly string[]>([]);
/** Sections the person folded (`pinned`, `machine:<id>`), remembered like project folds. */
export const foldedSections = signal<readonly string[]>([]);
/** Projects whose idle agents beyond the first few are all listed (`QUIET_SHOWN`), in memory only. */
export const moreOpen = signal<readonly string[]>([]);
/** Sections whose quiet projects are listed, in memory only like `moreOpen`. */
export const quietOpen = signal<readonly string[]>([]);
export const sidebarReady = signal(false);
/** How far the tree is scrolled, in points: where the person is in a long list. */
export const treeOffset = signal(0);

const flip = (all: readonly string[], key: string) =>
  all.includes(key) ? all.filter((k) => k !== key) : [...all, key];

export function toggleProject(key: string): void {
  foldedProjects.update((all) => flip(all, key));
}

export function toggleMore(key: string): void {
  moreOpen.update((all) => flip(all, key));
}

export function toggleSection(section: string): void {
  foldedSections.update((all) => flip(all, section));
}

export function toggleQuiet(section: string): void {
  quietOpen.update((all) => flip(all, section));
}

/**
 * The order the person gave the projects of each section (`pinned`, `machine:<id>`), by `BoardProject.key`. A project not
 * in its section's list (new, or never moved) goes above the placed ones; a key whose project is gone keeps its place, so
 * a machine that comes back finds its projects where they were.
 */
export const projectOrder = signal<Readonly<Record<string, readonly string[]>>>({});

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : null;

export async function loadSidebar(): Promise<void> {
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (typeof saved === "object" && saved !== null) {
        const projects = "foldedProjects" in saved ? strings(saved.foldedProjects) : null;
        if (projects) foldedProjects.set(projects);
        const sections = "foldedSections" in saved ? strings(saved.foldedSections) : null;
        if (sections) foldedSections.set(sections);
        if ("order" in saved && typeof saved.order === "object" && saved.order !== null) {
          const order: Record<string, string[]> = {};
          for (const [section, keys] of Object.entries(saved.order)) {
            const list = strings(keys);
            if (list) order[section] = list;
          }
          projectOrder.set(order);
        }
        // A width saved under an older, narrower range is brought into today's, not thrown away.
        if ("width" in saved && typeof saved.width === "number") sidebarWidth.set(clampSidebar(saved.width));
      }
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read the sidebar state", e);
  }
  // A render or test sets the width to look at it (`host.params.sidebarWidth`; in the real app `host.params` is empty).
  const asked = host.params.sidebarWidth;
  if (typeof asked === "number") sidebarWidth.set(clampSidebar(asked));
  sidebarReady.set(true);
}

effect(() => {
  const state = {
    foldedProjects: foldedProjects(),
    foldedSections: foldedSections(),
    order: projectOrder(),
    width: sidebarWidth(),
  };
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
  // By code point, not UTF-16 unit: a letter outside the basic plane is one letter, never half of one.
  const first = (word: string) => [...word][0] ?? "";
  const letters = (words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0] ?? "?")).toUpperCase();
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

/** One project as both lists draw it: the rows that survive the narrowing, which of them are listed, and where it lives. */
export interface ProjectLine {
  project: BoardProject;
  /** The machine's name for the header, or null for this computer (the usual case says nothing). */
  machine: string | null;
  /** The machine is not online: the header's machine name turns amber and the rows are dashed. */
  stale: boolean;
  folded: boolean;
  /** Every row the narrowing keeps, folded or cut or not. */
  kept: BoardRow[];
  /** The rows to list now: none while folded, else the kept rows without the idle ones past `QUIET_SHOWN` (unless all are open). */
  shown: BoardRow[];
  /** The `N more idle` line: how many idle rows the cut hides (or, open, would hide), null when there is no such line (also while folded). */
  more: { count: number; open: boolean } | null;
}

/** How a list narrows the board's projects: what both lists share, said once. */
export interface Narrowing {
  /** Keeps a row (a search, a state filter); default every row. A project left with no row is dropped. */
  keep?: (row: BoardRow, project: BoardProject) => boolean;
  /** The folded projects; `null` ignores folds (a search lists every match). */
  folds: readonly string[] | null;
  /** The projects whose idle rows are all listed; `true` lists every idle row of every project and draws no `more` line. */
  opened: readonly string[] | true;
}

/**
 * The board's projects in the board's order, each with its machine, its fold and the rows to list. The sidebar and the
 * board's table both read this, so they agree on which projects exist, in what order, which are folded or pinned (a pin is
 * the board's order) and how the idle ones fold.
 */
export function projectLines(data: BoardData, statuses: readonly MachineStatus[], narrowing: Narrowing): ProjectLine[] {
  const out: ProjectLine[] = [];
  for (const project of data.projects) {
    const keep = narrowing.keep;
    const kept = keep ? project.rows.filter((r) => keep(r, project)) : project.rows;
    if (kept.length === 0) continue;
    const host = statuses.find((s) => s.id === project.machine);
    const folded = narrowing.folds !== null && narrowing.folds.includes(project.key);
    const all = narrowing.opened === true || narrowing.opened.includes(project.key);
    const quiet = kept.filter(isQuiet).length;
    out.push({
      project,
      machine: project.machine === LOCAL_MACHINE ? null : (host?.name ?? project.machineName),
      stale: host !== undefined && host.state !== "online",
      folded,
      kept,
      shown: folded ? [] : shownRows(kept, all).shown,
      more:
        !folded && narrowing.opened !== true && quiet > QUIET_SHOWN ? { count: quiet - QUIET_SHOWN, open: all } : null,
    });
  }
  return out;
}

/** A machine's link in one word for its section's label, only while it is not live; null when it is (live says nothing). */
export function linkWord(state: LinkStateName | undefined): string | null {
  switch (state) {
    case "offline":
      return "offline";
    case "connecting":
    case "attention":
      // What it shows is the last state read: the footer line says why and what happens next.
      return "stale";
    case "off":
      return "switched off";
    default:
      return null;
  }
}

/** A section of the sidebar: `Pinned` or one machine, with its projects in the person's order. */
export interface Section {
  /** `pinned` or `machine:<id>`: what its fold and its order are kept by. */
  id: string;
  label: string;
  state: string | null;
  lines: ProjectLine[];
}

const machineSection = (machine: string) => `machine:${machine}`;
const sectionOf = (project: Pick<BoardProject, "pinned" | "machine">) =>
  project.pinned ? PINNED : machineSection(project.machine);

/**
 * `items` in the person's order: those `order` does not place (new, or never moved) first, in the order given, then the
 * placed ones in `order`'s order. With no order it is the order given (the board's).
 */
export function arrange<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[] = []): T[] {
  const at = new Map(order.map((key, i) => [key, i]));
  const unplaced = items.filter((item) => !at.has(keyOf(item)));
  const placed = items.filter((item) => at.has(keyOf(item))).sort((a, b) => at.get(keyOf(a))! - at.get(keyOf(b))!);
  return [...unplaced, ...placed];
}

/**
 * The projects grouped as the sidebar shows them: `Pinned` (when anything is pinned), `This computer`, then the other
 * machines by name; inside each, the person's order (`projectOrder`, `arrange`). A project is in exactly one section.
 */
export function sectionsOf(
  lines: readonly ProjectLine[],
  statuses: readonly MachineStatus[],
  order: Readonly<Record<string, readonly string[]>>,
): Section[] {
  const groups = new Map<string, ProjectLine[]>();
  for (const line of lines) {
    const id = sectionOf(line.project);
    groups.set(id, [...(groups.get(id) ?? []), line]);
  }
  const machines: Section[] = [];
  let pinned: Section | null = null;
  for (const [id, group] of groups) {
    const lines = arrange(group, (l) => l.project.key, order[id]);
    if (id === PINNED) {
      pinned = { id, label: "Pinned", state: null, lines };
      continue;
    }
    const machine = group[0].project.machine;
    const host = statuses.find((s) => s.id === machine);
    const label = machine === LOCAL_MACHINE ? "This computer" : (host?.name ?? group[0].project.machineName);
    machines.push({ id, label, state: linkWord(host?.state), lines });
  }
  machines.sort(
    (a, b) =>
      Number(b.id === machineSection(LOCAL_MACHINE)) - Number(a.id === machineSection(LOCAL_MACHINE)) ||
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.id.localeCompare(b.id),
  );
  return pinned ? [pinned, ...machines] : machines;
}

/**
 * A quiet project waits behind its section's `N quiet projects` line: no agent of it works, waits, finished unreviewed, sits
 * on a machine that is not live, or is open in a tab (`open`). It is active again the moment one does.
 */
export function isQuietProject(line: ProjectLine, open: ReadonlySet<string>): boolean {
  const p = line.project;
  return !line.stale && !p.offline && p.needsYou + p.working + p.toReview === 0 && !p.rows.some((r) => open.has(r.key));
}

/** A folder with the home folder written `~`, in parts: `/home/dev/old` is `["~", "old"]`. */
const folderParts = (path: string) =>
  path
    .replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~")
    .split("/")
    .filter(Boolean);

/**
 * The shortest end of each folder that no other folder of the list shares (`/home/dev/old` and `/home/dev/research` are
 * `~/old` and `~/research`; `/a/x/web` and `/b/y/web` are `x/web` and `y/web`): what tells two projects of one name apart.
 * A part directly under the home folder keeps its `~`, so a short end still says where it is.
 */
export function folderTails(paths: readonly string[]): string[] {
  const all = paths.map(folderParts);
  return all.map((parts, i) => {
    const end = (k: number) => parts.slice(-k).join("/");
    let k = 1;
    while (k < parts.length && all.some((other, j) => j !== i && other.slice(-k).join("/") === end(k))) k++;
    if (k === parts.length - 1 && parts[0] === "~") k++;
    return k >= parts.length && parts[0] !== "~" ? `/${end(k)}` : end(k);
  });
}

/** What the sidebar shows beyond the board: the person's folds, opened lines, order, the search and the open tabs. */
export interface SidebarView {
  query: string;
  /** Folded projects (`foldedProjects`). */
  folds: readonly string[];
  /** Projects whose idle rows are all listed (`moreOpen`). */
  opened: readonly string[];
  /** Folded sections (`foldedSections`). */
  sections: readonly string[];
  /** Sections whose quiet projects are listed (`quietOpen`). */
  quiet: readonly string[];
  /** The person's order per section (`projectOrder`). */
  order: Readonly<Record<string, readonly string[]>>;
  /** Keys of the rows open in a tab: their projects are never quiet. */
  open: readonly string[];
}

/**
 * The lines to show: sections (`sectionsOf`), each with its projects, their checkouts, agents and `N more idle`, and its
 * quiet projects behind one line at its end (listed under it while it is open; never in `Pinned`, where the person asked
 * to see them). A project carries its machine only in `Pinned` and only when it is not this computer, and the end of its
 * folder when another project of its section has the same name. A search lists every match (open, without the idle cut
 * or the quiet line: a hit must not hide behind `22 more idle`), drops projects with no match and overrides folds.
 */
export function sidebarItems(
  data: BoardData,
  statuses: readonly MachineStatus[],
  view: Partial<SidebarView> = {},
): SidebarItem[] {
  const query = view.query ?? "";
  const searching = fold(query).trim() !== "";
  const open = new Set(view.open ?? []);
  const out: SidebarItem[] = [];
  const lines = projectLines(data, statuses, {
    keep: searching ? (r, p) => matches(r, p.name, query) : undefined,
    folds: searching ? null : (view.folds ?? []),
    opened: searching ? true : (view.opened ?? []),
  });
  for (const section of sectionsOf(lines, statuses, view.order ?? {})) {
    const folded = !searching && (view.sections ?? []).includes(section.id);
    out.push({
      kind: "section",
      key: `s:${section.id}`,
      section: section.id,
      label: section.label,
      state: section.state,
      folded,
      needsYou: section.lines.reduce((sum, l) => sum + l.project.needsYou, 0),
    });
    if (folded) continue;
    const pinned = section.id === PINNED;
    const twins = new Map<string, ProjectLine[]>();
    for (const line of section.lines) twins.set(line.project.name, [...(twins.get(line.project.name) ?? []), line]);
    const tails = new Map<string, string>();
    for (const same of twins.values()) {
      if (same.length < 2) continue;
      const ends = folderTails(same.map((l) => projectFolder(l.project)));
      same.forEach((l, i) => tails.set(l.project.key, ends[i]));
    }
    const quiet = searching || pinned ? [] : section.lines.filter((l) => isQuietProject(l, open));
    const active = section.lines.filter((l) => !quiet.includes(l));
    const list = (group: ProjectLine[]) =>
      group.forEach((line, i) =>
        pushProject(out, line, {
          section: section.id,
          machine: pinned ? line.machine : null,
          tail: tails.get(line.project.key) || null,
          above: group[i - 1]?.project.key ?? null,
          below: group[i + 1]?.project.key ?? null,
        }),
      );
    list(active);
    if (quiet.length === 0) continue;
    const shown = (view.quiet ?? []).includes(section.id);
    out.push({
      kind: "quiet",
      key: `q:${section.id}`,
      section: section.id,
      label: section.label,
      count: quiet.length,
      open: shown,
    });
    if (shown) list(quiet);
  }
  return out;
}

/** A project's header, then its checkouts and agents as `line` lists them, then its `N more idle`. */
function pushProject(
  out: SidebarItem[],
  line: ProjectLine,
  where: Pick<Extract<SidebarItem, { kind: "project" }>, "section" | "machine" | "tail" | "above" | "below">,
): void {
  const { project } = line;
  out.push({ kind: "project", key: `p:${project.key}`, project, folded: line.folded, stale: line.stale, ...where });
  const grouped = project.checkouts.length > 1;
  for (const group of byCheckout(project, line.shown)) {
    if (grouped && group.checkout)
      out.push({
        kind: "checkout",
        key: `c:${project.key}:${group.checkout.path}`,
        project: project.key,
        checkout: group.checkout,
      });
    for (const row of group.rows) out.push({ kind: "row", key: row.key, project: project.key, row });
  }
  if (line.more) out.push({ kind: "more", key: `m:${project.key}`, project: project.key, ...line.more });
}

export type ProjectMove = "up" | "down" | "top";

/**
 * The person's order after moving `key` in its section: `up` before `above`, `down` after `below` (its neighbours in the
 * list it is shown in: the active projects or the quiet ones), `top` to the head of the section. The section's whole order
 * is written, the board's projects of that section included, so a project that turns up later goes above them; keys of
 * projects that are gone stay at the end. A move with no neighbour that way is no move.
 */
export function moveProject(
  data: BoardData,
  order: Readonly<Record<string, readonly string[]>>,
  move: { section: string; key: string; above: string | null; below: string | null; to: ProjectMove },
): Readonly<Record<string, readonly string[]>> {
  const { section, key, to } = move;
  const stored = order[section] ?? [];
  const present = data.projects.filter((p) => sectionOf(p) === section).map((p) => p.key);
  const full = arrange(present, (k) => k, stored).filter((k) => k !== key);
  // Already first of its list: `top` has nowhere to take it either.
  const neighbour = to === "down" ? move.below : move.above === null ? null : to === "up" ? move.above : full[0];
  if (neighbour === null || neighbour === undefined || !present.includes(key)) return order;
  const at = full.indexOf(neighbour);
  if (at < 0) return order;
  full.splice(to === "down" ? at + 1 : at, 0, key);
  return { ...order, [section]: [...full, ...stored.filter((k) => !present.includes(k))] };
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
export function keepItems<I extends { key: string }>(prev: readonly I[], next: I[]): I[] {
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
