import { announce, effect, signal, Storage } from "nsh";

import type { DockAreaLayout, DockAreaRef, DockNode, Placement } from "nsh/base";

import { board, projectOf, rowOf } from "#lib/herdr";
import { focusComposer, paneInFront } from "#lib/pane-input";
import { save } from "#lib/save";
import { forgetView } from "#lib/view-state";

/**
 * The workspace's layouts and the commands that change them. `components/workspace.tsx` renders the `DockArea` from this
 * state; the palette, the menu and the keys call the functions here. The pure part (key names, reading a saved layout,
 * walking groups, the saved document) is tested without a window in `dock.test.ts`.
 *
 * **Contexts.** The workspace shows one context at a time: a project (`BoardProject.key`) with the tabs the person keeps
 * for it, or `HOME`, the one context outside any project, which holds the board and whatever was left there. Each has its
 * own layout (groups, splits, sizes, the displayed tab of each group) and its own focused tab. `switchContext` swaps the
 * layout the area shows and the old project's tabs unmount; what a tab held beyond its layout (an unsent message, a
 * chat's scroll) is `lib/view-state.ts`'s. A tab belongs to its agent's project: `openPanel` of an agent that is open
 * somewhere shows it where it is, else adds it to its project's context and goes there, unless `here` asks to put it in
 * the context the person is in (which moves it: a tab is in one context only). A project context may be empty (the
 * workspace then shows the project's own card); the board is never closable, so `HOME` never is.
 *
 * Panel keys: `board` (the home tab, never closable), `pane:<machine>/<paneId>` (a terminal pane mirrored) and
 * `session:<machine>/<id>` (a chat: an agent session of a keeper, or, with the id `pane:<paneId>`, the chat read from
 * the log of the agent in that terminal pane). A tab is a view: closing it never closes the pane or the session.
 */
export const BOARD = "board";
/** The context outside any project. Project keys are `machine/...` paths, so this cannot be one. */
export const HOME = "home";
export const STORAGE_KEY = "herdr.dock.v2";
/** The one layout of the first version: read once and replaced (`loadDock`). */
const V1_KEY = "herdr.dock.v1";
/** Contexts kept, the least recently used going first. Each is about half a kilobyte. */
export const CONTEXT_CAP = 60;
/** A context whose project the board no longer has is dropped after this long. */
export const GONE_AFTER_MS = 30 * 24 * 3600 * 1000;
/** Quiet time before the layout is written: it is reported on every edit, a tab selection and a resize included. */
export const SAVE_DELAY_MS = 500;
const PANE = "pane:";
const SESSION = "session:";

export const paneKey = (machine: string, pane: string): string => `${PANE}${machine}/${pane}`;
export const sessionKey = (machine: string, id: string): string => `${SESSION}${machine}/${id}`;

/** Splits `<prefix><machine>/<rest>`; pane and session ids hold `:` (and `pane:`) but a machine id never holds `/`. */
function split(prefix: string, key: string): { machine: string; rest: string } | null {
  if (!key.startsWith(prefix)) return null;
  const slash = key.indexOf("/", prefix.length);
  if (slash <= prefix.length || slash === key.length - 1) return null;
  return { machine: key.slice(prefix.length, slash), rest: key.slice(slash + 1) };
}

/** The machine and pane a panel key names, `null` for the board and for anything else. */
export function parsePaneKey(key: string): { machine: string; pane: string } | null {
  const at = split(PANE, key);
  return at && { machine: at.machine, pane: at.rest };
}

/** The machine and session id a chat tab's key names, `null` for anything else. An id `pane:<paneId>` is a terminal agent's chat. */
export function parseSessionKey(key: string): { machine: string; id: string } | null {
  const at = split(SESSION, key);
  return at && { machine: at.machine, id: at.rest };
}

