import { afterEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr, Sessions } from "herdr-desktop/native";
import { endSessions } from "./chat-parts-seam";

/**
 * `New agent session` and `Past sessions` against a real keeper driving herdr-mobile's scripted ACP agent (the engine's
 * test seam gives the local machine one agent, `omp`, and a home of its own).
 */
const DESKTOP = { width: 1280, height: 900 };

afterEach(() => endSessions());
const form = (params: Record<string, unknown> = {}) => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "new-session", ...params } } });

const FOLDER = "label:Folder *";
const OMP = "label:Agent *: omp";

/** The id of the session the lab reports opened, or undefined. */
const opened = (app: App) => app.texts().find((t) => t.startsWith("Opened local/"))?.slice("Opened local/".length);

/** Ends a session the test started: a keeper outlives the app by design, so a test must not leave one. */
async function end(app: App) {
  const id = opened(app);
  if (id) await Sessions.kill("local", id).catch(() => undefined);
}

test("the machine's agents are found, and one it can run is chosen", async () => {
  const app = await form();
  await app.waitFor(OMP);
  expect(app.enabled("Start")).toBe(true);
});

test("a folder is required, and Start says what is wrong instead of starting", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.press("Start");
  await app.waitFor("Enter the folder the agent works in.");
  expect(opened(app)).toBeUndefined();

  await app.type(FOLDER, "relative/path");
  await app.press("Start");
  await app.waitFor("Enter an absolute path on that machine, starting with / or ~/.");
  expect(opened(app)).toBeUndefined();
});

test("a folder that is not on the machine keeps what was typed and says what to do", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.type(FOLDER, "/nonexistent-herdr-desktop-folder");
  await app.type("label:First message (optional)", "do the thing");
  await app.press("Start");
  await app.waitFor("Check the folder: it must exist on This computer.");
  expect(app.texts().some((t) => t.includes("the folder does not exist on this host: /nonexistent-herdr-desktop-folder"))).toBe(true);
  expect(app.value(FOLDER)).toBe("/nonexistent-herdr-desktop-folder");
  expect(app.value("label:First message (optional)")).toBe("do the thing");
  expect(opened(app)).toBeUndefined();
});

test("a session starts, the first message goes to the agent, and the form remembers the folder and the agent", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.type(FOLDER, "/");
  await app.type("label:First message (optional)", "plain");
  await app.press("Start");
  await app.waitUntil(() => opened(app) !== undefined, { timeout: 20_000 });
  try {
    const id = opened(app)!;
    // The agent heard the message and answered it: a session the person did not have to open to get going.
    await app.waitUntil(
      () =>
        Sessions.items("local", id, 0, 50).some((i) => i.kind === "message" && i.role === "agent" && i.text === "Hello"),
      { timeout: 20_000 },
    );
    expect(Herdr.setting("newSession.agent.local")).toBe("omp");
    expect(Herdr.setting("newSession.folder.local")).toBe("/");

    // The next opening starts where this one ended.
    await app.press("Open the dialog");
    await app.waitFor(OMP);
    expect(app.value(FOLDER)).toBe("/");
  } finally {
    await end(app);
  }
});

test("a project's New session starts on its machine in its folder", async () => {
  const app = await form({ project: { machine: "local", folder: "/tmp" } });
  await app.waitFor(OMP);
  expect(app.value(FOLDER)).toBe("/tmp");
});

test("Browse folders walks the machine's folders and hands back the one chosen", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.type(FOLDER, "/");
  await app.press("Browse folders");
  await app.waitFor("Choose a folder");
  await app.waitFor("label:Open tmp");
  await app.press("label:Open tmp");
  await app.waitFor("label:Folders in /tmp");
  await app.press("Use this folder");
  await app.waitUntil(() => app.value(FOLDER) === "/tmp");
  expect(app.shows("Choose a folder")).toBe(false);
});

test("Past sessions opens from the form for the agent and folder chosen, and says when the agent keeps no list", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.press("Past sessions");
  await app.waitFor("This agent cannot list its past sessions");
  expect(app.texts().some((t) => t.startsWith("Conversations omp kept on"))).toBe(true);
});
