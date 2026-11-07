import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800 };
const FOLDER = "label:Folder *";

test("an agent starts in the folder asked, as the kind chosen, and the caller hears which pane to open", async () => {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("Open start agent");
  await app.type(FOLDER, "/home/dev/payments-api");
  await app.press("label:Agent: omp");
  await app.press("label:Claude Code");
  await app.press("Start agent");
  await app.waitFor("started local w9:p1");

  await app.press("Show requests");
  const asked = app.texts().find((t) => t.startsWith("workspace.create")) ?? "";
  const [create, start] = asked.split(" | ");
  expect(create).toContain('"cwd":"/home/dev/payments-api"');
  expect(start).toContain('agent.start');
  expect(start).toContain('"kind":"claude"');
  // the agent goes into the pane the new workspace made
  expect(start).toContain('"pane_id":"w9:p1"');
  await app.waitFor("Start agent", { state: "gone" });
});

test("nothing starts without a folder that is an absolute path, and Enter in the field asks the same question", async () => {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("Open start agent");
  const before = app.texts();
  await app.press("Start agent");
  expect(app.texts().filter((t) => !before.includes(t)).length).toBeGreaterThan(0);

  await app.type(FOLDER, "payments-api");
  await app.submit(FOLDER);
  await app.press("Show requests");
  expect(app.texts()).toContain("no requests");
  expect(app.texts()).toContain("nothing started");
  expect(app.shows("Start agent")).toBe(true);

  await app.clear(FOLDER);
  await app.type(FOLDER, "/home/dev/web");
  await app.submit(FOLDER);
  await app.waitFor("started local w9:p1");
});

test("a start that fails keeps the dialog and what was typed, says why, and can be tried again", async () => {
  const app = await open("./start-agent-lab.tsx", DESKTOP);
  await app.press("Open start agent");
  await app.type(FOLDER, "/home/dev/payments-api");
  const before = app.texts();
  await app.press("Start agent");
  await app.waitUntil(() => app.texts().some((t) => !before.includes(t) && t.includes("herdr")));
  expect(app.value(FOLDER)).toBe("/home/dev/payments-api");
  expect(app.texts()).toContain("nothing started");
  // the button is usable again: a second start asks herdr again
  await app.press("Start agent");
  await app.waitUntil(() => app.texts().some((t) => t.includes("herdr")));
  await app.press("Show requests");
  expect(app.texts()).toContain("2 workspace.create, 0 agent.start");
});