/** The key of the board row a tab is about (`BoardRow.key`), `null` for the board: a pane, a terminal agent's chat and a keeper session each map to their one row. */
export function rowKeyOf(panel: string): string | null {
  const pane = parsePaneKey(panel);
  if (pane) return `${pane.machine}/${pane.pane}`;
  const chat = parseSessionKey(panel);
  if (!chat) return null;
  return chat.id.startsWith(PANE)
    ? `${chat.machine}/${chat.id.slice(PANE.length)}`
    : `${chat.machine}/session:${chat.id}`;
}

const validKey = (key: unknown): key is string =>
  typeof key === "string" && (key === BOARD || parsePaneKey(key) !== null || parseSessionKey(key) !== null);

export function defaultLayout(): DockAreaLayout {
  return { center: { type: "split", axis: "horizontal", children: [{ type: "tabs", panels: [BOARD] }] } };
}

/** One tab group of the center, as the commands see it. `id` is the area's, known once it reported a layout. */
export interface Group {
  id?: number;
  panels: string[];
  active: number;
}

/** Every tab group of the center in reading order (left to right, top to bottom). */
export function groups(layout: DockAreaLayout): Group[] {
  const out: Group[] = [];
  const walk = (node: DockNode) => {
    if (node.type === "tabs") out.push({ id: node.id, panels: [...node.panels], active: node.activeIndex ?? 0 });
    else node.children.forEach(walk);
  };
  walk(layout.center);
  return out;
}

/** Every panel in reading order. */
export const panelsOf = (layout: DockAreaLayout): string[] => groups(layout).flatMap((g) => g.panels);

/** The group holding `key` (`undefined` when no group does). */
export const groupOf = (layout: DockAreaLayout, key: string): Group | undefined =>
  groups(layout).find((g) => g.panels.includes(key));

/** The group after the one holding `key`, wrapping; `undefined` when there is only one group. */
export function otherGroup(layout: DockAreaLayout, key: string): Group | undefined {
  const all = groups(layout);
  const at = all.findIndex((g) => g.panels.includes(key));
  return all.length > 1 && at >= 0 ? all[(at + 1) % all.length] : undefined;
}

/** A node cleaned of what a stale or edited file could hold; `null` when nothing of it is left. */
function clean(node: unknown, seen: Set<string>): DockNode | null {
  if (typeof node !== "object" || node === null) return null;
  const n = node as Record<string, unknown>;
  if (n.type === "tabs" && Array.isArray(n.panels)) {
    const panels: string[] = [];
    for (const p of n.panels) {
      if (!validKey(p) || seen.has(p)) continue;
      seen.add(p);
      panels.push(p);
    }
    if (panels.length === 0) return null;
    const active =
      typeof n.activeIndex === "number" && n.activeIndex >= 0 && n.activeIndex < panels.length ? n.activeIndex : 0;
    return { type: "tabs", panels, activeIndex: active };
  }
  if (n.type === "split" && Array.isArray(n.children) && (n.axis === "horizontal" || n.axis === "vertical")) {
    const sizes = Array.isArray(n.sizes) ? n.sizes : [];
    const children: DockNode[] = [];
    const kept: (number | null)[] = [];
    n.children.forEach((child, i) => {
      const c = clean(child, seen);
      if (!c) return;
      children.push(c);
      const size = sizes[i];
      kept.push(typeof size === "number" && size > 0 ? size : null);
    });
    return children.length === 0 ? null : { type: "split", axis: n.axis, children, sizes: kept };
  }
  return null;
}

/** The layout of a context with no tab: what a project shows before anything is opened in it. */
export function emptyLayout(): DockAreaLayout {
  return { center: { type: "split", axis: "horizontal", children: [] } };
}

/**
 * A saved layout made safe to show: unknown panels and repeats are dropped, empty groups go. `home` is the layout of the
 * context outside any project: the board is always there (put back at the front of the first group when the file lost
 * it) and anything unreadable gives the default layout. A project's layout never holds the board, and nothing left of it
 * is an empty layout (a project may have no tab open). Only the center is kept: this app has no docks.
 */
