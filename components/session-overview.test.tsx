import { Herdr, Sessions } from "herdr-desktop/native";
import { afterEach, expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import mixed from "../fixtures/herdr/mixed.json";
import { endSessions } from "./chat-parts-seam";

/** The details of a session against a real keeper driving the scripted ACP agent, and against a session that is not this app's. */
const DESKTOP = { width: 1280, height: 900 };

afterEach(() => endSessions());
const live = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "live" } } });

async function details(app: App) {
  await app.press("Start a session");
  // A real keeper starts in a time that follows the machine's load: wait for the fact, with room.
  await app.waitFor("Phase: idle", { timeout: 30_000 });
  await app.press("Open details");
  await app.waitFor("Session details");
}

/** Ends the session the test started: a keeper outlives the app by design, so a test must not leave one. */
async function finish(app: App) {
  app.onDialog(() => "End session");
  await app.press("End session");
  await app.waitUntil(() => app.shows("Session details") === false);
}

/** The id the details show, read from the session list: a test that started one knows it is the only one. */
async function theSession(): Promise<string> {
  const all = await Sessions.list("local");
  return all[0]!.id;
}

test("the details say what the session is: agent, machine, folder, id and where it stands", async () => {
  const app = await live();
  await details(app);
  expect(app.texts()).toContain("omp");
  expect(app.texts()).toContain("This computer");
  expect(app.texts()).toContain("/");
  expect(app.texts()).toContain(await theSession());
  expect(app.texts()).toContain("Waiting for you");
  // A keeper's chat lives in no herdr workspace or tab.
  expect(app.shows("Workspace")).toBe(false);
  expect(app.shows("Tab")).toBe(false);
  // The scripted agent reports only the older `modes` shape: that one choice is the settings, with the mode's name. It
  // reports no context size and no model, so there is no empty Context heading and no Model or Thinking choice.
  expect(app.shows("Settings")).toBe(true);
  expect(app.shows("Mode")).toBe(true);
  expect(app.shows("Model")).toBe(false);
  expect(app.shows("Thinking")).toBe(false);
  expect(app.shows("Context")).toBe(false);
  await finish(app);
});

test("ending a session is confirmed first, and a refusal of the person's leaves it running", async () => {
  const app = await live();
  await details(app);
  const id = await theSession();
  app.onDialog(() => "Cancel");
  // A press that lands while the keeper's updates redraw the details is lost; a repeat is a second ask only if the first took.
  for (let attempt = 0; attempt < 5 && app.dialogs().length === 0; attempt++) {
    await app.press("End session");
    await app.waitUntil(() => app.dialogs().length > 0, { timeout: 2000 }).catch(() => undefined);
  }
  expect(app.dialogs().length).toBe(1);
  expect((await Sessions.list("local")).some((s) => s.id === id)).toBe(true);
  expect(Sessions.view("local", id)).not.toBeNull();

  app.onDialog(() => "End session");
  await app.press("End session");
  await app.waitUntil(() => !app.shows("Session details"));
  expect(Sessions.view("local", id)).toBeNull();
  expect((await Sessions.list("local")).some((s) => s.id === id)).toBe(false);
});

test("an agent seen in a herdr pane says which workspace and tab it is in", async () => {
  const app = await open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "pane-chat" } } });
  await app.waitFor("Session details");
  await app.waitFor("Workspace");
  expect(app.texts()).toContain("payments");
  // the tab's name follows herdr when the person renames it
  const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
  for (const t of snapshot.tabs) if (t.tab_id === "w1:t1") t.label = "deploys";
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({ event: "pane_agent_status_changed", data: { pane_id: "w1:p2", agent_status: "blocked" } });
  await app.waitFor("deploys");
  expect(app.shows("Tab")).toBe(true);
});

test("a session this app did not start is refused with the machine's own words, and nothing is confirmed", async () => {
  const app = await open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "ghost" } } });
  await app.waitFor("Session details");
  expect(app.texts()).toContain("Not open here. Open the session to see its state.");
  await app.press("End session");
  await app.waitFor("This session was not started by this app. End it where it was started.");
  expect(app.dialogs().length).toBe(0);
});

test("the session id can be copied", async () => {
  const app = await live();
  await details(app);
  await app.press("Copy id");
  await app.waitFor("Session id copied");
  await finish(app);
});
