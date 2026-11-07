import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { scripted } from "./board-seam";

/** The sidebar beside lines that say what its buttons did (`sidebar-lab.tsx`), against the scripted herdr's `mixed` fixture. */
const lab = (extra: { width?: number; storage?: Record<string, string> } = {}) =>
  open("./sidebar-lab.tsx", { width: 1280, height: 800, platform: "linux", clock: {}, host: { params: { fixture: "mixed" } }, ...extra });

const row = (name: string) => `label:/^${name}, /`;
const ready = async (extra: Parameters<typeof lab>[0] = {}) => {
  const app = await lab(extra);
  await app.waitFor("label:Board, 2 need you");
  return app;
};
const picked = (app: App) => app.texts().find((t) => t.startsWith("picked "));

test("agents are listed under the board's sections, and each row names the agent, its state, its machine", async () => {
  const app = await ready();
  for (const section of ["label:Needs you, 2", "label:To review, 1", "label:Working, 2", "label:Idle, 3"]) expect(app.shows(section)).toBe(true);
  expect(app.shows("label:payments review, claude, needs you, This computer")).toBe(true);
  expect(app.shows(row("Fix login flow"))).toBe(true);
  expect(app.shows("label:This computer, Connected · herdr 0.9.5")).toBe(true);
});

test("an agent that stops needing you moves out of Needs you and the count follows", async () => {
  const app = await ready();
  scripted("mixed").become("w1:p1", "working");
  await app.waitFor("label:Board, 1 need you");
  await app.waitFor("label:Working, 3");
  expect(app.shows("label:Needs you, 1")).toBe(true);
});

test("when nothing needs you the section and the count are gone, not zero", async () => {
  const app = await ready();
  const agents = scripted("mixed");
  agents.become("w1:p1", "working");
  agents.become("w1:p2", "working");
  await app.waitFor("label:Board");
  expect(app.shows("label:/^Needs you/")).toBe(false);
  expect(app.shows("label:/^Board, /")).toBe(false);
});

test("a search narrows the rows to the agents that match every word, ignoring case, and says when none do", async () => {
  const app = await ready();
  await app.type("label:Search agents", "AUTH omp");
  expect(app.shows(row("auth"))).toBe(true);
  expect(app.shows(row("payments review"))).toBe(false);
  await app.clear("label:Search agents");
  await app.type("label:Search agents", "zzz");
  expect(app.shows("No agent matches")).toBe(true);
  await app.clear("label:Search agents");
  expect(app.shows(row("payments review"))).toBe(true);
});

test("a folded section hides its rows, keeps its count, and stays folded after a restart; Needs you does not fold", async () => {
  const app = await ready();
  await app.press("label:Working, 2");
  expect(app.shows(row("Refactor ledger"))).toBe(false);
  expect(app.shows("label:Working, 2")).toBe(true);
  await app.clock!.runFor(100);
  expect(JSON.parse(app.storage()["herdr.sidebar.v1"]).folded).toEqual(["working"]);

  const again = await ready({ storage: { "herdr.sidebar.v1": app.storage()["herdr.sidebar.v1"] } });
  expect(again.shows(row("Refactor ledger"))).toBe(false);
  expect(again.shows(row("payments review"))).toBe(true);
  await again.press("label:Working, 2");
  expect(again.shows(row("Refactor ledger"))).toBe(true);
});

test("the top buttons open what they say: machines, new agent session, settings", async () => {
  const app = await ready();
  await app.press("label:This computer, Connected · herdr 0.9.5");
  expect(app.shows("machines dialog open")).toBe(true);
  await app.press("label:New agent session");
  expect(app.shows("new agent dialog open")).toBe(true);
  await app.press("label:Settings");
  expect(app.shows("settings dialog open")).toBe(true);
});

test("agents are picked with the box at the row's left, and Shift picks everything from the last pick", async () => {
  const app = await ready();
  await app.press("label:Select payments review");
  expect(picked(app)).toBe("picked 1");
  await app.press("label:Select payments review");
  expect(picked(app)).toBe("picked 0");
  await app.press("label:Select payments review");
  await app.keyboard.down("shift");
  await app.press("label:Select Fix login flow");
  await app.keyboard.up("shift");
  // payments review, auth (needs you) and Fix login flow (to review): the rows between the two picks.
  expect(picked(app)).toBe("picked 3");
});

test("in a narrow window the sidebar is a rail: every agent keeps its full name, the search field goes,", async () => {
  const app = await ready({ width: 900 });
  expect(app.shows("label:Search agents")).toBe(false);
  expect(app.shows("label:payments review, claude, needs you, This computer")).toBe(true);
  expect(app.shows("label:Board, 2 need you")).toBe(true);
  expect(app.shows("label:This computer, Connected · herdr 0.9.5")).toBe(true);
});

test("a wide window can collapse the sidebar to the rail and bring it back", async () => {
  const app = await ready();
  await app.press("label:Collapse sidebar");
  expect(app.shows("label:Search agents")).toBe(false);
  await app.press("label:Expand sidebar");
  expect(app.shows("label:Search agents")).toBe(true);
});