export function layoutOf(parsed: unknown, home: boolean): DockAreaLayout {
  const none = home ? defaultLayout() : emptyLayout();
  // The board is the home's alone: marking it seen drops it from every project's layout.
  const center =
    typeof parsed === "object" && parsed !== null && "center" in parsed
      ? clean(parsed.center, new Set(home ? [] : [BOARD]))
      : null;
  if (!center) return none;
  const root: DockNode = center.type === "split" ? center : { type: "split", axis: "horizontal", children: [center] };
  const layout: DockAreaLayout = { center: root };
  if (home && !panelsOf(layout).includes(BOARD)) {
    const put = (node: DockNode): boolean => {
      if (node.type === "tabs") {
        node.panels.unshift(BOARD);
        node.activeIndex = (node.activeIndex ?? 0) + 1;
        return true;
      }
      return node.children.some(put);
    };
    put(layout.center);
  }
  return layout;
}

/** The home layout in a JSON text (the first version's file): anything unreadable gives the default layout. */
export function readLayout(raw: string | null | undefined): DockAreaLayout {
  if (!raw) return defaultLayout();
  try {
    return layoutOf(JSON.parse(raw), true);
  } catch {
    return defaultLayout();
  }
}

const rootOf = (node: DockNode): DockNode =>
  node.type === "split" ? node : { type: "split", axis: "horizontal", children: [node] };

/** A copy of `layout` with `edit` applied to every tab group; a group `edit` empties goes, and so does a split left with nothing. */
function mapGroups(layout: DockAreaLayout, edit: (group: Extract<DockNode, { type: "tabs" }>) => void): DockAreaLayout {
  const walk = (node: DockNode): DockNode | null => {
    if (node.type === "tabs") {
      const copy = { ...node, panels: [...node.panels] };
      edit(copy);
      if (copy.panels.length === 0) return null;
      copy.activeIndex = Math.min(copy.activeIndex ?? 0, copy.panels.length - 1);
      return copy;
    }
    const sizes = node.sizes ?? [];
    const children: DockNode[] = [];
    const kept: (number | null)[] = [];
    node.children.forEach((child, i) => {
      const c = walk(child);
      if (!c) return;
      children.push(c);
      kept.push(sizes[i] ?? null);
    });
    return children.length === 0 ? null : { ...node, children, sizes: kept };
  };
  const root = walk(layout.center);
  return { ...layout, center: root ? rootOf(root) : emptyLayout().center };
}

/** `layout` without these panels (the group that held the displayed one shows its neighbour). */
export function withoutPanels(layout: DockAreaLayout, drop: ReadonlySet<string>): DockAreaLayout {
  return mapGroups(layout, (group) => {
    const shown = group.panels[group.activeIndex ?? 0];
    group.panels = group.panels.filter((p) => !drop.has(p));
    const at = group.panels.indexOf(shown);
    group.activeIndex = at >= 0 ? at : Math.min(group.activeIndex ?? 0, Math.max(0, group.panels.length - 1));
  });
}

/** `layout` with `key` added as the displayed tab of the group holding `near`, else of the first group; an empty layout gets a group. */
export function withPanel(layout: DockAreaLayout, key: string, near?: string): DockAreaLayout {
  if (panelsOf(layout).includes(key)) return activate(layout, key);
  const all = groups(layout);
  if (all.length === 0) return { center: rootOf({ type: "tabs", panels: [key], activeIndex: 0 }) };
  const target = all.findIndex((g) => near !== undefined && g.panels.includes(near));
  let at = 0;
  return mapGroups(layout, (group) => {
    if (at++ !== Math.max(0, target)) return;
    group.panels.push(key);
    group.activeIndex = group.panels.length - 1;
  });
}

/** `layout` with `key` as the displayed tab of its group. */
export function activate(layout: DockAreaLayout, key: string): DockAreaLayout {
  return mapGroups(layout, (group) => {
    const at = group.panels.indexOf(key);
    if (at >= 0) group.activeIndex = at;
  });
}

