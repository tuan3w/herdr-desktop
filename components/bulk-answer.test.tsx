import { Herdr } from "herdr-desktop/native";
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { pressSettled, quiet } from "../app-seam";
import storm from "../fixtures/herdr/storm.json";
import { scripted, sentKeys } from "./board-seam";

/**
 * The bulk answer view on `storm.json` (20 agents `job 1` to `job 20`, panes `w1:p1` to `w1:p20`, each asking to run
 * `touch .../xN.txt`; the menu is `1. Yes`, two standing grants, `4. No`). One gesture can answer several agents, so every
 * test here is about what is SENT: `sentKeys()` is the log of keys that reached a pane.
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
const VIEW = "label:Answer the agents that need you";
const COMMAND = /touch \/tmp\/hm-capture-claude\/[^\s\u001b]+/;

/** Opens the Board with the `Need you` chip on, past every row's 400 ms guard. */
async function view(width: number = DESKTOP.width) {
  const app = await open("./board-lab.tsx", { ...DESKTOP, width, host: { params: { fixture: "storm" } } });
  await app.waitFor("label:Need you, 20");
  await quiet(app);
  await pressSettled(app, "label:Need you, 20", () => app.shows(VIEW));
  await app.clock!.runFor(450);
  return app;
}
const has = (app: App, text: string) => app.texts().includes(text);
const ticked = (app: App) =>
  Number(
    app
      .texts()
      .find((t) => /^\d+ ticked$/.test(t))
      ?.split(" ")[0] ?? 0,
  );
const include = (n: number) => `label:Include job ${n}`;

/** Ticks the rows and waits until the view counts them (a press made while the list re-lays out can be lost). */
async function tick(app: App, ...jobs: number[]) {
  const before = ticked(app);
  for (const [i, n] of jobs.entries()) {
    await pressSettled(app, include(n), () => ticked(app) === before + i + 1);
  }
}
/** The fixture's screen for `pane` asking about `command`, without telling the app: only a re-read of the pane sees it. */
const screenWith = (pane: string, command: string) =>
  (storm.panes as Record<string, { screen: string[] }>)[pane].screen.map((r) => r.replace(COMMAND, command));
const keys = (...jobs: number[]) => jobs.map((n) => `w1:p${n}: 1 enter`);

test("nothing is ticked on arrival, by a chip change or by anything else, and there is no select-all", async () => {
  const app = await view();
  expect(ticked(app)).toBe(0);
  expect(app.enabled("Allow 0 commands")).toBe(false);
  expect(app.enabled("Decline 0")).toBe(false);
  for (const all of ["Select all", "Allow all", "Allow all commands"]) expect(app.shows(`label:${all}`)).toBe(false);
  // The whole command of a row is on screen beside its box.
  expect(has(app, "touch /tmp/hm-capture-claude/x7.txt")).toBe(true);

  await pressSettled(app, "label:Working, 0", () => !app.shows(VIEW));
  await pressSettled(app, "label:Need you, 20", () => app.shows(VIEW));
  expect(ticked(app)).toBe(0);
  // mod+a is not a select-all here.
  await app.keyboard.press("Control+a");
  expect(ticked(app)).toBe(0);
  expect(sentKeys()).toEqual([]);
});

test("ticking three of twenty names three on the button; the first press arms and sends nothing, the second sends exactly those", async () => {
  const app = await view();
  await tick(app, 2, 5, 9);
  expect(app.enabled("Allow 3 commands")).toBe(true);

  await app.press("Allow 3 commands");
  await app.waitFor("Press again to allow 3 · you read each command above");
  expect(sentKeys()).toEqual([]);

  await app.press("Press again to allow 3 · you read each command above");
  await app.waitUntil(() => sentKeys().length === 3);
  expect([...sentKeys()].sort()).toEqual(keys(2, 5, 9).sort());
  // The result stays and names every agent.
  await app.waitFor("Allowed 3: job 2, job 5, job 9");
  await app.clock!.runFor(20_000);
  expect(has(app, "Allowed 3: job 2, job 5, job 9")).toBe(true);
  expect(ticked(app)).toBe(0);
});

