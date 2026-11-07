import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import { scripted, sentKeys } from "./board-seam";

/** `Answer one by one` against `mixed.json` (2 need you) and `storm.json` (20 need you). */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
const lab = (fixture = "mixed") => open("./board-lab.tsx", { ...DESKTOP, host: { params: { fixture } } });
const has = (app: App, text: string) => app.texts().includes(text);

async function start(app: App, total: string) {
  await app.waitFor("Answer one by one");
  await app.press("Answer one by one");
  await app.waitFor(`1 of ${total} need you`);
}

test("the walk starts with the agent that has waited longest and shows its question and answers", async () => {
  const app = await lab();
  await start(app, "2");
  await app.waitFor("Do you want to proceed?");
  expect(app.shows("label:/^Message claude/")).toBe(true);
  expect(has(app, "touch /tmp/hm-capture-claude/x.txt")).toBe(true);
  expect(app.shows("label:1. Yes")).toBe(true);
});

test("Next agent and Previous agent walk the list and wrap, and the agent being read does not change by itself", async () => {
  const app = await lab();
  await start(app, "2");
  await app.press("Next agent");
  await app.waitFor("2 of 2 need you");
  await app.press("Next agent");
  await app.waitFor("1 of 2 need you");
  await app.press("Previous agent");
  await app.waitFor("2 of 2 need you");
  expect(app.shows("label:/^Message omp/")).toBe(true);
});

test("answering sends to the agent in view, and when it stops waiting the walk goes on to the next", async () => {
  const app = await lab();
  await start(app, "2");
  await app.waitFor("Do you want to proceed?");
  await app.clock!.runFor(450);
  // The board behind the dialog has the same agent's answers: the dialog's are the later ones.
  await app.press("label:1. Yes >> nth=1");
  await app.waitUntil(() => sentKeys().length === 1);
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);

  scripted("mixed").become("w1:p1", "working");
  await app.waitFor("1 of 1 need you");
  expect(app.shows("label:/^Message omp/")).toBe(true);
  expect(app.shows("label:/^Message claude/")).toBe(false);
});

test("when the last agent has been answered the dialog says All clear", async () => {
  const app = await lab();
  await start(app, "2");
  const agents = scripted("mixed");
  agents.become("w1:p1", "working");
  agents.become("w1:p2", "working");
  await app.waitFor("All clear");
  expect(app.texts().some((t) => t.includes("need you") && t.startsWith("1 of"))).toBe(false);
});

test("a message typed in the dialog goes to the agent in view and presses Enter", async () => {
  const app = await lab();
  await start(app, "2");
  await app.type("label:/^Message /", "use the staging key");
  await app.keyboard.press("enter");
  await app.waitUntil(() => Herdr.testRequests("pane.send_input").length === 1);
  expect(Herdr.testRequests("pane.send_input")[0].params).toMatchObject({ pane_id: "w1:p1", text: "use the staging key", keys: ["enter"] });
});

test("twenty waiting agents are twenty steps, and the walk reaches the last", async () => {
  const app = await lab("storm");
  await start(app, "20");
  await app.press("Previous agent");
  await app.waitFor("20 of 20 need you");
  expect(app.shows("label:/^Message claude/")).toBe(true);
  await app.press("Next agent");
  await app.waitFor("1 of 20 need you");
});