/** The tab a layout comes back to: `wanted` when it is there, else the board of the home, else the first group's displayed tab, else none (`""`). */
export function restoreFocus(layout: DockAreaLayout, wanted: string | undefined, home: boolean): string {
  const panels = panelsOf(layout);
  if (wanted !== undefined && panels.includes(wanted)) return wanted;
  if (home && panels.includes(BOARD)) return BOARD;
  const first = groups(layout)[0];
  return first?.panels[first.active] ?? "";
}

/** What is kept of a context: its layout, the tab the person was in, and when. */
export interface Context {
  layout: DockAreaLayout;
  focused: string;
  savedAt: number;
}

/** The saved document: the context shown, every context by key (the home under `HOME`) and the panels waiting for their project. */
export interface Contexts {
  current: string;
  contexts: Record<string, Context>;
  /** Panels of the home that belong to a project the board has not shown yet (a first start after the update, an offline machine). */
  strays: string[];
}

/** The contexts a file holds; `null` when it is not a readable second-version file (the caller then tries the first version's). */
export function readDock(raw: string | null | undefined): Contexts | null {
  if (!raw) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || (doc as { v?: unknown }).v !== 2) return null;
  const d = doc as { current?: unknown; home?: unknown; contexts?: unknown; strays?: unknown };
  const one = (value: unknown, home: boolean): Context => {
    const c = (typeof value === "object" && value !== null ? value : {}) as Partial<Context>;
    const layout = layoutOf(c.layout, home);
    return {
      layout,
      focused: restoreFocus(layout, typeof c.focused === "string" ? c.focused : undefined, home),
      savedAt: typeof c.savedAt === "number" ? c.savedAt : 0,
    };
  };
  const contexts: Record<string, Context> = { [HOME]: one(d.home, true) };
  if (typeof d.contexts === "object" && d.contexts !== null)
    for (const [key, value] of Object.entries(d.contexts)) if (key !== HOME) contexts[key] = one(value, false);
  const current = typeof d.current === "string" && d.current in contexts ? d.current : HOME;
  const strays = Array.isArray(d.strays) ? d.strays.filter((k): k is string => validKey(k) && k !== BOARD) : [];
  return { current, contexts, strays };
}

/** The file for `doc`: at most `CONTEXT_CAP` contexts (the least recently used go, the shown one never), the home apart. */
export function writeDock(doc: Contexts): string {
  const { [HOME]: home, ...projects } = doc.contexts;
  const kept = Object.entries(projects)
    .sort(([ak, a], [bk, b]) => (bk === doc.current ? 1 : 0) - (ak === doc.current ? 1 : 0) || b.savedAt - a.savedAt)
    .slice(0, CONTEXT_CAP);
  return JSON.stringify({
    v: 2,
    current: doc.current === HOME || kept.some(([k]) => k === doc.current) ? doc.current : HOME,
    home,
    contexts: Object.fromEntries(kept),
    strays: doc.strays,
  });
}

/**
 * Splits a layout the first version saved (one for everything) by project: each panel `project` names goes into that
 * project's layout, as one group in reading order (the displayed tab of the group it was in, when it moved), the rest
 * stay in the home layout as they were. A panel whose project is unknown stays in the home, and is returned in `strays`.
 */
export function bucket(
  layout: DockAreaLayout,
  project: (panel: string) => string | null | undefined,
): { home: DockAreaLayout; projects: Record<string, DockAreaLayout>; strays: string[] } {
  const moved = new Map<string, string[]>();
  const strays: string[] = [];
  for (const panel of panelsOf(layout)) {
    if (panel === BOARD) continue;
    const key = project(panel);
    if (key) moved.set(key, [...(moved.get(key) ?? []), panel]);
    else strays.push(panel);
  }
  const projects: Record<string, DockAreaLayout> = {};
  for (const [key, panels] of moved) {
    projects[key] = { center: rootOf({ type: "tabs", panels, activeIndex: 0 }) };
  }
  return { home: withoutPanels(layout, new Set([...moved.values()].flat())), projects, strays };
}

// ---- state ----

