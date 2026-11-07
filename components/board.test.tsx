import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { scripted } from "./board-seam";

/**
 * The home against the scripted herdr of `fixtures/herdr/projects.json` (three projects: `payments-api` with a linked
 * worktree, `web` with two workspaces of one repository, `notes`; 2 need you, 1 to review, 2 working), `mixed.json`
 * and `storm.json` (20 need you, in five projects).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
/**
 * Opens the home and lets it finish laying out: a press made while the list still measures can be lost (a quirk of
 * the headless harness under load), so no test starts before the layout is settled.
 */
async function lab(fixture = "projects") {
  const app = await open("./board-lab.tsx", { ...DESKTOP, host: { params: { fixture } } });
  await app.waitFor("heard just now", { timeout: 5000 }).catch(() => undefined);
  await app.clock!.runFor(300);
  return app;
}
const has = (app: App, text: string) => app.texts().includes(text);
/** Presses `label` until `done` shows (a press made while the list still measures can land on a row that moves; a press that took is not repeated). */
async function pressUntil(app: App, label: string, done: string) {
  for (let attempt = 0; attempt < 5 && !app.shows(done); attempt++) {
    await app.press(label);
    await app.clock!.runFor(300);
  }
  await app.waitFor(done);
}
/** Presses `label` until `done` holds, for a result no selector names (a row that left). */
async function pressWhile(app: App, label: string, done: () => boolean) {
  for (let attempt = 0; attempt < 5 && !done(); attempt++) {
    await app.press(label);
    await app.clock!.runFor(300);
  }
  await app.waitUntil(done);
}
const picked = (app: App) =>
  Number(
    app
      .texts()
      .find((t) => /^\d+ selected$/.test(t))
      ?.split(" ")[0] ?? 0,
  );

test("every agent is under its project, in the board's order, and a row says what the agent is", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  // The projects as headers, in the board's order: by name.
  for (const label of [
    "notes, This computer",
    "payments-api, This computer, 1 needs you, 1 working, 1 to review",
    "web, This computer, 1 needs you, 1 working",
  ]) {
    expect(app.shows(`label:${label}`)).toBe(true);
  }
  // (The order itself, equal to the sidebar's, is `lib/board-table.test.ts`: the list's texts are not in screen order.)
  // Both workspaces of the web repository are one group; a row's name carries the agent, its state and its project.
  expect(app.shows("label:/^storybook, omp, idle, web/")).toBe(true);
  expect(app.shows("label:/^Dark theme tokens, claude, working, web/")).toBe(true);
  expect(app.shows("label:/^Fix rounding in refunds, claude, done, to review, payments-api/")).toBe(true);
  // The columns are named once, and the machine is not a column: this computer is not named at all.
  for (const column of ["Agent", "Last", "Age"]) expect(has(app, column)).toBe(true);
  expect(has(app, "This computer")).toBe(false);
});

test("the projects keep their place when an agent changes state, and a pin moves one", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  // The list's texts are not in screen order, but the order of two projects relative to each other is: it flips with a pin only.
  const before = () => Math.sign(app.texts().indexOf("web") - app.texts().indexOf("notes"));
  await app.waitUntil(() => has(app, "notes") && has(app, "web"));
  const start = before();

  scripted("projects").become("w5:p1", "blocked");
  await app.waitFor("label:Need you, 3");
  expect(before()).toBe(start);

  await pressUntil(app, "label:Pin web", "Pinned");
  await app.waitUntil(() => before() === -start);
});

test("the chips are the counts, said once, and a chip filters the table to that state", async () => {
  const app = await lab();
  await app.waitFor("label:Need you, 2");
  for (const chip of ["Need you, 2", "Working, 2", "To review, 1"]) expect(app.shows(`label:${chip}`)).toBe(true);
  // Nothing else on the board repeats a count: no status line, no `to review` text, no project summary.
  expect(app.texts().some((t) => /\d+ (need|to review|working|waiting)/.test(t))).toBe(false);

  await pressWhile(app, "label:Need you, 2", () => !has(app, "Dark theme tokens"));
  expect(has(app, "Fix rounding in refunds")).toBe(false);
  // While Need you filters, a blocked terminal's Last column is its question's first line.
  expect(has(app, "Do you want to proceed?")).toBe(true);

  await app.press("label:Need you, 2");
  await app.waitFor("Dark theme tokens");
});

test("a changed state moves the agent between the chips' counts, never counted twice", async () => {
  const app = await lab("mixed");
  await app.waitFor("label:Need you, 2");
  scripted("mixed").become("w1:p2", "done");
  await app.waitFor("label:Need you, 1");
  await app.waitFor("label:To review, 2");
  expect(app.count("label:/^auth, omp, done, to review/")).toBe(1);
});

