import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import {
  DONE,
  ENTRY,
  expandSidebar,
  FIRST,
  nameOf,
  onBoard,
  openAgents,
  quiet,
  openTerminals,
  ready,
  saved,
  savedDock,
  seeded,
  SECOND,
  settle,
  shown,
  showQuiet,
  sidebarRow,
  TERMINAL_ON,
  terminal,
} from "../app-seam";
import mixed from "../fixtures/herdr/mixed.json";

ENTRY.path = "../App.tsx";

/**
 * The tab area of the whole app (`components/workspace.tsx`, `lib/dock.ts`) against the scripted herdr's `mixed` fixture.
 * A test of a terminal tab, or of a split whose companion is one, turns the terminal tab on (`TERMINAL_ON`; it is off by
 * default and `terminal-off.test.tsx` has the tab while off).
 */

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
  const app = await seeded("mixed", { storage: { ...TERMINAL_ON, "herdr.dock.v1": JSON.stringify(layout) } });
  await app.waitFor("label:Board, 2 need you");
  await settle(app);
  // The home holds the board and the stray; the payments pane moved to its project.
  expect(app.count("role:tab")).toBe(2);
  const doc = await savedDock(app);
  const [project] = Object.keys(doc.contexts);
  expect(doc.contexts[project].layout.center).toMatchObject({ children: [{ panels: ["terminal:local/w1:p1"] }] });
  expect(doc.strays).toEqual(["terminal:local/w9:p9"]);
  expect(app.storage()["herdr.dock.v1"]).toBeUndefined();

  await app.press("Agent gone");
  await settle(app);
  expect(app.shows("label:Close this tab")).toBe(true);
  await app.press("label:Close this tab");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows("Agent gone")).toBe(false);
  // The migrated tab is in its project, the terminal tab of the same pane. A restored tab never attaches by itself.
  await app.keyboard.press("mod+shift+]");
  await settle(app);
  expect(app.shows("text:Press Return to reconnect")).toBe(true);
  expect(shown(app, FIRST)).toBe(false);
});

test("an unreadable saved layout opens the board alone", async () => {
  const app = await seeded("mixed", { storage: { "herdr.dock.v1": "{{ not json" } });
  await app.waitFor("label:Board, 2 need you");
  expect(app.count("role:tab")).toBe(0);
  expect(onBoard(app)).toBe(true);
});

test("split on the board says there is none; on a tab that shares its group the tab moves into a new group beside it", async () => {
  const app = await ready();
  await app.keyboard.press("mod+\\");
  await app.clock!.runFor(700);
  expect(app.storage()["herdr.dock.v2"]).toBeUndefined();

  await openAgents(app, FIRST, SECOND);
  // SECOND is a terminal, where Ctrl+\\ is the program's: the keyboard leaves it first.
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+\\");
  const groups = await saved(app);
  expect(groups.map((g) => g.panels.map(nameOf))).toEqual([[FIRST], [SECOND]]);
});

test("split on a chat alone in its group opens its companion beside it, and never the same view twice", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openAgents(app, FIRST);
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([1]);
  await app.keyboard.press("mod+\\");
  await settle(app);
  const [chat, other] = await saved(app);
  // The fixture's folder is no git repository, so the companion is the terminal of the same pane.
  expect(chat.panels[0]).toMatch(/^session:/);
  expect(other.panels[0]).toMatch(/^terminal:/);
  expect(nameOf(chat.panels[0])).toBe(FIRST);
  expect(nameOf(other.panels[0])).toBe(FIRST);

  // From the terminal the companion is the chat, which is open: it is shown, no third group appears. (Ctrl+\\ is the
  // terminal's own, so the keyboard leaves it first.)
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+\\");
  await settle(app);
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([1, 1]);
});

test("Review changes opens beside the chat in front, and shows the same Changes tab again instead of opening another", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await app.keyboard.press("mod+shift+g");
  await settle(app);
  const [chat, changes] = await saved(app);
  expect(chat.panels.map(nameOf)).toEqual([FIRST]);
  expect(changes.panels[0]).toMatch(/^changes:/);

  await app.keyboard.press("mod+shift+g");
  await settle(app);
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([1, 1]);
});