/** The layout shown, as the area last reported it. */
export const layout = signal<DockAreaLayout>(defaultLayout());
/** The context shown: `HOME`, or a project's key (`BoardProject.key`). */
export const context = signal<string>(HOME);
/** Whether the saved layouts have been read: the workspace mounts after, so it never shows the default and then jumps. */
export const dockReady = signal(false);
/** Moves each time a project's context is shown in place of another: the workspace plays its short entrance from it (`contextEnter`). */
export const entered = signal(0);
/**
 * The panel the person is working in: the one most recently opened, selected by a key or a click, or moved. Tab
 * shortcuts, close, split and `capture` act on it. The area does not report a click on the tab that is already
 * displayed, so a click on a displayed tab of another group does not move it: select it or use `focusPane`. Empty
 * (`""`) in a project that has no tab open.
 */
export const focused = signal<string>(BOARD);
/** The agent tab (pane or chat) used last: where `focusPane` goes from the board. */
export const lastPane = signal<string | null>(null);

let area: DockAreaRef | undefined;
let timer: number | undefined;
/** Every context but the shown one as last left, and the shown one as last saved. */
let contexts: Record<string, Context> = {};
let strays = new Set<string>();
/** The layout of the first version was found and has not been split by project yet. */
let migrating = false;

/** The workspace hands over its area when it mounts and `undefined` when it goes. */
export function attach(ref: DockAreaRef | undefined): void {
  area = ref;
}

function install(doc: Contexts): void {
  contexts = doc.contexts;
  strays = new Set(doc.strays);
  const at = contexts[doc.current];
  context.set(doc.current);
  layout.set(at.layout);
  focused.set(at.focused);
  if (at.focused !== BOARD && at.focused !== "") lastPane.set(at.focused);
}

/**
 * Reads the saved layouts once; a storage failure leaves the default. A file of the first version (one layout for every
 * project) opens as the home as it was and is split by project when the board first knows its panels (`adopt`).
 */
export async function loadDock(): Promise<void> {
  try {
    const doc = readDock(await Storage.getItem(STORAGE_KEY));
    if (doc) install(doc);
    else {
      const old = await Storage.getItem(V1_KEY);
      if (old) {
        const home = readLayout(old);
        install({
          current: HOME,
          contexts: { [HOME]: { layout: home, focused: BOARD, savedAt: Date.now() } },
          strays: panelsOf(home).filter((p) => p !== BOARD),
        });
        migrating = true;
      }
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read the dock layout", e);
  }
  dockReady.set(true);
}

/** Keeps the shown context's layout and tab in the table of contexts. */
function remember(): void {
  contexts[context()] = { layout: layout(), focused: focused(), savedAt: Date.now() };
}

function saveSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(write, SAVE_DELAY_MS);
}

function write(): void {
  remember();
  const text = writeDock({ current: context(), contexts, strays: [...strays] });
  if (!migrating) {
    save(STORAGE_KEY, text);
    return;
  }
  // The first version's file goes only once the new one is safely written.
  migrating = false;
  Storage.setItem(STORAGE_KEY, text).then(
    () => Storage.removeItem(V1_KEY),
    (e: unknown) => {
      migrating = true;
      console.error("herdr-desktop: cannot write the dock layouts", e);
    },
  );
}

/** The area reported a new layout: show it and write it once the edits stop. */
export function setLayout(next: DockAreaLayout): void {
  layout.set(next);
  if (!panelsOf(next).includes(focused())) focused.set(restoreFocus(next, undefined, context() === HOME));
  saveSoon();
}

/** The panel a command just put the person in, for the instant its edit takes to report. */
let pin: { key: string; at: number } | undefined;
/** How long after a command the area's own "displayed tab changed" reports are not the person's choice. */
const PIN_MS = 150;

/** Who is told where the person arrived (`lib/nav.ts`): the panel, and whether a command (not a click) brought them. */
let arrival: ((key: string, deliberate: boolean) => void) | undefined;

/** Registers the one listener of arrivals; `lib/nav.ts` keeps the history and the visits from them. */
export function onArrival(listener: ((key: string, deliberate: boolean) => void) | undefined): void {
  arrival = listener;
}

