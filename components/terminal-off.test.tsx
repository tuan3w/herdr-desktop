import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import { ENTRY, FIRST, openAgents, pressSettled, ready, saved, seeded, settle, terminal } from "../app-seam";

ENTRY.path = "../App.tsx";

/**
 * The terminal tab while it is off in Settings (`terminalEnabled`, the default for now): with one open, switching to the
 * Board could send nsh's reactive runtime into a loop, so nothing offers a terminal and a terminal tab never mounts the
 * native `Terminal` (`components/terminal-off.tsx`). The tab while on is `terminal-tab.test.tsx`'s.
 */
const ECHO = "printf 'agent ready\\n'; exec cat";
/** An agent of the `mixed` fixture whose log cannot be read as a chat (a `pi` pane): it opens as its terminal tab. */
const SHELL = "notes";
const OFF_LINE = "text:This agent has no chat here. Open it in your terminal:";
/** Any native terminal view: its own label (`Terminal, <agent> on <machine>`) and its input's. */
const mounted = (app: App) => app.shows("label:/^Terminal, /") || app.shows("label:/^Terminal input, /");

test("off, an agent with no chat opens a tab that says how to open it in your terminal and mounts no terminal", async () => {
  const app = await ready();
  Herdr.testSetProgram(ECHO);
  await openAgents(app, SHELL);
  await app.waitFor(OFF_LINE);
  // The exact command, selectable, and a Copy beside it.
  expect(app.texts()).toContain("herdr");
  expect(app.shows("label:Copy command")).toBe(true);
  expect(app.shows("label:Turn on the terminal tab")).toBe(true);
  await settle(app);
  expect(mounted(app)).toBe(false);
  expect(app.shows(terminal(SHELL))).toBe(false);
  expect(app.shows("text:agent ready")).toBe(false);
  // Nothing touched herdr for it: no pointing at the pane, no zoom.
  expect(Herdr.testRequests("pane.focus")).toEqual([]);
  expect(Herdr.testRequests("pane.zoom")).toEqual([]);
  // Return does not attach anything.
  await app.keyboard.press("enter");
  await settle(app);
  expect(mounted(app)).toBe(false);
});

test("turning the terminal tab on from that tab never attaches by itself: it asks for Return first", async () => {
  const app = await ready();
  Herdr.testSetProgram(ECHO);
  await openAgents(app, SHELL);
  await app.waitFor(OFF_LINE);
  await app.press("label:Turn on the terminal tab");
  await app.waitFor("text:Press Return to reconnect");
  expect(app.shows("text:agent ready")).toBe(false);
  expect(Herdr.testRequests("pane.focus")).toEqual([]);
  await app.press("label:/^Reconnect to /");
  await app.waitFor("text:agent ready");
  expect(Herdr.testRequests("pane.focus").length).toBe(1);
});

test("off, a terminal tab restored from the saved layout shows the same state and mounts no terminal", async () => {
  const layout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [{ type: "tabs", panels: ["board", "terminal:local/w1:p1"], activeIndex: 1 }],
    },
  };
  const app = await seeded("mixed", { storage: { "herdr.dock.v1": JSON.stringify(layout) } });
  await app.waitFor("label:Board, 2 need you");
  Herdr.testSetProgram(ECHO);
  await app.keyboard.press("mod+shift+]");
  // This agent has a chat, so the tab offers it beside the command.
  await app.waitFor("text:The terminal tab is off. Read this agent as a chat, or open it in your terminal:");
  expect(app.shows("text:Press Return to reconnect")).toBe(false);
  await app.keyboard.press("enter");
  await settle(app);
  expect(mounted(app)).toBe(false);
  expect(Herdr.testRequests("pane.focus")).toEqual([]);
  await pressSettled(app, "label:Show chat", "label:Answer");
});

test("off, a chat has no Terminal button and the terminal's key opens nothing; on, the button is back", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await app.waitFor("label:Answer");
  expect(app.shows("label:Show terminal")).toBe(false);
  const before = app.count("role:tab");
  await app.keyboard.press("mod+shift+m");
  await settle(app);
  expect(app.count("role:tab")).toBe(before);
  const [group] = await saved(app);
  expect(group.panels.some((p) => p.startsWith("terminal:"))).toBe(false);
  expect(mounted(app)).toBe(false);
  // Turned on in Settings, the same chat has the button again.
  await pressSettled(app, "label:Settings", "label:Settings sections");
  await app.press("label:Terminal tab (experimental)");
  await pressSettled(app, "label:Close settings", () => !app.shows("label:Settings sections"));
  await app.waitFor("label:Show terminal");
});

test("off, the palette offers no Show terminal", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await app.waitFor("label:Answer");
  await app.keyboard.press("mod+p");
  await app.waitFor("label:Search agents, projects and commands");
  await app.type("label:Search agents, projects and commands", "show terminal");
  await settle(app);
  expect(app.texts().includes("Show terminal")).toBe(false);
});
