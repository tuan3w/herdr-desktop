import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import {
  DONE,
  ENTRY,
  FIRST,
  front,
  openAgents,
  openTerminals,
  ready,
  SECOND,
  settle,
  sidebarRow,
  WEB,
} from "../app-seam";
import { scripted, sentKeys } from "./board-seam";

ENTRY.path = "../App.tsx";

/**
 * Where the person has been: `ctrl+tab`, back and forward, the visits the engine keeps and the Switcher
 * (`lib/nav.ts`, `components/switcher.tsx`), against the `mixed` fixture: the projects `payments` (five agents) and `web`.
 */

const FILTER = "label:Filter recent agents and projects";
const tap = async (app: App, keys: string) => {
  await app.keyboard.press(keys);
  await settle(app);
};
/** Whether the Switcher has a row a screen reader reads as `start...`: each row's name ends with its place (`2 of 5`), which the sidebar's rows do not. */
const has = (app: App, start: string, place = "\\d+ of \\d+"): boolean => app.shows(`label:/^${start}.*, ${place}$/`);
const position = (app: App): string | undefined => app.texts().find((t) => /^\d+ of \d+$/.test(t));
/** The headless harness does not move the keyboard into a dialog opened over a focused tab: the first keystroke of a person does. */
const focusSwitcher = (app: App) => app.clear(FILTER);

test("ctrl+tab swaps the two agents visited last, across projects, and a second tap comes back", async () => {
  const app = await ready();
  await openAgents(app, FIRST, WEB);
  await tap(app, "ctrl+tab");
  expect(await front(app)).toBe(FIRST);
  await tap(app, "ctrl+tab");
  expect(await front(app)).toBe(WEB);
  await tap(app, "ctrl+tab");
  expect(await front(app)).toBe(FIRST);
});

test("ctrl+tab works with the keyboard in a message box, where a text field keeps Tab for itself", async () => {
  const app = await ready();
  await openAgents(app, SECOND, FIRST);
  await app.keyboard.press("mod+2");
  await settle(app);
  await app.waitFor("label:Message");
  await app.keyboard.press("h");
  expect(app.value("label:Message")).toBe("h");
  await tap(app, "ctrl+tab");
  expect(await front(app)).toBe(SECOND);
});

test("from the board, ctrl+tab goes to the agent visited last, and with nothing visited it says so and opens nothing", async () => {
  const fresh = await ready();
  await tap(fresh, "ctrl+tab");
  expect(fresh.count("role:tab")).toBe(1);

  const app = await ready();
  await openAgents(app, FIRST, SECOND);
  await tap(app, "mod+1");
  await tap(app, "ctrl+tab");
  expect(await front(app)).toBe(SECOND);
});

test("ctrl+shift+tab swaps the two projects visited last, and next and previous project walk the sidebar's order, wrapping", async () => {
  const app = await ready();
  await openAgents(app, FIRST, WEB);
  await tap(app, "ctrl+shift+tab");
  expect(await front(app)).toBe(FIRST);
  await tap(app, "ctrl+shift+tab");
  expect(await front(app)).toBe(WEB);

  // `payments` is first in the sidebar, `web` second: next from web wraps to payments, previous from payments to web.
  await tap(app, "mod+shift+]");
  expect([FIRST, SECOND, DONE, "Refactor ledger", "upgrade deps"]).toContain(await front(app));
  await tap(app, "mod+shift+[");
  expect([WEB, "notes", "scripts"]).toContain(await front(app));
});

test("switching to a project opens the agent of it visited last, not the first one", async () => {
  const app = await ready();
  await openAgents(app, "notes", FIRST);
  await tap(app, "ctrl+shift+tab");
  expect(await front(app)).toBe("notes");
});

test("arrivals are kept by the engine, newest first, one entry per agent and per project entered", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, WEB);
  const keys = Herdr.recents().map((r) => r.key);
  expect(keys.filter((k) => k.startsWith("agent:"))).toEqual([
    "agent:local/w2:p1",
    "agent:local/w1:p2",
    "agent:local/w1:p1",
  ]);
  // Two projects were entered once each: moving between agents of one project does not visit it again.
  expect(keys.filter((k) => k.startsWith("project:"))).toHaveLength(2);
  expect(keys).toHaveLength(5);
  expect(Herdr.recents().every((r) => r.count === 1)).toBe(true);
  // The project is entered before its agent, so the agent is the newer entry.
  expect(keys[0]).toBe("agent:local/w2:p1");
  expect(keys[1].startsWith("project:")).toBe(true);
});

test("back and forward walk the places gone to by command, and a new command drops the way forward", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, DONE);
  await tap(app, "mod+[");
  expect(await front(app)).toBe(SECOND);
  await tap(app, "mod+[");
  expect(await front(app)).toBe(FIRST);
  await tap(app, "mod+]");
  expect(await front(app)).toBe(SECOND);
  // A new place from here: the Done agent is no longer ahead.
  await openAgents(app, WEB);
  await tap(app, "mod+]");
  expect(await front(app)).toBe(WEB);
  await tap(app, "mod+[");
  await tap(app, "mod+[");
  expect(await front(app)).toBe(FIRST);
});

test("back goes as far as the board, where the person started, and no further", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await tap(app, "mod+[");
  expect(await front(app)).toBe("board");
  await tap(app, "mod+[");
  expect(await front(app)).toBe("board");
});

test("the history skips an agent that is gone", async () => {
  const app = await ready();
  const herd = scripted("mixed");
  await openAgents(app, FIRST, SECOND, DONE);
  herd.remove("w1:p2");
  await app.waitFor(sidebarRow(SECOND), { state: "gone" });
  await tap(app, "mod+[");
  expect(await front(app)).toBe(FIRST);
});

