import { Herdr } from "herdr-desktop/native";
import { open } from "nsh/test";

import type { DockAreaLayout } from "nsh/base";
import type { App } from "nsh/test";

/** 1280 x 800: a desktop window, wide enough for the full sidebar. */
export const DESKTOP = { width: 1280, height: 800 };

type Opened = Parameters<typeof open>[1];

/** `open` resolves its entry from the test file that calls it: a test beside `App.tsx` leaves this alone, one under `components/` sets `../App.tsx`. */
export const ENTRY = { path: "./App.tsx" };

/**
 * Opens the whole app against a scripted herdr (`fixtures/herdr/<name>.json`). The fixture reaches the engine through
 * `host.params` (`App.tsx` reads it); the Rust side honours it only while `HERDR_DESKTOP_TEST=1`. Starts on Linux with a
 * manual clock, so the 400 ms guard, the 4 s armed window and the layout's quiet period move only as a test moves them.
 */
export function seeded(name: "mixed" | "storm" | "empty" | "projects", extra: NonNullable<Opened> = {}): Promise<App> {
  return open(ENTRY.path, { ...DESKTOP, platform: "linux", clock: {}, ...extra, host: { params: { fixture: name } } });
}

/** The agents of the `mixed` fixture the app tests use: two need you, one is to review. */
export const FIRST = "payments review";
export const SECOND = "auth";
export const DONE = "Fix login flow";
/** An agent of the other project (`web`; the five above are `payments`). */
export const WEB = "Styling pass";

/** The `mixed` fixture's agents by pane id, for reading a saved layout. */
const NAME: Record<string, string> = {
  "w1:p1": FIRST,
  "w1:p2": SECOND,
  "w1:p3": DONE,
  "w1:p4": "Refactor ledger",
  "w1:p5": "upgrade deps",
  "w2:p1": "Styling pass",
  "w2:p2": "notes",
  "w2:p3": "scripts",
};
export const nameOf = (panel: string): string => NAME[panel.slice(panel.indexOf("/") + 1).replace(/^pane:/, "")];

/** The mirror of an agent's pane, which is on screen only while its tab is the displayed one. */
export const terminal = (name: string): string => `label:Terminal, ${name} on This computer`;
/** An agent's row in the sidebar (the board's card has the same name, and comes later in the tree). */
export const sidebarRow = (name: string): string => `label:/^${name}, / >> nth=0`;
export const shown = (app: App, name: string): boolean => app.shows(terminal(name));
export const onBoard = (app: App): boolean => app.shows("label:Projects");
export const settle = (app: App): Promise<void> => app.clock!.runFor(400);

/** A chat whose session is open: the message box is there and takes text (while the agent opens it, the box is off). */
export async function chatReady(app: App): Promise<void> {
  await app.waitFor("label:Message");
  await app.waitUntil(() => app.enabled("label:Message"));
}

/**
 * Waits until the engine has finished its start-up reads, then lets the app draw what they changed. The board appears
 * with the first snapshot, but the engine goes on reading every agent's pane (`pane.read`, one per agent row) from its
 * own thread and each answer is one more revision that re-pulls the board and re-renders the lists. A press resolved in
 * between lands on a row that is replaced a moment later (the view ids of a failing run differ from a passing one's),
 * which is what made presses right after `ready()` flaky under load. The reads are counted in the scripted herdr's
 * request log, so this waits for a fact, never for a duration: the clock only moves while it waits.
 */
export async function quiet(app: App): Promise<void> {
  const reads = () => Herdr.testRequests("pane.read").length;
  const rows = () => Herdr.board().projects.reduce((n, p) => n + p.rows.length, 0);
  // `revision` is 0 until the first snapshot (a board with no agents has no reads to wait for).
  await app.waitUntil(() => Herdr.board().revision > 0 && reads() >= rows(), { timeout: 10_000 });
  // The last answer's revision and the draw it causes come after the request is logged.
  await app.clock!.runFor(300);
}

/**
 * Saved settings with the terminal tab on (`terminalEnabled`, off by default): for a test of the terminal tab itself, as
 * `storage` (merge it with any other saved document the test seeds).
 */
export const TERMINAL_ON: Record<string, string> = { "herdr.settings.v1": JSON.stringify({ terminalEnabled: true }) };