function focus(key: string, deliberate: boolean): void {
  focused.set(key);
  if (key !== BOARD && key !== "") lastPane.set(key);
  arrival?.(key, deliberate);
}

/**
 * A panel is now displayed in its group, which is where the person is working: a click on a tab, or a command. One edit
 * can display several panels at once (a tab leaves a group, which then shows its next one), so for an instant after a
 * command only the panel the command chose counts.
 */
export function activated(key: string): void {
  if (pin && pin.key !== key && Date.now() - pin.at < PIN_MS) return;
  focus(key, false);
}

/** A command made `key` the working panel. */
function chosen(key: string): void {
  pin = { key, at: Date.now() };
  focus(key, true);
}

/**
 * The pane the focused tab is about: a terminal tab's own, or the pane a chat read from its terminal comes from (the pane
 * commands, rename and close in herdr, work from either view). `null` on the board and in a keeper's chat, which has no pane.
 */
export function focusedPane(): { machine: string; pane: string } | null {
  const key = focused();
  const chat = parseSessionKey(key);
  if (chat) return chat.id.startsWith(PANE) ? { machine: chat.machine, pane: chat.id.slice(PANE.length) } : null;
  return parsePaneKey(key);
}

// ---- contexts ----

/** The context a panel belongs to: the home for the board, the project of its agent's row, `null` when that is not known (a shell pane, an agent the board has not listed yet). */
export function homeOf(key: string): string | null {
  if (key === BOARD) return HOME;
  const row = rowKeyOf(key);
  return (row !== null ? rowOf(row)?.project : undefined) ?? null;
}

/** The context that holds `key` as a tab, `undefined` when none does. A tab is in one context only. */
function holderOf(key: string): string | undefined {
  if (panelsOf(layout()).includes(key)) return context();
  return Object.entries(contexts).find(([k, c]) => k !== context() && panelsOf(c.layout).includes(key))?.[0];
}

/** Changes the layout of a context that is not shown (the shown one is the area's). */
function editSaved(key: string, edit: (layout: DockAreaLayout) => DockAreaLayout): void {
  const at = contexts[key];
  if (at) contexts[key] = { ...at, layout: edit(at.layout), savedAt: Date.now() };
  const fixed = contexts[key];
  if (fixed) fixed.focused = restoreFocus(fixed.layout, fixed.focused, key === HOME);
  saveSoon();
}

/** What a switch says to a screen reader: the context, how many tabs it holds and how many agents of it need the person. */
function summary(key: string, tabs: number): string {
  if (key === HOME) return "Home, board";
  const project = projectOf(key);
  const n = tabs === 0 ? "no tabs" : tabs === 1 ? "1 tab" : `${tabs} tabs`;
  const needs =
    project && project.needsYou > 0
      ? `, ${project.needsYou === 1 ? "1 needs you" : `${project.needsYou} need you`}`
      : "";
  return `${project?.name ?? "Project"}, ${n}${needs}`;
}

/**
 * Shows another context: the layout and the tab it was left with come back (`focus` names the tab to show instead, if
 * it is there), the old context's tabs unmount and the new context's mount. Pane screens are live and drafts and scroll
 * are `lib/view-state.ts`'s, so nothing else needs restoring. `arrive: false` is for a caller that adds a tab right
 * after and says where the person arrived itself. Returns false when it is already the context, or the project is
 * unknown (it is not on the board and has no saved layout).
 */
export function switchContext(key: string, options: { focus?: string; arrive?: boolean } = {}): boolean {
  adopt();
  if (key === context()) return false;
  if (key !== HOME && !projectOf(key) && !contexts[key]) return false;
  remember();
  const saved = contexts[key];
  const home = key === HOME;
  const fresh: DockAreaLayout = saved?.layout ?? (home ? defaultLayout() : emptyLayout());
  const wanted = options.focus ?? saved?.focused;
  const tab = restoreFocus(fresh, wanted, home);
  context.set(key);
  layout.set(tab === "" ? fresh : activate(fresh, tab));
  focused.set(tab);
  if (tab !== "" && tab !== BOARD) lastPane.set(tab);
  entered.update((n) => n + 1);
  saveSoon();
  if (options.arrive === false) return true;
  // The area reports each group's displayed tab as it takes the layout: only the tab chosen here counts for an instant.
  pin = { key: tab, at: Date.now() };
  announce(summary(key, panelsOf(layout()).length));
  arrival?.(tab, true);
  return true;
}