test("the chat's Open beside button, a row's Open to the side and the palette's Merge splits make and close splits without a key", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openAgents(app, FIRST);
  await app.press("label:Open beside");
  await settle(app);
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([1, 1]);

  await app.keyboard.press("mod+shift+l");
  await app.type("label:Search agents, projects and commands", "Merge splits");
  await app.press("label:Merge splits");
  await settle(app);
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([2]);

  await app.rightClick(sidebarRow(DONE));
  await app.chooseMenuItem("Open to the side");
  await settle(app);
  const groups = await saved(app);
  expect(groups).toHaveLength(2);
  expect(groups.flatMap((g) => g.panels.map(nameOf))).toContain(DONE);
});

test("in a narrow window Review changes stays a tab of the chat's group: one view at a time", async () => {
  const app = await seeded("mixed", { width: 800 });
  await app.waitFor("label:Board, 2 need you");
  await quiet(app);
  await openAgents(app, FIRST);
  await app.keyboard.press("mod+shift+g");
  await settle(app);
  const groups = await saved(app);
  expect(groups).toHaveLength(1);
  expect(groups[0].panels).toHaveLength(2);
});

test("every drag has a command: move the tab to another group, down, and back, from the palette", async () => {
  const app = await ready();
  const run = async (command: string) => {
    await app.keyboard.press("mod+shift+l");
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
  await app.keyboard.press("mod+shift+l");
  await app.type("label:Search agents, projects and commands", "Close pane in herdr");
  await app.press("label:/^Close pane in herdr…/");
  await settle(app);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(FIRST);
  expect(Herdr.testRequests("pane.close")).toEqual([]);
  expect(app.count("role:tab")).toBe(0);
});

test("closing a pane in herdr, once confirmed, closes the pane and removes its tab", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  app.onDialog(() => "Close pane");
  await app.keyboard.press("mod+shift+l");
  await app.type("label:Search agents, projects and commands", "Close pane in herdr");
  await app.press("label:/^Close pane in herdr…/");
  await app.waitUntil(() => Herdr.testRequests("pane.close").length === 1);
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
});

test("a pane that herdr drops while its tab is open leaves a tab that says so and can be closed", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
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
  // `mod+shift+l`: from a terminal tab `mod+p` is the program's, and this one is the app's everywhere.
  await app.keyboard.press("mod+shift+l");
  await app.type("label:Search agents, projects and commands", command);
  // The terminal's own `Show chat` button has the same name as the palette's row, which comes second.
  await app.press(command === "Show chat" ? `label:${command} >> nth=1` : `label:${command}`);
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
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await app.keyboard.press("mod+shift+l");
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
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openAgents(app, FIRST);
  expect(app.count("role:tab")).toBe(0);
  expect(shown(app, FIRST)).toBe(false);
  expect(app.shows("label:Show terminal")).toBe(true);

  await app.press("label:Show terminal");
  await settle(app);
  expect(shown(app, FIRST)).toBe(true);
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows("label:Show terminal")).toBe(false);

  await palette(app, "Show chat");
  expect(shown(app, FIRST)).toBe(false);
  expect(app.shows("label:Show terminal")).toBe(true);
  expect(app.count("role:tab")).toBe(0);
  const [group] = await saved(app);
  expect(group.panels.map((p) => (p === "board" ? p : nameOf(p)))).toEqual([FIRST]);
});

test("a terminal agent that was shown as a terminal opens as one again until Show chat", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST);
  await app.keyboard.press("mod+w");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  await openAgents(app, FIRST);
  await app.waitFor(terminal(FIRST));
});

test("a terminal agent whose log can be read has Show chat in its header and it swaps the tab for the chat; one that cannot has no such button", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST);
  await app.waitFor(terminal(FIRST));
  expect(app.shows("label:Show chat")).toBe(true);
  await app.press("label:Show chat >> nth=0");
  await settle(app);
  expect(shown(app, FIRST)).toBe(false);
  expect(app.shows("label:Show terminal")).toBe(true);
  expect(app.count("role:tab")).toBe(0);

  // pi has no log this app can read as a conversation: its terminal is the only view.
  await showQuiet(app, sidebarRow("notes"));
  await app.press(sidebarRow("notes"));
  await settle(app);
  expect(shown(app, "notes")).toBe(true);
  expect(app.shows("label:Show chat")).toBe(false);
});

test("a project's menu and the chat's header open the Changes tab of the checkout they are about", async () => {
  const app = await ready();
  await expandSidebar(app);
  await showQuiet(app, "label:Options for web");
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
