import { Sessions } from "herdr-desktop/native";
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * Where a chat's question stands and what its header says: the one answer dock takes the message box's place while the
 * agent asks and gives it back with what was typed; the header is one line and its title opens the session's facts.
 * Through `session-lab.tsx`: a scripted port for the header, a real keeper for a question that really arrives.
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const BOX = "label:Message";

/** Presses `button` until `done` is true: an answer that just appeared ignores presses for 400 ms. */
async function pressUntil(app: App, button: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(`pressing "${button}" never did it; on screen: ${JSON.stringify(app.texts())}`);
    await app.press(button).catch(() => undefined);
    await app.wait(25);
  }
}

test("the header is one line with the title and no state word, no Details button; the title opens the session's facts", async () => {
  const app = await open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene: "chat" } } });
  await app.waitFor(BOX);
  expect(app.texts()).toContain("Fix the login redirect");
  expect(app.shows("Details")).toBe(false);
  expect(app.shows("Ready")).toBe(false);
  expect(app.shows("Session details")).toBe(false);

  await app.press("label:/, session details$/");
  await app.waitFor("Session details");
  expect(app.shows("Copy id")).toBe(true);
  expect(app.shows("End session")).toBe(true);
});

test("a question takes the message box's place; what was typed is there when the question is answered", async () => {
  const app = await open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "keeper" } } });
  await app.waitFor(BOX);
  await app.waitUntil(() => app.enabled(BOX));
  const id = (await Sessions.list("local"))[0]!.id;

  await app.type(BOX, "a thought not sent yet");
  await Sessions.send("local", id, "ask", [], []);
  await app.waitFor("label:Permission request");
  // The dock stands where the box was: the box is not under it, and the dock took no focus.
  expect(app.shows(BOX)).toBe(false);

  await pressUntil(app, "label:Allow once", () => app.shows("label:Question from the agent"));
  expect(app.shows(BOX)).toBe(false);
  await pressUntil(app, "Decline", () => app.shows(BOX));
  expect(app.value(BOX)).toBe("a thought not sent yet");
});
