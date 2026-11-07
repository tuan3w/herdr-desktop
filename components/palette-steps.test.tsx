import { Sessions } from "herdr-desktop/native";
import { afterEach, expect, open, test } from "nsh/test";

import { endSessions } from "./chat-parts-seam";

/**
 * A command with steps, in the palette lab (`payments` is moved to a folder that exists, and the test seam's keeper
 * drives a scripted agent): `New agent session in…` asks for a project, then an agent, then starts a chat.
 */
afterEach(() => endSessions());

const lab = () => open("./palette-lab.tsx", { width: 1280, height: 800, platform: "linux" });
const FIELD = "label:Search agents, projects and commands";
const PROJECT = "label:Choose a project";
const AGENT = "label:Choose an agent";

async function atProjectStep(app: Awaited<ReturnType<typeof lab>>) {
  // The board arrives from the scripted herdr a moment after the lab opens.
  await app.wait(600);
  await app.press("Open palette");
  await app.waitFor(FIELD);
  await app.type(FIELD, "new session pay");
  await app.waitFor(PROJECT);
}

test("a project, then an agent, then a chat is started in the project's folder", async () => {
  const app = await lab();
  await atProjectStep(app);
  expect(app.value(PROJECT)).toBe("pay");
  await app.press("label:/^project, payments/");
  await app.waitFor(AGENT);
  expect(app.shows("New agent session in")).toBe(true);
  expect(app.shows("payments")).toBe(true);
  // The agents the machine can run are listed.
  await app.waitFor("label:/^omp/");
  await app.press("label:/^omp/");
  await app.waitUntil(() => !app.shows(AGENT));
  let held = await Sessions.list("local");
  for (let tries = 0; held.length === 0 && tries < 50; tries++) {
    await app.wait(100);
    held = await Sessions.list("local");
  }
  expect(held).toHaveLength(1);
});

test("Backspace on an empty field takes the last chip off, one step at a time", async () => {
  const app = await lab();
  await atProjectStep(app);
  await app.press("label:/^project, payments/");
  await app.waitFor(AGENT);
  await app.keyboard.press("backspace");
  await app.waitFor(PROJECT);
  expect(app.shows("label:Search agents, projects and commands")).toBe(false);
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  // `pay` went letter by letter, then the chip.
  await app.waitFor(FIELD);
  expect(app.shows("New agent session in")).toBe(false);
});

test("Escape steps back one layer at a time and then closes", async () => {
  const app = await lab();
  await atProjectStep(app);
  await app.press("label:/^project, payments/");
  await app.waitFor(AGENT);
  await app.keyboard.press("escape");
  await app.waitFor(PROJECT);
  await app.clear(PROJECT);
  await app.keyboard.press("escape");
  await app.waitFor(FIELD);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows(FIELD));
});
