import { announce, signal, Storage } from "nsh";
import type { DockAreaLayout, DockAreaRef, DockNode, Placement } from "nsh/base";
import { focusComposer, paneInFront } from "./pane-input";
import { save } from "./save";

/**
 * The workspace's layout and the commands that change it. `components/workspace.tsx` renders the `DockArea` from this
 * state; the palette, the menu and the keys call the functions here. The pure part (key names, reading a saved layout,
 * walking groups) is tested without a window in `dock.test.ts`.
 *
 * Panel keys: `board` (the home tab, never closable), `pane:<machine>/<paneId>` (a terminal pane mirrored) and
 * `session:<machine>/<id>` (a chat: an agent session of a keeper, or, with the id `pane:<paneId>`, the chat read from
 * the log of the agent in that terminal pane). A tab is a view: closing it never closes the pane or the session.
 */
export const BOARD = "board";
export const STORAGE_KEY = "herdr.dock.v1";
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
  return chat.id.startsWith(PANE) ? `${chat.machine}/${chat.id.slice(PANE.length)}` : `${chat.machine}/session:${chat.id}`;
}

const validKey = (key: unknown): key is string => typeof key === "string" && (key === BOARD || parsePaneKey(key) !== null || parseSessionKey(key) !== null);

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
export const groupOf = (layout: DockAreaLayout, key: string): Group | undefined => groups(layout).find((g) => g.panels.includes(key));

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
    const active = typeof n.activeIndex === "number" && n.activeIndex >= 0 && n.activeIndex < panels.length ? n.activeIndex : 0;
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

/**
 * The layout saved last session, made safe to show: unknown panels and repeats are dropped, empty groups go, and the
 * board is always there (put back at the front of the first group when the file lost it). Anything unreadable gives the
 * default layout. Only the center is kept: this app has no docks.
 */
export function readLayout(raw: string | null | undefined): DockAreaLayout {
  if (!raw) return defaultLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultLayout();
  }
  const center = typeof parsed === "object" && parsed !== null && "center" in parsed ? clean(parsed.center, new Set()) : null;
  if (!center) return defaultLayout();
  const root: DockNode = center.type === "split" ? center : { type: "split", axis: "horizontal", children: [center] };
  const layout: DockAreaLayout = { center: root };
  if (!panelsOf(layout).includes(BOARD)) {
    const first = groups(layout)[0];
    const put = (node: DockNode): boolean => {
      if (node.type === "tabs") {
        node.panels.unshift(BOARD);
        node.activeIndex = (node.activeIndex ?? 0) + 1;
        return true;
      }
      return node.children.some(put);
    };
    if (first) put(layout.center);
  }
  return layout;
}

// ---- state ----

/** The layout shown, as the area last reported it. */
export const layout = signal<DockAreaLayout>(defaultLayout());
/** Whether the saved layout has been read: the workspace mounts after, so it never shows the default and then jumps. */
export const dockReady = signal(false);
/**
 * The panel the person is working in: the one most recently opened, selected by a key or a click, or moved. Tab
 * shortcuts, close, split and `capture` act on it. The area does not report a click on the tab that is already
 * displayed, so a click on a displayed tab of another group does not move it: select it or use `focusPane`.
 */
export const focused = signal<string>(BOARD);
/** The agent tab (pane or chat) used last: where `focusPane` goes from the board. */
export const lastPane = signal<string | null>(null);

let area: DockAreaRef | undefined;
let timer: number | undefined;

/** The workspace hands over its area when it mounts and `undefined` when it goes. */
export function attach(ref: DockAreaRef | undefined): void {
  area = ref;
}

/** Reads the saved layout once; a storage failure leaves the default. */
export async function loadDock(): Promise<void> {
  try {
    layout.set(readLayout(await Storage.getItem(STORAGE_KEY)));
  } catch (e) {
    console.error("herdr-desktop: cannot read the dock layout", e);
  }
  dockReady.set(true);
}

/** The area reported a new layout: show it and write it once the edits stop. */
export function setLayout(next: DockAreaLayout): void {
  layout.set(next);
  if (!panelsOf(next).includes(focused())) focused.set(BOARD);
  clearTimeout(timer);
  timer = setTimeout(() => save(STORAGE_KEY, JSON.stringify(layout())), SAVE_DELAY_MS);
}

/** The panel a command just put the person in, for the instant its edit takes to report. */
let pin: { key: string; at: number } | undefined;
/** How long after a command the area's own "displayed tab changed" reports are not the person's choice. */
const PIN_MS = 150;

function focus(key: string): void {
  focused.set(key);
  if (key !== BOARD) lastPane.set(key);
}

/**
 * A panel is now displayed in its group, which is where the person is working: a click on a tab, or a command. One edit
 * can display several panels at once (a tab leaves a group, which then shows its next one), so for an instant after a
 * command only the panel the command chose counts.
 */
export function activated(key: string): void {
  if (pin && pin.key !== key && Date.now() - pin.at < PIN_MS) return;
  focus(key);
}

/** A command made `key` the working panel. */
function chosen(key: string): void {
  pin = { key, at: Date.now() };
  focus(key);
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

// ---- commands ----

/** Opens a panel: displays it where it is, else adds it to the focused group; either way it becomes the focused one. */
export async function openPanel(key: string): Promise<void> {
  if (!area) return;
  if (panelsOf(layout()).includes(key)) {
    area.selectPanel(key);
  } else {
    const home = groupOf(layout(), focused());
    const id = home?.id ?? (await area.groupOf(focused())) ?? undefined;
    if (id === undefined) area.addPanel(key);
    else area.movePanel(key, { group: id });
  }
  chosen(key);
}

/** Opens a chat's tab (`id` is a keeper session's, or `pane:<paneId>` for a terminal agent read from its log); the tab attaches itself. */
export const openSession = (machine: string, id: string): Promise<void> => openPanel(sessionKey(machine, id));

/** Opens a pane's tab; `reply` (the board's `Reply…`) also puts the keyboard in its message box. */
export async function openPane(machine: string, pane: string, options?: { reply?: boolean }): Promise<void> {
  await openPanel(paneKey(machine, pane));
  if (!options?.reply) return;
  // The tab of a pane that was not open is rendered a moment after it is added, and the one in front now is the one
  // the person just left: wait a tick for it to go, then for the new one to register.
  await later(0);
  for (let tries = 0; tries < 60 && !paneInFront(); tries++) await later(16);
  focusComposer();
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const showBoard = (): Promise<void> => openPanel(BOARD);

/** Closes a tab as a person closes a view: the pane keeps running. The board stays. */
export function closeTab(key: string): void {
  if (key !== BOARD) area?.closePanel(key);
}

/** Removes a panel whatever its options say: a tab whose pane was closed in herdr, or the `Agent gone` placeholder's `Close`. */
export function removePanel(key: string): void {
  area?.removePanel(key);
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
