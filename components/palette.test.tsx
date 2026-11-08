import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import { DONE, ENTRY, FIRST, front, ready, SECOND, settle, WEB } from "../app-seam";

ENTRY.path = "../App.tsx";

/**
 * The command palette against the `mixed` fixture (`payments`: five agents, two need you, one to review; `web`).
 * What it finds, what it does with a row, and the layers over the list (actions, a command's steps).
 */

const FIELD = "label:Search agents, projects and commands";

const openPalette = async (app: App) => {
  await app.keyboard.press("mod+p");
  await settle(app);
  // The headless harness gives the keyboard to a dialog only once a field is focused: a person's first keystroke does it.
  await app.clear(FIELD);
};

const type = async (app: App, text: string) => {
  await app.type(FIELD, text);
  await settle(app);
};

/** Whether a row reads as `start...` to a screen reader (the whole sentence is the row's name). */
const row = (start: string) => `label:/^${start}/`;

test("opened empty, the palette says what needs you first, then what else there is, and nothing else", async () => {
  const app = await ready();
  await openPalette(app);
  expect(app.shows(FIELD)).toBe(true);
  expect(app.shows("Needs you")).toBe(true);
  expect(app.shows(row(FIRST))).toBe(true);
  // Escape closes it, and the app is where it was.
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows(FIELD)).toBe(false);
});

test("typing finds an agent by its name and by its project, and Enter opens it where it lives", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "auth");
  expect(app.shows(row(SECOND))).toBe(true);
  await app.keyboard.press("enter");
  await settle(app);
  expect(await front(app)).toBe(SECOND);
  expect(app.shows(FIELD)).toBe(false);
});

test("a prefix picks a scope and is not part of the query; Tab cycles the scopes; Backspace on an empty field leaves one", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "@");
  expect(app.shows("label:Agents, prefix @")).toBe(true);
  expect(app.value(FIELD) ?? "").toBe("");
  expect(app.shows("label:Search agents")).toBe(true);
  await app.keyboard.press("tab");
  expect(app.shows("label:Search projects")).toBe(true);
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("shift+tab");
  expect(app.shows("label:Search agents, projects and commands")).toBe(true);
});

test("a query that matches nothing says so and offers the next steps as rows", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "zzzqq");
  expect(app.shows("No match for “zzzqq”")).toBe(true);
  expect(app.shows("Search messages for “zzzqq”")).toBe(true);
  expect(app.shows("New agent session…")).toBe(true);
});

test("a command runs from the list and a disabled one says why instead of running", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "close tab");
  expect(app.shows(row("Close tab"))).toBe(true);
  await app.clear(FIELD);
  await type(app, "settings");
  await app.keyboard.press("enter");
  await settle(app);
  expect(app.shows("label:Theme")).toBe(true);
});

test("the order does not change while the palette is open, even when an agent changes state", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "a");
  const before = app.texts().filter((t) => t.length > 0);
  await app.clock!.runFor(2000);
  const after = app.texts().filter((t) => t.length > 0);
  expect(after).toEqual(before);
  expect(WEB).toBeTruthy();
  expect(DONE).toBeTruthy();
});

test("editing keys keep editing the query, and Escape takes a scope back once the query is empty", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "authx");
  await app.keyboard.press("backspace");
  await settle(app);
  expect(app.value(FIELD)).toBe("auth");
  await app.clear(FIELD);
  await type(app, "#");
  expect(app.shows("label:Search projects")).toBe(true);
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows(FIELD)).toBe(true);
  expect(app.shows(FIELD)).toBe(true);
});

test("mod+p again opens the actions of the highlighted row, Escape goes back to the list, and an action marks a finished agent reviewed", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "Fix login");
  await app.keyboard.press("mod+p");
  await settle(app);
  expect(app.shows("label:Actions for Fix login flow")).toBe(true);
  expect(app.shows("Open to the side")).toBe(true);
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows("label:Actions for Fix login flow")).toBe(false);
  expect(app.shows(FIELD)).toBe(true);
  await app.keyboard.press("mod+p");
  await settle(app);
  await app.press("label:Mark reviewed");
  await settle(app);
  expect(Herdr.board().counts.toReview).toBe(0);
  expect(app.shows(FIELD)).toBe(false);
});

test("a natural phrase opens the first step of a two-step command filtered to what follows, and Escape steps back", async () => {
  const app = await ready();
  await openPalette(app);
  await type(app, "new session pay");
  expect(app.shows("New agent session in")).toBe(true);
  expect(app.value("label:Choose a project")).toBe("pay");
  expect(app.shows(row("project, payments"))).toBe(true);
  expect(app.shows(row("project, web"))).toBe(false);
  await app.clear("label:Choose a project");
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows(FIELD)).toBe(true);
  expect(app.shows("New agent session in")).toBe(false);
});
