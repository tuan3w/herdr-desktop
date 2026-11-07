import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import {
  DONE,
  ENTRY,
  FIRST,
  nameOf,
  onBoard,
  openAgents,
  openTerminals,
  ready,
  saved,
  savedDock,
  seeded,
  SECOND,
  settle,
  shown,
  sidebarRow,
} from "../app-seam";
import mixed from "../fixtures/herdr/mixed.json";

ENTRY.path = "../App.tsx";

/** The tab area of the whole app (`components/workspace.tsx`, `lib/dock.ts`) against the scripted herdr's `mixed` fixture. */

test("the layout is saved once the edits go quiet, not on every one", async () => {
  const app = await ready();
  await app.press(sidebarRow(FIRST));
  await app.clock!.runFor(300);
  expect(app.storage()["herdr.dock.v2"]).toBeUndefined();
  // A second edit restarts the quiet time: 300 ms after it the first one's 500 ms are long over, and still nothing is written.
  await app.press(sidebarRow(SECOND));
  await app.clock!.runFor(300);
  expect(app.storage()["herdr.dock.v2"]).toBeUndefined();
  const [group] = await saved(app);
  expect(group.panels.map(nameOf)).toEqual([FIRST, SECOND]);
});

test("a layout saved by the first version is split by project: each project keeps its tabs, a tab for a pane herdr no longer has stays home and can be closed", async () => {
  const layout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [{ type: "tabs", panels: ["board", "pane:local/w1:p1", "pane:local/w9:p9"], activeIndex: 1 }],
    },
  };
  const app = await seeded("mixed", { storage: { "herdr.dock.v1": JSON.stringify(layout) } });
  await app.waitFor("label:Board, 2 need you");
  await settle(app);
  // The home holds the board and the stray; the payments pane moved to its project.
  expect(app.count("role:tab")).toBe(2);
  const doc = await savedDock(app);
  const [project] = Object.keys(doc.contexts);
  expect(doc.contexts[project].layout.center).toMatchObject({ children: [{ panels: ["pane:local/w1:p1"] }] });
  expect(doc.strays).toEqual(["pane:local/w9:p9"]);
  expect(app.storage()["herdr.dock.v1"]).toBeUndefined();

  await app.press("Agent gone");
  await settle(app);
  expect(app.shows("label:Close this tab")).toBe(true);
  await app.press("label:Close this tab");
  await settle(app);
  expect(app.count("role:tab")).toBe(1);
  expect(app.shows("Agent gone")).toBe(false);
  // The migrated tab is in its project, a fresh mirror of the same pane.
  await app.keyboard.press("mod+shift+]");
  await settle(app);
  expect(shown(app, FIRST)).toBe(true);
});

test("an unreadable saved layout opens the board alone", async () => {
  const app = await seeded("mixed", { storage: { "herdr.dock.v1": "{{ not json" } });
  await app.waitFor("label:Board, 2 need you");
  expect(app.count("role:tab")).toBe(1);
  expect(onBoard(app)).toBe(true);
});

test("a tab that is alone in its group cannot split away; with a second tab it moves into a new group beside it", async () => {
  const app = await ready();
  await app.keyboard.press("mod+\\");
  await app.clock!.runFor(700);
  expect(app.storage()["herdr.dock.v2"]).toBeUndefined();

  await openAgents(app, FIRST);
  await app.keyboard.press("mod+\\");
  await app.clock!.runFor(700);
  expect((await saved(app)).map((g) => g.panels)).toHaveLength(1);

  await openAgents(app, SECOND);
  await app.keyboard.press("mod+\\");
  const groups = await saved(app);
  expect(groups.map((g) => g.panels.map(nameOf))).toEqual([[FIRST], [SECOND]]);
});

test("every drag has a command: move the tab to another group, down, and back, from the palette", async () => {
  const app = await ready();
  const run = async (command: string) => {
    await app.keyboard.press("mod+k");
    await app.type("label:Search agents, projects and commands", command);
    await app.press(`label:${command}`);
    await settle(app);
  };
  await openAgents(app, FIRST, SECOND);
  await run("Move tab to split down");
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([1, 1]);
  await run("Move tab to other group");
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([2]);
});

test("closing a pane in herdr asks first, and says what it will stop", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  const asked: string[] = [];
  app.onDialog((d) => {
    asked.push(`${d.title} | ${d.message}`);
    return "Cancel";
  });
  await app.keyboard.press("mod+k");
  await app.type("label:Search agents, projects and commands", "Close pane in herdr");
  await app.press("label:/^Close pane in herdr…/");
  await settle(app);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(FIRST);
  expect(Herdr.testRequests("pane.close")).toEqual([]);
  expect(app.count("role:tab")).toBe(1);
});

test("closing a pane in herdr, once confirmed, closes the pane and removes its tab", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  app.onDialog(() => "Close pane");
  await app.keyboard.press("mod+k");
  await app.type("label:Search agents, projects and commands", "Close pane in herdr");
  await app.press("label:/^Close pane in herdr…/");
  await app.waitUntil(() => Herdr.testRequests("pane.close").length === 1);
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
});