test("an empty chip says so instead of showing an empty table", async () => {
  const app = await lab();
  await app.waitFor("label:Need you, 2");
  await pressWhile(app, "label:To review, 1", () => !has(app, "Dark theme tokens"));
  scripted("projects").become("w2:p1", "idle");
  await app.waitFor("Nothing to review");
  expect(app.shows("label:Projects")).toBe(false);
});

test("opening an agent from its row does not review it", async () => {
  const app = await lab();
  await app.waitFor("Fix rounding in refunds");
  await app.press("label:/^Fix rounding in refunds, /");
  await app.waitFor("opened local/w2:p1");
  expect(app.shows("label:To review, 1")).toBe(true);
});

test("Reviewed takes the agent out of 'to review' with one Undo that puts it back", async () => {
  const app = await lab();
  await app.waitFor("label:To review, 1");
  await pressUntil(app, "label:Reviewed: Fix rounding in refunds", "Marked reviewed");
  await app.waitFor("label:To review, 0");

  await app.press("Undo");
  await app.waitFor("label:To review, 1");
});

test("the To review chip offers to pick exactly the finished agents, opens the project folded over them, and Reviewed in the bar clears them under one Undo", async () => {
  const app = await lab();
  await app.waitFor("label:To review, 1");
  await pressUntil(app, "label:Fold payments-api", "label:Unfold payments-api");
  expect(has(app, "Fix rounding in refunds")).toBe(false);
  // A filter alone picks nothing, and the pick is offered only while the chip is on.
  expect(app.shows("label:1 to review, select them")).toBe(false);

  await pressUntil(app, "label:To review, 1", "label:1 to review, select them");
  expect(picked(app)).toBe(0);
  await pressUntil(app, "label:1 to review, select them", "1 selected");
  await app.waitFor("Fix rounding in refunds");
  expect(app.shows("label:Select Fix rounding in refunds")).toBe(true);

  await app.press("label:Selected agents >> text:Reviewed");
  await app.waitFor("Marked reviewed");
  expect(has(app, "1 selected")).toBe(false);
  await app.waitFor("label:To review, 0");
});

test("picks survive a chip change only for the agents the chip still shows", async () => {
  const app = await lab("mixed");
  await app.waitFor("Refactor ledger");
  await pressUntil(app, "label:Select Refactor ledger", "1 selected");
  await pressUntil(app, "label:Select payments review", "2 selected");

  // `payments review` waits and `Refactor ledger` works: Need you keeps one of them.
  await pressUntil(app, "label:Need you, 2", "1 selected");
  expect(app.shows("label:Select payments review")).toBe(true);
  // Going back to all does not bring the dropped pick back.
  await app.press("label:Need you, 2");
  await app.waitFor("Refactor ledger");
  expect(picked(app)).toBe(1);
});

test("a project lists the idle agents it has room for and folds the rest into one line that opens them in place", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  scripted("projects").addIdle(5);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("3 more idle")));
  expect(app.shows("label:3 more idle in notes")).toBe(true);
  expect(has(app, "extra idle 5")).toBe(false);

  await pressUntil(app, "label:3 more idle in notes", "Show fewer idle");
  expect(app.shows("label:/^extra idle 5, /")).toBe(true);
  await app.press("label:Show fewer idle in notes");
  await app.waitUntil(() => !app.shows("label:/^extra idle 5, /"));
});

test("twenty blocked agents across five projects are twenty rows under five headers, and the one chip counts them", async () => {
  const app = await lab("storm");
  await app.waitFor("label:Need you, 20");
  for (const name of ["docs", "infra", "payments-api", "tools", "web"])
    expect(app.shows(`label:/^${name}, This computer, 4 need you/`)).toBe(true);
  // No second list and no row-by-row answer buttons: a row opens its agent.
  expect(app.count("label:/^Answer/")).toBe(0);
  expect(has(app, "Answer one by one")).toBe(false);
});

test("a project starts a chat in its own folder", async () => {
  const app = await lab();
  await app.waitFor("payments-api");
  await pressUntil(app, "label:New agent session in web", "new session in /home/dev/web");
});

test("with only this computer and nothing running the home points at adding a machine", async () => {
  const app = await lab("empty");
  await app.waitFor("Add your first machine");
  await app.press("Add machine");
  expect(has(app, "add machine asked")).toBe(true);
  expect(app.shows("label:Need you, 0")).toBe(false);
});

test("switching the colour scheme re-themes the table without breaking it", async () => {
  const app = await lab();
  await app.waitFor("label:Need you, 2");
  await app.setColorScheme("dark");
  await app.wait(300);
  expect(has(app, "payments review")).toBe(true);
  expect(app.shows("label:Need you, 2")).toBe(true);
});