/** The `mixed` fixture, once its board has arrived and the engine is done reading; `extra` seeds storage and the like. */
export async function ready(platform?: "macos" | "windows" | "linux", extra: NonNullable<Opened> = {}): Promise<App> {
  const app = await seeded("mixed", platform ? { ...extra, platform } : extra);
  await app.waitFor("label:Board, 2 need you");
  await quiet(app);
  return app;
}

/**
 * Presses `selector` until `done` holds (a selector that shows, or a condition for a result no selector names), then
 * waits for it. A press that took is not repeated: the repeat is only for a press the headless harness lost or aimed at
 * a row that moved. Each repeat runs the clock, never the real time.
 */
export async function pressSettled(app: App, selector: string, done: string | (() => boolean)): Promise<void> {
  const holds = typeof done === "string" ? () => app.shows(done) : done;
  for (let attempt = 0; attempt < 5 && !holds(); attempt++) {
    await app.press(selector);
    await app.clock!.runFor(300);
  }
  await app.waitUntil(holds);
}

/** The app opens on the Board, where the sidebar is the rail: this brings back the list of projects and agents for the visit. */
export const expandSidebar = (app: App): Promise<void> =>
  pressSettled(app, "label:Expand sidebar", "label:Search projects");

/**
 * Opens these agents' terminal tabs: the sidebar opens the chat of an agent that has one, so each is opened and then
 * switched with `Show terminal` (an agent already shown as a terminal this run needs no switch). Needs the terminal tab on
 * (`TERMINAL_ON`): off, there is no `Show terminal` to press.
 */
export async function openTerminals(app: App, ...names: string[]): Promise<void> {
  for (const name of names) {
    await app.press(sidebarRow(name));
    await settle(app);
    // A chat opens when the session's first read arrives (real time): wait for its button. An agent already shown as a terminal
    // this run, or one with no chat, opens as the terminal at once.
    await app.waitUntil(() => app.shows("label:Show terminal") || app.shows(terminal(name)));
    if (app.shows("label:Show terminal")) await app.press("label:Show terminal");
    await settle(app);
  }
}

/** The agent whose tab is displayed in the first group of the context shown (`board` for the board, empty for a project with no tab), whichever view of it is open: read from the saved layout. */
export async function front(app: App): Promise<string> {
  const [group] = await saved(app);
  if (!group) return "";
  const panel = group.panels[group.active];
  return panel === "board" ? panel : nameOf(panel);
}

/** Opens these agents' tabs from the sidebar, in order: each opens in its default view (a chat for omp, Claude Code and Codex). */
export async function openAgents(app: App, ...names: string[]): Promise<void> {
  for (const name of names) await app.press(sidebarRow(name));
  await settle(app);
}

/** One tab group of the saved layout: its tabs in order and the displayed one. */
export interface SavedGroup {
  panels: string[];
  active: number;
}

/** The saved document of the layouts (`herdr.dock.v2`) once its edits went quiet. */
export async function savedDock(app: App): Promise<SavedDock> {
  await app.clock!.runFor(700);
  return JSON.parse(app.storage()["herdr.dock.v2"]) as SavedDock;
}

/** What the app saves: the context shown, the home and the projects' layouts, the panels waiting for their project. */
export interface SavedDock {
  v: 2;
  current: string;
  home: { layout: DockAreaLayout; focused: string };
  contexts: Record<string, { layout: DockAreaLayout; focused: string; savedAt: number }>;
  strays: string[];
}

/** The groups of a saved layout: the context shown, or the one named. */
export function groupsOf(layout: DockAreaLayout): SavedGroup[] {
  const out: SavedGroup[] = [];
  const walk = (node: DockAreaLayout["center"]) => {
    if (node.type === "tabs") out.push({ panels: node.panels, active: node.activeIndex ?? 0 });
    else node.children.forEach(walk);
  };
  walk(layout.center);
  return out;
}

/** The groups of the layout of the context shown, as the app saved it once its edits went quiet. */
export async function saved(app: App): Promise<SavedGroup[]> {
  const doc = await savedDock(app);
  return groupsOf(doc.current === "home" ? doc.home.layout : doc.contexts[doc.current].layout);
}