test("the Switcher lists where you are, then the places visited, and opens the one picked", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, WEB);
  await tap(app, "mod+e");
  expect(app.shows("Switch to…")).toBe(true);
  // The agent in front first (`here`), then the newest visits; agents and projects are both there.
  expect(has(app, "Styling pass, ", "1 of \\d+")).toBe(true);
  expect(app.shows("label:/^Styling pass, .*, here, 1 of \\d+$/")).toBe(true);
  expect(has(app, "auth, ", "2 of \\d+")).toBe(true);
  expect(has(app, "payments review, ", "3 of \\d+")).toBe(true);
  // The project you are in is not listed (you are there); the one you left is.
  expect(has(app, "payments, project, ")).toBe(true);
  expect(has(app, "web, project, ")).toBe(false);
  expect(position(app)).toMatch(/^2 of /);

  await app.press(`label:/^${FIRST}, .*, 3 of \\d+$/`);
  await settle(app);
  expect(app.shows("Switch to…")).toBe(false);
  expect(await front(app)).toBe(FIRST);
});

test("mod+e again moves down the list and wraps, mod+shift+e moves up, and Escape leaves everything where it was", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, WEB);
  await tap(app, "mod+e");
  const total = Number(position(app)!.split(" of ")[1]);
  expect(total).toBeGreaterThan(3);
  await tap(app, "mod+e");
  expect(position(app)).toBe(`3 of ${total}`);
  await tap(app, "mod+shift+e");
  await tap(app, "mod+shift+e");
  expect(position(app)).toBe(`1 of ${total}`);
  await tap(app, "mod+shift+e");
  expect(position(app)).toBe(`${total} of ${total}`);
  await tap(app, "mod+e");
  expect(position(app)).toBe(`1 of ${total}`);

  await focusSwitcher(app);
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows("Switch to…")).toBe(false);
  expect(await front(app)).toBe(WEB);
});

test("the Switcher going up starts on the last row", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND);
  await tap(app, "mod+shift+e");
  const [at, of] = position(app)!.split(" of ");
  expect(at).toBe(of);
});

test("typing narrows the Switcher's rows by name, project and machine", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, WEB);
  await tap(app, "mod+e");
  await app.type(FILTER, "styling");
  expect(has(app, "Styling pass, ", "1 of 1")).toBe(true);
  expect(has(app, "auth, ")).toBe(false);
  await app.clear(FILTER);
  await app.type(FILTER, "payments");
  expect(has(app, "payments review, ")).toBe(true);
  expect(has(app, "Styling pass, ")).toBe(false);
  await app.clear(FILTER);
  await app.type(FILTER, "zzzz");
  expect(app.shows("Nothing matches")).toBe(true);
});

test("the Switcher's order is fixed while it is open: a state change updates a row in place and moves nothing", async () => {
  const app = await ready();
  const herd = scripted("mixed");
  await openAgents(app, FIRST, SECOND, DONE);
  await tap(app, "mod+e");
  expect(has(app, `${DONE}, `, "1 of \\d+")).toBe(true);
  expect(has(app, "auth, .*needs you.*", "2 of \\d+")).toBe(true);
  expect(has(app, "payments review, ", "3 of \\d+")).toBe(true);

  herd.become("w1:p2", "working");
  await app.waitFor("label:/^auth, .*working.*, 2 of \\d+$/");
  expect(has(app, "payments review, ", "3 of \\d+")).toBe(true);
  expect(has(app, `${DONE}, `, "1 of \\d+")).toBe(true);
});

test("with nothing visited the Switcher says so, and it never lists an agent that is gone", async () => {
  const empty = await ready();
  await tap(empty, "mod+e");
  expect(empty.shows("Nothing visited yet: agents you open are listed here.")).toBe(true);

  const app = await ready();
  const herd = scripted("mixed");
  await openAgents(app, FIRST, SECOND);
  herd.remove("w1:p1");
  await app.waitFor(sidebarRow(FIRST), { state: "gone" });
  await tap(app, "mod+e");
  expect(has(app, `${FIRST}, `)).toBe(false);
  expect(has(app, "auth, ", "1 of \\d+")).toBe(true);
});

test("typing into a pane: Ctrl+K and Ctrl+E reach the pane, and the palette is Ctrl+Shift+P", async () => {
  const app = await ready();
  await openTerminals(app, FIRST);
  await app.keyboard.press("mod+shift+k");
  await settle(app);
  expect(app.shows("label:/^Typing into /")).toBe(true);

  for (const key of ["ctrl+k", "ctrl+e", "ctrl+w", "ctrl+["]) await app.keyboard.press(key);
  await app.waitUntil(() => sentKeys().length === 4);
  expect(sentKeys()).toEqual(["w1:p1: ctrl+k", "w1:p1: ctrl+e", "w1:p1: ctrl+w", "w1:p1: ctrl+["]);
  expect(app.shows("Command palette")).toBe(false);
  expect(app.shows("Switch to…")).toBe(false);
  expect(app.count("role:tab")).toBe(2);

  await app.keyboard.press("mod+shift+p");
  await settle(app);
  expect(app.shows("Command palette")).toBe(true);
});

test("out of the mode the same keys are the app's again", async () => {
  const app = await ready();
  await openTerminals(app, FIRST);
  await app.keyboard.press("mod+shift+k");
  await app.keyboard.press("mod+shift+k");
  await settle(app);
  expect(app.shows("label:/^Typing into /")).toBe(false);
  await app.keyboard.press("mod+k");
  await settle(app);
  expect(app.shows("Command palette")).toBe(true);
  expect(sentKeys()).toEqual([]);
});
