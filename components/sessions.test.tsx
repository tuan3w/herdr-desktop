import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The `Sessions` module end to end: a real keeper (herdr-mobile's script) driving its scripted ACP agent, in a home of its own. */
const DESKTOP = { width: 1280, height: 800 };

/** Presses `button` until `done` shows: an answer within 400 ms of its request appearing is refused, so the first press may not count. */
async function pressUntil(app: App, button: string, done: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!app.shows(done)) {
    if (Date.now() > deadline) throw new Error(`pressing "${button}" never showed "${done}"; on screen: ${JSON.stringify(app.texts())}`);
    await app.press(button);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a session starts, answers, and a request that needs the person reaches the board and waits for the person", async () => {
  const app = await open("./sessions-lab.tsx", DESKTOP);
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  // The scripted agent reports only the older `modes` shape: its one choice is listed as the mode setting.
  expect(app.shows("Options: Mode")).toBe(true);

  await app.press("Say plain");
  await app.waitFor("Agent said: Hello");

  await app.press("Say ask");
  await app.waitFor("Phase: blockedOnPermission");
  await app.waitFor("Waiting: permission Run: ls -la [Allow once, Reject]");
  // The same count the terminal agents feed: the person is told once, in one place.
  await app.waitFor("Needs you on the board: 1");

  // Nothing is sent for what the person did not see.
  await app.press("Allow with an old digest");
  await app.waitFor("result changed: The question changed");
  expect(app.shows("Phase: blockedOnPermission")).toBe(true);

  // Pressed within 400 ms of the request appearing, an answer is refused; later it goes through.
  await pressUntil(app, "Allow once", "result done");
  await app.waitFor("Phase: blockedOnQuestion");
  await pressUntil(app, "Answer the question", "Phase: idle");
  expect(app.shows("Needs you on the board: 0")).toBe(true);
  expect(app.shows("Title: Fake title")).toBe(true);

  await app.press("End the session");
  await app.waitFor("result ended");
});
