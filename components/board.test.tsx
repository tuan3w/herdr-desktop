import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import { scripted, sentKeys } from "./board-seam";

/** The board against the scripted herdr of `fixtures/herdr/mixed.json` (2 need you, 1 to review, 2 working, 3 idle) and `storm.json` (20 need you). */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
/**
 * Opens the board and lets the list finish measuring its cells: a press made while rows still move under it can be lost
 * (a quirk of the headless harness under load), so no test starts before the layout is settled.
 */
async function lab(fixture = "mixed") {
  const app = await open("./board-lab.tsx", { ...DESKTOP, host: { params: { fixture } } });
  await app.waitFor("heard just now", { timeout: 5000 }).catch(() => undefined);
  await app.clock!.runFor(300);
  return app;
}
const at = (app: App, text: string) => app.texts().indexOf(text);
const has = (app: App, text: string) => app.texts().includes(text);

test("the sections come in the order of urgency, each agent in the one that matches its state, and the status line counts them", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  // The list mounts its cells as it measures them: the order of the texts is only settled after that.
  await app.clock!.runFor(300);
  expect(app.texts().slice(2, 9)).toEqual(["2 need you", "·", "1 to review", "·", "2 working", "·", "heard just now"]);

  const order = ["Needs you", "To review", "Working", "Idle"].map((h) => at(app, h));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const between = (from: string, to: string) => app.texts().slice(at(app, from), at(app, to));
  for (const name of ["payments review", "auth"]) expect(between("Needs you", "To review")).toContain(name);
  expect(between("To review", "Working")).toContain("Fix login flow");
  for (const name of ["Refactor ledger", "upgrade deps"]) expect(between("Working", "Idle")).toContain(name);
  expect(app.count("label:/^Reply…: /")).toBe(2);
});

test("a blocked agent shows what it asks, in full, and pressing an answer sends that option's keys", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  expect(app.texts()).toContain("touch /tmp/hm-capture-claude/x.txt");
  // Past the guard that follows a question appearing.
  await app.clock!.runFor(450);
  await app.press("label:1. Yes >> nth=0");
  await app.waitUntil(() => sentKeys().length === 1);
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("a question that changed after the person looked sends nothing and says so on the answer", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  await app.clock!.runFor(450);
  Herdr.testSetScreen("w1:p1", [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"]);
  await app.press("label:1. Yes >> nth=0");
  await app.waitFor("The question changed");
  expect(sentKeys()).toEqual([]);
});

test("Reply… opens the pane with the message box, and opening a finished agent does not review it", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  await app.press("label:Reply…: payments review");
  expect(has(app, "opened local/w1:p1 to reply")).toBe(true);

  await app.press("label:/^Fix login flow, /");
  expect(has(app, "opened local/w1:p3")).toBe(true);
  expect(has(app, "1 to review")).toBe(true);
});

test("Reviewed takes the agent out of 'to review' with one Undo that puts it back", async () => {
  const app = await lab();
  await app.waitFor("To review");
  await app.press("label:Reviewed: Fix login flow");
  await app.waitFor("Marked reviewed");
  await app.waitUntil(() => !has(app, "To review"));
  expect(app.texts().some((t) => t.endsWith("to review"))).toBe(false);

  await app.press("Undo");
  await app.waitFor("To review");
  expect(has(app, "1 to review")).toBe(true);
});

test("'1 to review' picks exactly the finished agents, opens a folded section, and Reviewed in the bar clears them under one Undo", async () => {
  const app = await lab();
  await app.waitFor("To review");
  await app.press("label:To review");
  expect(has(app, "Fix login flow")).toBe(false);

  await app.press("label:1 to review, select them");
  await app.waitFor("1 selected");
  expect(has(app, "Fix login flow")).toBe(true);
  expect(app.shows("label:Select Fix login flow")).toBe(true);

  await app.press("label:Selected agents >> text:Reviewed");
  await app.waitFor("Marked reviewed");
  expect(has(app, "1 selected")).toBe(false);
  await app.waitUntil(() => !app.texts().some((t) => t.endsWith("to review")));
});

test("idle shows the five newest and one line for the rest, which names the first two and opens them in place", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  scripted("mixed").addIdle(4);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("2 more idle")));
  const line = app.texts().find((t) => t.startsWith("2 more idle"))!;
  expect(line).toMatch(/^2 more idle: .+, .+$/);
  const hiddenName = line.slice("2 more idle: ".length).split(", ")[0];
  expect(has(app, hiddenName)).toBe(false);

  await app.press(`label:${line}`);
  await app.waitFor("Show less");
  expect(has(app, hiddenName)).toBe(true);
  await app.press("label:Show less");
  expect(has(app, hiddenName)).toBe(false);
});

test("twenty blocked agents list as twenty, built as you scroll, and the status line says twenty", async () => {
  const app = await lab("storm");
  await app.waitFor("20 need you");
  expect(has(app, "job 1")).toBe(true);
  // A virtualized list builds only what is near the window.
  expect(has(app, "job 20")).toBe(false);
  expect(app.count("label:/^Reply…: /")).toBeLessThan(20);

  await app.scroll("label:Agents", 100000);
  await app.waitFor("job 20");
  expect(has(app, "job 1")).toBe(false);
});

test("a changed state moves the agent between sections with the status line, never leaving it counted twice", async () => {
  const app = await lab();
  await app.waitFor("2 need you");
  scripted("mixed").become("w1:p2", "done");
  await app.waitFor("1 needs you");
  expect(has(app, "2 to review")).toBe(true);
  // The list recycles its cells, so what is on screen is checked by what each row says, not by where it sits.
  expect(app.count("label:/^auth, omp, done, to review/")).toBe(1);
  expect(app.count("label:/^Reply…: /")).toBe(1);
});

test("with only this computer and nothing running the board points at adding a machine", async () => {
  const app = await lab("empty");
  await app.waitFor("Add your first machine");
  await app.press("Add machine");
  expect(has(app, "add machine asked")).toBe(true);
});

test("switching the colour scheme re-themes the board without breaking its rows", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  await app.setColorScheme("dark");
  await app.wait(300);
  expect(has(app, "Needs you")).toBe(true);
  expect(has(app, "payments review")).toBe(true);
});
