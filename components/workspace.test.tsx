import { expect, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import mixed from "../fixtures/herdr/mixed.json";
import { DONE, ENTRY, FIRST, nameOf, onBoard, openAgents, ready, saved, seeded, SECOND, settle, shown, sidebarRow } from "../app-seam";

ENTRY.path = "../App.tsx";

/** The tab area of the whole app (`components/workspace.tsx`, `lib/dock.ts`) against the scripted herdr's `mixed` fixture. */

test("the layout is saved once the edits go quiet, not on every one", async () => {
  const app = await ready();
  await app.press(sidebarRow(FIRST));
  await app.clock!.runFor(300);
  expect(app.storage()["herdr.dock.v1"]).toBeUndefined();
  // A second edit restarts the quiet time: 300 ms after it the first one's 500 ms are long over, and still nothing is written.
  await app.press(sidebarRow(SECOND));
  await app.clock!.runFor(300);
  expect(app.storage()["herdr.dock.v1"]).toBeUndefined();
  const [group] = await saved(app);
  expect(group.panels.map(nameOf).slice(1)).toEqual([FIRST, SECOND]);
});


test("the next start has the same tabs, and a tab for a pane herdr no longer has says so and can be closed", async () => {
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
  expect(app.count("role:tab")).toBe(3);
  expect(shown(app, FIRST)).toBe(true);

  await app.press("Agent gone");
  await settle(app);
  expect(app.shows("label:Close this tab")).toBe(true);
  await app.press("label:Close this tab");
  await settle(app);
  expect(app.count("role:tab")).toBe(2);
  expect(app.shows("Agent gone")).toBe(false);
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
  expect(app.storage()["herdr.dock.v1"]).toBeUndefined();

  await openAgents(app, FIRST);
  await app.keyboard.press("mod+\\");
  const groups = await saved(app);
  expect(groups.map((g) => g.panels.map((p) => (p === "board" ? p : nameOf(p))))).toEqual([["board"], [FIRST]]);
});


test("every drag has a command: move the tab to another group, down, and back, from the palette", async () => {
  const app = await ready();
  const run = async (command: string) => {
    await app.keyboard.press("mod+k");
    await app.type("label:Search commands", command);
    await app.press(`label:${command}`);
    await settle(app);
  };
  await openAgents(app, FIRST, SECOND);
  await run("Move tab to split down");
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([2, 1]);
  await run("Move tab to other group");
  expect((await saved(app)).map((g) => g.panels.length)).toEqual([3]);
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
  await app.type("label:Search commands", "Close pane in herdr");
  await app.press("label:Close pane in herdr…");
  await settle(app);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(FIRST);
  expect(Herdr.testRequests("pane.close")).toEqual([]);
  expect(app.count("role:tab")).toBe(2);
});


test("closing a pane in herdr, once confirmed, closes the pane and removes its tab", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  app.onDialog(() => "Close pane");
  await app.keyboard.press("mod+k");
  await app.type("label:Search commands", "Close pane in herdr");
  await app.press("label:Close pane in herdr…");
  await app.waitUntil(() => Herdr.testRequests("pane.close").length === 1);
  await settle(app);
  expect(app.count("role:tab")).toBe(1);
});

test("a pane that herdr drops while its tab is open leaves a tab that says so and can be closed", async () => {
  const app = await ready();
  await openAgents(app, DONE);
  const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
  snapshot.panes = snapshot.panes.filter((p) => p.pane_id !== "w1:p3");
  snapshot.agents = snapshot.agents.filter((a) => a.pane_id !== "w1:p3");
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({ event: "pane_closed", data: { pane_id: "w1:p3" } });
  await app.waitFor("label:Close this tab");
  expect(shown(app, DONE)).toBe(false);
  await app.press("label:Close this tab");
  await settle(app);
  expect(app.count("role:tab")).toBe(1);
});

async function palette(app: App, command: string) {
  await app.keyboard.press("mod+k");
  await app.type("label:Search commands", command);
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
  expect(app.enabled("label:Rename pane…")).toBe(false);
  expect(app.enabled("label:Close pane in herdr…")).toBe(false);
  expect(app.enabled("label:New workspace…")).toBe(true);
});

test("a new workspace from the palette asks for a name and is created in herdr under it", async () => {
  const app = await ready();
  await palette(app, "New workspace…");
  await app.type("label:Name *", "scratch");
  await app.press("text:Create");
  await app.waitUntil(() => Herdr.testRequests("workspace.create").length === 1);
  expect(JSON.stringify(Herdr.testRequests("workspace.create")[0].params)).toContain("scratch");
});
