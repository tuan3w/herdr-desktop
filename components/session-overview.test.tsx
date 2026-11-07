import { afterEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Sessions } from "herdr-desktop/native";
import { endSessions } from "./chat-parts-seam";

/** The details of a session against a real keeper driving the scripted ACP agent, and against a session that is not this app's. */
const DESKTOP = { width: 1280, height: 900 };

afterEach(() => endSessions());
const live = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "live" } } });

async function details(app: App) {
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
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
  await app.press("End session");
  expect(app.dialogs().length).toBe(1);
  expect((await Sessions.list("local")).some((s) => s.id === id)).toBe(true);
  expect(Sessions.view("local", id)).not.toBeNull();

  app.onDialog(() => "End session");
  await app.press("End session");
  await app.waitUntil(() => !app.shows("Session details"));
  expect(Sessions.view("local", id)).toBeNull();
  expect((await Sessions.list("local")).some((s) => s.id === id)).toBe(false);
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