test("ticking another box after arming disarms: the next press arms again and sends nothing", async () => {
  const app = await view();
  await tick(app, 1, 2);
  await app.press("Allow 2 commands");
  await app.waitFor("Press again to allow 2 · you read each command above");

  await tick(app, 3);
  expect(app.shows("Allow 3 commands")).toBe(true);
  await app.press("Allow 3 commands");
  await app.waitFor("Press again to allow 3 · you read each command above");
  expect(sentKeys()).toEqual([]);

  // Unticking disarms as well.
  await pressSettled(app, include(3), () => ticked(app) === 2);
  expect(app.shows("Allow 2 commands")).toBe(true);
  expect(sentKeys()).toEqual([]);
});

test("four seconds of waiting arm nothing and send nothing; a press after that only arms again", async () => {
  const app = await view();
  await tick(app, 4);
  await app.press("Allow 1 command");
  await app.waitFor("Press again to allow 1 · you read each command above");
  await app.clock!.runFor(4200);
  expect(app.shows("Allow 1 command")).toBe(true);
  await app.clock!.runFor(120_000);
  expect(sentKeys()).toEqual([]);
  await app.press("Allow 1 command");
  await app.waitFor("Press again to allow 1 · you read each command above");
  expect(sentKeys()).toEqual([]);
});

test("a question that changed after it was shown is refused on its row, unticked, and gets no keys while the others are sent", async () => {
  const app = await view();
  await tick(app, 1, 2, 3);
  await app.press("Allow 3 commands");
  await app.waitFor("Press again to allow 3 · you read each command above");
  // The pane of job 2 shows another command; this window has not heard of it, so only the re-read before sending sees it.
  Herdr.testSetScreen("w1:p2", screenWith("w1:p2", "cat ~/.ssh/id_rsa"));
  await app.press("Press again to allow 3 · you read each command above");
  await app.waitUntil(() => sentKeys().length === 2);
  await app.waitFor("The question changed");
  expect([...sentKeys()].sort()).toEqual(keys(1, 3));
  expect(sentKeys().some((k) => k.startsWith("w1:p2:"))).toBe(false);
  expect(ticked(app)).toBe(0);
  await app.waitFor("Allowed 2: job 1, job 3 · 1 not sent: job 2 (the question changed)");
});

test("a ticked row whose question changes on the board is unticked, nothing is sent for it, and the armed button disarms", async () => {
  const app = await view();
  await tick(app, 1, 2);
  await app.press("Allow 2 commands");
  await app.waitFor("Press again to allow 2 · you read each command above");
  scripted("storm").ask("w1:p2", "cat README.md");
  await app.waitUntil(() => ticked(app) === 1);
  await app.waitFor("The question changed");
  expect(app.shows("Allow 1 command")).toBe(true);
  expect(sentKeys()).toEqual([]);
  // The new question is not ticked, and for 400 ms ignores a tick.
  await app.press(include(2));
  expect(ticked(app)).toBe(1);
  await app.clock!.runFor(450);
  await pressSettled(app, include(2), () => ticked(app) === 2);
});

test("a new question anywhere disarms a press that was waiting for its second", async () => {
  const app = await view();
  await tick(app, 1);
  await app.press("Allow 1 command");
  await app.waitFor("Press again to allow 1 · you read each command above");
  scripted("storm").ask("w1:p15", "cat README.md");
  // Waiting for the new command to show, never for the button to turn back: the 4 s timer would do that by itself.
  await app.waitFor("cat README.md");
  expect(app.shows("Allow 1 command")).toBe(true);
  await app.press("Allow 1 command");
  expect(sentKeys()).toEqual([]);
});

