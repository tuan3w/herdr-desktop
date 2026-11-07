import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import { scripted, sentKeys } from "./board-seam";

/**
 * The home against the scripted herdr of `fixtures/herdr/projects.json` (three projects: `payments-api` with a linked
 * worktree, `web` with two workspaces of one repository, `notes`; 2 need you, 1 to review, 2 working), `mixed.json` and
 * `storm.json` (20 need you, in five projects).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
/**
 * Opens the home and lets it finish laying out: a press made while the cards still move under it can be lost (a quirk of
 * the headless harness under load), so no test starts before the layout is settled.
 */
async function lab(fixture = "projects") {
  const app = await open("./board-lab.tsx", { ...DESKTOP, host: { params: { fixture } } });
  await app.waitFor("heard just now", { timeout: 5000 }).catch(() => undefined);
  await app.clock!.runFor(300);
  return app;
}
const has = (app: App, text: string) => app.texts().includes(text);

test("every agent is under its project, not under its state, and the status line counts them all", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  expect(app.texts().slice(0, 8)).toContain("2 need you");
  expect(app.texts().filter((t) => t === "Needs you")).toHaveLength(1);
  // The cards, in the board's order: by name.
  for (const label of ["notes, This computer", "payments-api, This computer, 1 needs you, 1 working, 1 to review", "web, This computer, 1 needs you, 1 working"]) {
    expect(app.shows(`label:${label}`)).toBe(true);
  }
  // Both workspaces of the web repository are one card; the worktree of payments-api is a chip of its card.
  expect(app.shows("label:/^storybook, omp, idle, web/")).toBe(true);
  expect(app.shows("label:/^Dark theme tokens, claude, working, web/")).toBe(true);
  expect(has(app, "payments-api-hotfix · worktree")).toBe(true);
  expect(has(app, "payments-api · main")).toBe(true);
  expect(app.shows("label:/^Fix rounding in refunds, claude, done, to review, payments-api/")).toBe(true);
  // A card says whether an agent is a chat or a terminal.
  expect(app.texts().some((t) => t.endsWith("· terminal"))).toBe(true);
});

test("the projects keep their order when an agent changes state, and a pin moves one to the top", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  const order = () => ["notes", "payments-api", "web"].map((n) => app.texts().indexOf(n));
  expect(order()).toEqual([...order()].sort((a, b) => a - b));
  expect(order().every((i) => i >= 0)).toBe(true);

  scripted("projects").become("w5:p1", "blocked");
  await app.waitFor("3 need you");
  expect(order()).toEqual([...order()].sort((a, b) => a - b));

  await app.press("label:Pin web");
  await app.waitFor("Pinned");
  await app.waitUntil(() => app.texts().indexOf("web") < app.texts().indexOf("notes"));
});

test("what has waited longest is an inbox at the top with its answers, and the agent's own row points to it instead of repeating them", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  expect(app.shows("label:Needs you")).toBe(true);
  expect(app.count("label:1. Yes")).toBe(1);
  expect(app.count("Answer it in Needs you, above")).toBe(1);
  expect(has(app, "Answer one by one")).toBe(true);
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

test("Reply… opens the agent with the message box, and opening a finished agent does not review it", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  await app.press("label:Reply…: payments review");
  expect(has(app, "opened local/w1:p1 to reply")).toBe(true);

  await app.press("label:/^Fix rounding in refunds, /");
  expect(has(app, "opened local/w2:p1")).toBe(true);
  expect(has(app, "1 to review")).toBe(true);
});

test("Reviewed takes the agent out of 'to review' with one Undo that puts it back", async () => {
  const app = await lab();
  await app.waitFor("1 to review");
  await app.press("label:Reviewed: Fix rounding in refunds");
  await app.waitFor("Marked reviewed");
  await app.waitUntil(() => !app.texts().some((t) => t.endsWith("to review")));

  await app.press("Undo");
  await app.waitFor("1 to review");
});

test("'1 to review' picks exactly the finished agents, opens the project folded over them, and Reviewed in the bar clears them under one Undo", async () => {
  const app = await lab();
  await app.waitFor("1 to review");
  await app.press("label:payments-api");
  expect(has(app, "Fix rounding in refunds")).toBe(false);

  await app.press("label:1 to review, select them");
  await app.waitFor("1 selected");
  expect(has(app, "Fix rounding in refunds")).toBe(true);
  expect(app.shows("label:Select Fix rounding in refunds")).toBe(true);

  await app.press("label:Selected agents >> text:Reviewed");
  await app.waitFor("Marked reviewed");
  expect(has(app, "1 selected")).toBe(false);
  await app.waitUntil(() => !app.texts().some((t) => t.endsWith("to review")));
});

test("a project lists the idle agents it has room for and folds the rest into one line that opens them in place", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  scripted("projects").addIdle(5);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("3 more idle")));
  expect(app.shows("label:3 more idle in notes")).toBe(true);
  expect(has(app, "extra idle 5")).toBe(false);

  await app.press("label:3 more idle in notes");
  await app.waitFor("Show fewer idle");
  expect(app.shows("label:/^extra idle 5, /")).toBe(true);
  await app.press("label:Show fewer idle in notes");
  await app.waitUntil(() => !app.shows("label:/^extra idle 5, /"));
});

test("twenty blocked agents across five projects: the inbox answers one, the rest wait behind one button, every project is a card", async () => {
  const app = await lab("storm");
  await app.waitFor("20 need you");
  expect(has(app, "19 more waiting")).toBe(true);
  expect(has(app, "Answer one by one")).toBe(true);
  for (const name of ["docs", "infra", "payments-api", "tools", "web"]) expect(app.shows(`label:/^${name}, This computer, 4 need you/`)).toBe(true);
});

test("a changed state moves the agent's chip with the status line, never leaving it counted twice", async () => {
  const app = await lab("mixed");
  await app.waitFor("2 need you");
  scripted("mixed").become("w1:p2", "done");
  await app.waitFor("1 needs you");
  expect(has(app, "2 to review")).toBe(true);
  expect(app.count("label:/^auth, omp, done, to review/")).toBe(1);
});

test("a project starts a chat in its own folder", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  await app.press("label:New agent session in web");
  expect(has(app, "new session in /home/dev/web")).toBe(true);
});

test("with only this computer and nothing running the home points at adding a machine", async () => {
  const app = await lab("empty");
  await app.waitFor("Add your first machine");
  await app.press("Add machine");
  expect(has(app, "add machine asked")).toBe(true);
});

test("switching the colour scheme re-themes the home without breaking its cards", async () => {
  const app = await lab();
  await app.waitFor("Needs you");
  await app.setColorScheme("dark");
  await app.wait(300);
  expect(has(app, "Needs you")).toBe(true);
  expect(has(app, "payments review")).toBe(true);
});