test("a pane that herdr drops while its tab is open leaves a tab that says so and can be closed", async () => {
  const app = await ready();
  await openTerminals(app, DONE);
  const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
  snapshot.panes = snapshot.panes.filter((p) => p.pane_id !== "w1:p3");
  snapshot.agents = snapshot.agents.filter((a) => a.pane_id !== "w1:p3");
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({ event: "pane_closed", data: { pane_id: "w1:p3" } });
  await app.waitFor("label:Close this tab");
  expect(shown(app, DONE)).toBe(false);
  await app.press("label:Close this tab");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
});

async function palette(app: App, command: string) {
  await app.keyboard.press("mod+k");
  await app.type("label:Search agents, projects and commands", command);
  await app.press(`label:${command}`);
  await settle(app);
}

test("renaming the pane in front from the palette asks for a name, starting from the current one, and sends the new one", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await palette(app, "Rename pane…");
  expect(app.value("label:Name *")).toBe(FIRST);
  await app.clear("label:Name *");
  await app.type("label:Name *", "release check");
  await app.press("text:Rename");
  await app.waitUntil(() => Herdr.testRequests("pane.rename").length === 1);
  expect(JSON.stringify(Herdr.testRequests("pane.rename")[0].params)).toContain("release check");
});

test("pane commands are dimmed on the board, where there is no pane to act on", async () => {
  const app = await ready();
  await app.keyboard.press("mod+k");
  // The palette lists as many commands as fit: a search brings the one asked for into view.
  await app.type("label:Search agents, projects and commands", "pane");
  expect(app.enabled("label:/^Rename pane…/")).toBe(false);
  expect(app.enabled("label:/^Close pane in herdr…/")).toBe(false);
  expect(app.enabled("label:/^Show terminal/")).toBe(false);
  await app.clear("label:Search agents, projects and commands");
  await app.type("label:Search agents, projects and commands", "workspace");
  expect(app.enabled("label:/^New workspace…/")).toBe(true);
});

test("a new workspace from the palette asks for a name and is created in herdr under it", async () => {
  const app = await ready();
  await palette(app, "New workspace…");
  await app.type("label:Name *", "scratch");
  await app.press("text:Create");
  await app.waitUntil(() => Herdr.testRequests("workspace.create").length === 1);
  expect(JSON.stringify(Herdr.testRequests("workspace.create")[0].params)).toContain("scratch");
});

test("an agent with a chat opens as a chat; Show terminal swaps the tab for its terminal in place and Show chat swaps it back", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  expect(app.count("role:tab")).toBe(1);
  expect(shown(app, FIRST)).toBe(false);
  expect(app.texts().includes("Show terminal")).toBe(true);

  await app.press("Show terminal");
  await settle(app);
  expect(shown(app, FIRST)).toBe(true);
  expect(app.count("role:tab")).toBe(1);
  expect(app.texts().includes("Show terminal")).toBe(false);

  await palette(app, "Show chat");
  expect(shown(app, FIRST)).toBe(false);
  expect(app.texts().includes("Show terminal")).toBe(true);
  expect(app.count("role:tab")).toBe(1);
  const [group] = await saved(app);
  expect(group.panels.map((p) => (p === "board" ? p : nameOf(p)))).toEqual([FIRST]);
});

test("a terminal agent that was shown as a terminal opens as one again until Show chat", async () => {
  const app = await ready();
  await openTerminals(app, FIRST);
  await app.keyboard.press("mod+w");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  await openAgents(app, FIRST);
  expect(shown(app, FIRST)).toBe(true);
});

test("a terminal agent whose log can be read has Show chat in its header and it swaps the tab for the chat; one that cannot has no such button", async () => {
  const app = await ready();
  await openTerminals(app, FIRST);
  expect(shown(app, FIRST)).toBe(true);
  expect(app.texts().includes("Show chat")).toBe(true);
  await app.press("Show chat");
  await settle(app);
  expect(shown(app, FIRST)).toBe(false);
  expect(app.texts().includes("Show terminal")).toBe(true);
  expect(app.count("role:tab")).toBe(1);

  // pi has no log this app can read as a conversation: its terminal is the only view.
  await app.press(sidebarRow("notes"));
  await settle(app);
  expect(shown(app, "notes")).toBe(true);
  expect(app.texts().includes("Show chat")).toBe(false);
});

test("a project's menu and the chat's header open the Changes tab of the checkout they are about", async () => {
  const app = await ready();
  await app.press("label:Options for web");
  await app.clock!.runFor(300);
  // `web` holds agents in three folders, so its menu names each; a project with one checkout says `Review changes`.
  await app.press("text:Review changes in web");
  await settle(app);
  expect(app.shows("label:/^Changes in /")).toBe(true);

  // A chat names the same place: its header has a `Changes` chip.
  // (An agent that is not waiting: a waiting one shows the answer dock where the message box would be.)
  await openAgents(app, DONE);
  await app.waitFor("label:Message");
  await settle(app);
  await app.press("label:Changes");
  await settle(app);
  expect(app.shows("label:/^Changes in /")).toBe(true);
});