test("a risky row has a box that cannot be ticked and says where to answer", async () => {
  const app = await view();
  // Every allow of this menu grants something that lasts: there is no plain allow to send.
  const rows = (storm.panes as Record<string, { screen: string[] }>)["w1:p6"].screen.filter(
    (r) => !r.includes("1. ") && !r.includes("3. "),
  );
  scripted("storm").show("w1:p6", rows);
  await app.waitUntil(() => app.texts().some((t) => t.endsWith("Answer in its own tab")));
  await app.clock!.runFor(450);
  expect(app.enabled(include(6))).toBe(false);
  expect(ticked(app)).toBe(0);
  expect(sentKeys()).toEqual([]);
});

test("Decline 3 sends each row's decline and never its allow", async () => {
  const app = await view();
  await tick(app, 3, 4, 8);
  await app.press("Decline 3");
  await app.waitUntil(() => sentKeys().length === 3);
  expect([...sentKeys()].sort()).toEqual(["w1:p3: 4 enter", "w1:p4: 4 enter", "w1:p8: 4 enter"]);
  await app.waitFor("Declined 3: job 3, job 4, job 8");
});

test("an agent that stops needing you between ticks leaves the selection", async () => {
  const app = await view();
  await tick(app, 1, 2);
  scripted("storm").become("w1:p1", "working");
  await app.waitUntil(() => ticked(app) === 1);
  expect(app.shows("Allow 1 command")).toBe(true);
  await app.press("Allow 1 command");
  await app.waitFor("Press again to allow 1 · you read each command above");
  await app.press("Press again to allow 1 · you read each command above");
  await app.waitUntil(() => sentKeys().length === 1);
  expect(sentKeys()).toEqual(keys(2));
});

test("a row ignores a tick for 400 ms after its question appears", async () => {
  const app = await view();
  scripted("storm").ask("w1:p1", "cat README.md");
  await app.waitFor("cat README.md");
  await app.press(include(1));
  expect(ticked(app)).toBe(0);
  await app.clock!.runFor(450);
  await pressSettled(app, include(1), () => ticked(app) === 1);
});

test("a command taller than its box shows in full and needs Show all before its box can be ticked", async () => {
  // A narrow window, because the engine marks a command of more than a few rows risky (`long command`, so it has no
  // plain allow): what is left to tick is a command whose lines wrap past the box's eight lines.
  const app = await view(360);
  const lines = Array.from({ length: 3 }, (_, i) => ` echo step ${i + 1} ${"abcdefghij ".repeat(11)}`);
  const screen = (storm.panes as Record<string, { screen: string[] }>)["w1:p5"].screen;
  // The box between the dashed rules, not the earlier `⎿ $ touch ...` line.
  const at = screen.findIndex((r) => r.startsWith(" touch "));
  scripted("storm").show("w1:p5", [...screen.slice(0, at), ...lines, ...screen.slice(at + 1)]);
  await app.waitUntil(() => app.texts().some((t) => t.includes("echo step 3 ")));
  await app.clock!.runFor(450);
  // Every line is in the text of the row, though the box shows only part of it.
  for (const n of [1, 3]) expect(app.texts().some((t) => t.includes(`echo step ${n} `))).toBe(true);

  await app.press(include(5));
  expect(ticked(app)).toBe(0);
  await app.waitFor("Show all of the command before ticking");
  const showAll = () => app.texts().find((t) => /^Show all \d+ lines$/.test(t)) ?? "Show all";
  await pressSettled(app, showAll(), () => app.shows("Show fewer lines"));
  await pressSettled(app, include(5), () => ticked(app) === 1);
});

test("a row picked in the table gets the bulk bar, but not a Select all, while the answer view is open", async () => {
  const app = await view();
  await pressSettled(app, "label:Select job 3", "1 selected");
  expect(has(app, "Stop")).toBe(true);
  expect(has(app, "Select all")).toBe(false);
  // Picking for Stop is not ticking for an answer.
  expect(ticked(app)).toBe(0);
});
