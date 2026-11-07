import { open } from "nsh/test";
import type { App } from "nsh/test";
import type { DockAreaLayout } from "nsh/base";

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
export function seeded(name: "mixed" | "storm" | "empty", extra: NonNullable<Opened> = {}): Promise<App> {
  return open(ENTRY.path, { ...DESKTOP, platform: "linux", clock: {}, ...extra, host: { params: { fixture: name } } });
}

/** The agents of the `mixed` fixture the app tests use: two need you, one is to review. */
export const FIRST = "payments review";
export const SECOND = "auth";
export const DONE = "Fix login flow";

/** The `mixed` fixture's agents by pane id, for reading a saved layout. */
const NAME: Record<string, string> = { "w1:p1": FIRST, "w1:p2": SECOND, "w1:p3": DONE, "w1:p4": "Refactor ledger", "w1:p5": "upgrade deps" };
export const nameOf = (panel: string): string => NAME[panel.slice(panel.indexOf("/") + 1)];

/** The mirror of an agent's pane, which is on screen only while its tab is the displayed one. */
export const terminal = (name: string): string => `label:Terminal, ${name} on This computer`;
/** An agent's row in the sidebar (the board's card has the same name, and comes later in the tree). */
export const sidebarRow = (name: string): string => `label:/^${name}, / >> nth=0`;
export const shown = (app: App, name: string): boolean => app.shows(terminal(name));
export const onBoard = (app: App): boolean => app.shows("Answer one by one");
export const settle = (app: App): Promise<void> => app.clock!.runFor(400);

/** The `mixed` fixture, once its board has arrived. */
export async function ready(platform?: "macos" | "windows" | "linux"): Promise<App> {
  const app = await seeded("mixed", platform ? { platform } : {});
  await app.waitFor("label:Board, 2 need you");
  return app;
}

/** Opens these agents' tabs from the sidebar, in order. */
export async function openAgents(app: App, ...names: string[]): Promise<void> {
  for (const name of names) await app.press(sidebarRow(name));
  await settle(app);
}

/** One tab group of the saved layout: its tabs in order and the displayed one. */
export interface SavedGroup {
  panels: string[];
  active: number;
}

/** The groups of the layout the app saved once its edits went quiet. */
export async function saved(app: App): Promise<SavedGroup[]> {
  await app.clock!.runFor(700);
  const out: SavedGroup[] = [];
  const walk = (node: DockAreaLayout["center"]) => {
    if (node.type === "tabs") out.push({ panels: node.panels, active: node.activeIndex ?? 0 });
    else node.children.forEach(walk);
  };
  walk((JSON.parse(app.storage()["herdr.dock.v1"]) as DockAreaLayout).center);
  return out;
}