/**
 * Moves panels that belong to a project but sit in the home into that project's context: what a first start after the
 * update found in the one old layout, and a tab opened before the board knew its agent. A panel whose project is still
 * unknown stays where it is and is tried again at the next call. Also drops contexts of projects the board has not had
 * for 30 days. Runs when the board has projects and at every switch.
 */
export function adopt(): void {
  if (board().projects.length === 0) return;
  const here = context() === HOME;
  const home = here ? layout() : contexts[HOME]?.layout;
  if (home && strays.size > 0) {
    const mine = [...strays].filter((p) => panelsOf(home).includes(p));
    const placed = new Map<string, string[]>();
    for (const panel of mine) {
      const project = homeOf(panel);
      if (project && project !== HOME) placed.set(project, [...(placed.get(project) ?? []), panel]);
    }
    if (placed.size > 0) {
      const gone = new Set([...placed.values()].flat());
      for (const [project, panels] of placed) {
        const at = contexts[project] ?? { layout: emptyLayout(), focused: "", savedAt: Date.now() };
        const next = panels.reduce((l, panel) => withPanel(l, panel, undefined), at.layout);
        contexts[project] = { layout: next, focused: restoreFocus(next, at.focused, false), savedAt: Date.now() };
      }
      for (const panel of gone) strays.delete(panel);
      if (here) setLayout(withoutPanels(layout(), gone));
      else editSaved(HOME, (l) => withoutPanels(l, gone));
    }
    for (const panel of strays) if (!panelsOf(home).includes(panel)) strays.delete(panel);
    saveSoon();
  }
  const now = Date.now();
  for (const [key, c] of Object.entries(contexts))
    if (key !== HOME && key !== context() && !projectOf(key) && now - c.savedAt > GONE_AFTER_MS) delete contexts[key];
}

/** Starts watching the board: panels of the home whose project turns up are moved to it. Called once by the app. */
export function startDock(): void {
  effect(() => {
    if (dockReady() && board().projects.length > 0) adopt();
  });
}

// ---- commands ----

/** Where a tab opened for `key` goes, and whether it comes from another context (`here`: the person's own choice, which moves it). */
export interface OpenOptions {
  /** Put the tab in the context the person is in, even when it belongs to another project or is open there. */
  here?: boolean;
}

/**
 * Opens a panel: an agent already open somewhere is shown where it is (its context comes back with it); otherwise it is
 * added to its project's context (the focused group of it) and that context is shown. `here` puts it in the shown
 * context instead, moving it out of the context that had it. Either way it becomes the focused tab.
 */
export async function openPanel(key: string, options: OpenOptions = {}): Promise<void> {
  if (!area) return;
  const holder = holderOf(key);
  if (holder === context()) {
    area.selectPanel(key);
    chosen(key);
    return;
  }
  if (holder !== undefined && !options.here) {
    switchContext(holder, { focus: key });
    return;
  }
  if (holder !== undefined) editSaved(holder, (l) => withoutPanels(l, new Set([key])));
  const target = options.here ? context() : (homeOf(key) ?? context());
  const crossed = target !== context() && switchContext(target, { arrive: false });
  // A layout the area has not taken yet, or one with no group, is edited as data: the area adopts it from the prop.
  if (crossed || groups(layout()).length === 0) {
    setLayout(withPanel(layout(), key, focused()));
  } else {
    const home = groupOf(layout(), focused());
    const id = home?.id ?? (await area.groupOf(focused())) ?? undefined;
    if (id === undefined) area.addPanel(key);
    else area.movePanel(key, { group: id });
  }
  if (context() === HOME && homeOf(key) === null && key !== BOARD) strays.add(key);
  chosen(key);
}

