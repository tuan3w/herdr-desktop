import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import { scripted, sentKeys } from "./board-seam";

/** Picking agents and acting on them, against `mixed.json`: working `Refactor ledger` (w1:p4) and `upgrade deps` (w1:p5), waiting `payments review` (w1:p1). */
const DESKTOP = { width: 1280, height: 800, platform: "linux", clock: {} } as const;
const lab = () => open("./board-lab.tsx", { ...DESKTOP, host: { params: { fixture: "mixed" } } });
const has = (app: App, text: string) => app.texts().includes(text);
const inBar = "label:Selected agents >> ";

async function pick(app: App, ...names: string[]) {
  await app.waitFor("Working");
  for (const name of names) await app.press(`label:Select ${name}`);
}

test("the bar shows only while something is picked, with how many, and clearing hides it", async () => {
  const app = await lab();
  await app.waitFor("Working");
  expect(has(app, "Stop")).toBe(false);
  await pick(app, "Refactor ledger", "upgrade deps");
  expect(has(app, "2 selected")).toBe(true);
  await app.press("label:Clear selection");
  expect(app.shows("label:Selected agents")).toBe(false);
});

test("Shift picks everything between the last box toggled and this one", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger");
  await app.keyboard.down("shift");
  await app.press("label:Select scripts");
  await app.keyboard.up("shift");
  // Refactor ledger, upgrade deps, then the idle rows down to scripts: more than the two ends.
  const n = Number(app.texts().find((t) => /^\d+ selected$/.test(t))!.split(" ")[0]);
  expect(n).toBeGreaterThan(2);
  expect(app.shows("label:Select upgrade deps")).toBe(true);
});

test("Stop sends Esc to each agent picked, after asking, and says what it did", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger", "upgrade deps");
  await app.press(`${inBar}Stop`);
  await app.waitFor("Stop 2 agents");
  expect(sentKeys()).toEqual([]);

  await app.press("text:Stop 2 agents");
  await app.waitFor("Stopped 2 agents");
  expect(sentKeys().sort()).toEqual(["w1:p4: esc", "w1:p5: esc"]);
  expect(has(app, "2 selected")).toBe(false);
});

test("Cancel sends nothing and keeps the picks", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger");
  await app.press(`${inBar}Stop`);
  await app.press("Cancel");
  expect(sentKeys()).toEqual([]);
  await app.clock!.runFor(400);
  expect(has(app, "1 selected")).toBe(true);
});

test("an agent waiting on a question is listed as skipped and untouched, and Send anyway brings it in", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger", "payments review");
  await app.press(`${inBar}Stop`);
  await app.waitFor("Waiting for an answer (skipped)");
  expect(has(app, "Stop 1 agent")).toBe(true);

  await app.press("text:Stop 1 agent");
  await app.waitFor("Stopped 1 agent");
  expect(sentKeys()).toEqual(["w1:p4: esc"]);
});

test("Send anyway is off when the dialog opens, and turning it on includes the waiting agent", async () => {
  const app = await lab();
  await pick(app, "payments review");
  await app.press(`${inBar}Stop`);
  await app.waitFor("Waiting for an answer (skipped)");
  // Nothing can be reached yet: the button is disabled, so a press finds nothing to press and nothing is sent.
  await app.press("text:Stop 0 agents").catch(() => undefined);
  expect(sentKeys()).toEqual([]);

  await app.press("label:Send anyway");
  await app.waitFor("Stop 1 agent");
  await app.press("text:Stop 1 agent");
  await app.waitFor("Stopped 1 agent");
  expect(sentKeys()).toEqual(["w1:p1: esc"]);
});

test("a message is typed into each agent picked and Enter pressed", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger", "upgrade deps");
  await app.press(`${inBar}Message`);
  await app.waitFor("Message 2 agents");
  // An empty message is not sent.
  await app.press("text:Message 2 agents").catch(() => undefined);
  expect(Herdr.testRequests("pane.send_input")).toEqual([]);
  await app.type("label:Message", "wrap up and commit");
  await app.press("text:Message 2 agents");
  await app.waitFor("Messaged 2 agents");
  const sent = Herdr.testRequests("pane.send_input").map((r) => r.params);
  expect(sent).toHaveLength(2);
  for (const params of sent) expect(params).toMatchObject({ text: "wrap up and commit", keys: ["enter"] });
});

test("Close closes the panes only after the dialog is confirmed", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger");
  await app.press(`${inBar}Close`);
  await app.waitFor("Close 1 agent");
  expect(Herdr.testRequests("pane.close")).toEqual([]);
  await app.press("text:Close 1 agent");
  await app.waitFor("Closed 1 agent");
  expect(Herdr.testRequests("pane.close").map((r) => r.params)).toEqual([{ pane_id: "w1:p4" }]);
});

test("an agent that leaves the board leaves the picks and the dialog's list, which is worked out again from live data", async () => {
  const app = await lab();
  await pick(app, "Refactor ledger", "upgrade deps");
  await app.press(`${inBar}Stop`);
  await app.waitFor("Stop 2 agents");
  scripted("mixed").remove("w1:p5");
  await app.waitFor("Stop 1 agent");
  expect(has(app, "1 selected")).toBe(true);
  await app.press("text:Stop 1 agent");
  await app.waitFor("Stopped 1 agent");
  expect(sentKeys()).toEqual(["w1:p4: esc"]);
});