/** Opens a chat's tab (`id` is a keeper session's, or `pane:<paneId>` for a terminal agent read from its log); the tab attaches itself. */
export const openSession = (machine: string, id: string, options?: OpenOptions): Promise<void> =>
  openPanel(sessionKey(machine, id), options);

/** Opens a pane's tab; `reply` (the board's `Reply…`) also puts the keyboard in its message box. */
export async function openPane(
  machine: string,
  pane: string,
  options?: OpenOptions & { reply?: boolean },
): Promise<void> {
  await openPanel(paneKey(machine, pane), options);
  if (options?.reply) await focusComposerSoon();
}

/**
 * Puts the keyboard in the message box of the tab just opened. A tab that was not mounted (just added, or its context
 * just swapped in) is rendered a moment later, and the one in front now is the one the person just left: wait a tick for
 * it to go, then for the new one to register.
 */
export async function focusComposerSoon(): Promise<void> {
  await later(0);
  for (let tries = 0; tries < 60 && !paneInFront(); tries++) await later(16);
  focusComposer();
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const showBoard = (): Promise<void> => openPanel(BOARD);

/** Closes a tab as a person closes a view: the pane keeps running. The board stays; a project that loses its last tab stays, empty. */
export function closeTab(key: string): void {
  if (key === BOARD || key === "") return;
  leave(key, () => area?.closePanel(key));
}

/** How long the area has to report an edit before it is taken to have refused it. */
const REFUSED_MS = 100;

/**
 * Takes `key` out through the area and makes sure it went: the area will not close or remove the last tab it shows (it
 * would be left empty), but a project may have none, and its layout is ours to set.
 */
function leave(key: string, through: () => void): void {
  through();
  setTimeout(() => {
    if (panelsOf(layout()).includes(key)) setLayout(withoutPanels(layout(), new Set([key])));
  }, REFUSED_MS);
}

/**
 * Removes a panel whatever its options say: a tab whose pane was closed in herdr, or the `Agent gone` placeholder's
 * `Close`. What the tab held (a draft, a scroll position) goes with it.
 */
export function removePanel(key: string): void {
  forgetView(key);
  const holder = holderOf(key);
  if (holder === context()) leave(key, () => area?.removePanel(key));
  else if (holder !== undefined) editSaved(holder, (l) => withoutPanels(l, new Set([key])));
}

/** Opens tab `n` (1-based) of the focused group; says which one when there is none. */
export function selectNth(n: number): void {
  const group = groupOf(layout(), focused());
  const key = group?.panels[n - 1];
  if (!key) {
    announce(`No tab ${n}`);
    return;
  }
  area?.selectPanel(key);
  chosen(key);
}

/** Why a split or move did nothing, for a person who asked for it. */
const ALONE = "Open a second tab in this group first: a tab cannot split away from an empty group";

/**
 * Moves the focused tab into a new group beside its own (`right`, `bottom`, `left`, `top`), or into the next group
 * (`other`). Every drag of the area has one of these as its keyboard form. Returns false (and says why) when the
 * focused tab is alone in its group, because then there is nothing to leave behind.
 */
export async function moveFocused(where: Placement | "other"): Promise<boolean> {
  const key = focused();
  const here = groupOf(layout(), key);
  if (!area || !here) return false;
  if (where === "other") {
    const target = otherGroup(layout(), key);
    if (!target) {
      announce("There is only one group: split first");
      return false;
    }
    const id = target.id ?? (await area.groupOf(target.panels[0]));
    if (id === null || id === undefined) return false;
    area.movePanel(key, { group: id });
    chosen(key);
    announce(`Moved to the group with ${target.panels.length} tabs`);
    return true;
  }
  if (here.panels.length < 2) {
    announce(ALONE);
    return false;
  }
  const id = here.id ?? (await area.groupOf(key));
  if (id === null || id === undefined) return false;
  area.splitAt(id, key, where);
  chosen(key);
  announce(`Moved ${where === "bottom" ? "down" : where === "top" ? "up" : where}`);
  return true;
}
