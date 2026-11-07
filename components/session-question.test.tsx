import { afterEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { endSessions } from "./chat-parts-seam";

/**
 * The form of an agent's question. The form's fields run against a made-up `SessionView` (a session that does not
 * exist: an answer is refused by the engine, and that refusal on screen is how a test knows it was sent); the answer
 * that reaches an agent runs against herdr-mobile's scripted ACP agent behind a real keeper.
 */
const DESKTOP = { width: 1280, height: 900, clock: {} };

afterEach(() => endSessions());
const synthetic = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "synthetic", variant: "question" } } });
const live = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "live" } } });

const NAME = "label:Project name *";
const REFUSED = "Not sent: The session is not running";
const attempted = (app: App) => app.texts().includes(REFUSED);

/** Moves past the 400 ms guard that follows a form appearing. */
async function settle(app: App) {
  await app.waitFor("label:Question from the agent");
  await app.clock!.runFor(450);
}

/** Presses until `done` shows: the engine refuses a press within 400 ms of the request on its own clock. */
async function pressUntil(app: App, button: string, done: string) {
  const deadline = Date.now() + 10_000;
  while (!app.texts().some((t) => t.includes(done))) {
    if (Date.now() > deadline) throw new Error(`pressing ${button} never showed ${done}; on screen: ${JSON.stringify(app.texts())}`);
    // The press that went through removes the button before the phase on screen has caught up: wait for it instead.
    if (!app.shows(button)) {
      await app.waitUntil(() => app.texts().some((t) => t.includes(done)));
      return;
    }
    await app.press(button);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("every field of the form is there under its own name, with the agent's defaults and help", async () => {
  const app = await synthetic();
  await settle(app);
  expect(app.texts()).toContain("Set up the project");
  expect(app.texts()).toContain("The agent needs a few answers before it continues.");
  expect(app.value(NAME)).toBe("demo");
  expect(app.value("label:How many")).toBe("3");
  const names = ["label:Red", "label:Green", "label:Blue", "label:Tests", "label:Docs", "label:CI", "label:Yes", "label:No", "label:City: not selected", "Accept", "Decline"];
  expect(names.filter((n) => !app.shows(n))).toEqual([]);
  // A secret is shown like any other field, and the form says it is not a safe place for one.
  expect(app.texts().some((t) => t.includes("A form is not a safe place for one"))).toBe(true);
  // What the app cannot draw is said, not dropped silently.
  expect(app.texts().some((t) => t.startsWith("Attachment: this app cannot show this field"))).toBe(true);
});

test("nothing is sent by itself, however long the form waits", async () => {
  const app = await synthetic();
  await settle(app);
  await app.clock!.runFor(120_000);
  expect(attempted(app)).toBe(false);
});

test("the buttons are dimmed and deaf the moment the form appears, and work once the guard has passed", async () => {
  const app = await synthetic();
  await app.waitFor("label:Question from the agent");
  expect(app.enabled("Accept")).toBe(false);
  expect(app.enabled("Decline")).toBe(false);
  // Enter inside a field is no way around the guard.
  await app.submit(NAME);
  expect(attempted(app)).toBe(false);

  await app.clock!.runFor(450);
  expect(app.enabled("Accept")).toBe(true);
  await app.press("Accept");
  await app.waitFor(REFUSED);
});

test("Decline sends only when pressed", async () => {
  const app = await synthetic();
  await settle(app);
  await app.clock!.runFor(120_000);
  expect(attempted(app)).toBe(false);
  await app.press("Decline");
  await app.waitFor(REFUSED);
});

test("Enter submits from inside a field and from nowhere else", async () => {
  const app = await synthetic();
  await settle(app);
  await app.keyboard.press("enter");
  expect(attempted(app)).toBe(false);

  await app.type(NAME, "x");
  expect(attempted(app)).toBe(false);
  await app.submit(NAME);
  await app.waitFor(REFUSED);
});

test("a question that changes starts the guard again", async () => {
  const app = await synthetic();
  await settle(app);
  await app.press("Another request");
  await app.waitFor("label:Question from the agent");
  expect(app.enabled("Accept")).toBe(false);
  await app.clock!.runFor(450);
  expect(app.enabled("Accept")).toBe(true);
});

test("what was typed survives a permission taking the dock, and the form comes back as it was left", async () => {
  const app = await synthetic();
  await settle(app);
  await app.type(NAME, "-two");
  expect(app.value(NAME)).toBe("demo-two");

  await app.press("A permission takes the dock");
  await app.waitFor("label:Permission request");
  expect(app.shows("label:Question from the agent")).toBe(false);

  await app.press("The first request is answered");
  await app.waitFor("label:Question from the agent");
  expect(app.value(NAME)).toBe("demo-two");
});

test("requests queued behind the form are counted", async () => {
  const app = await synthetic();
  await settle(app);
  await app.press("Queue one more");
  await app.waitFor("1 more waiting");
  expect(app.shows("label:Question from the agent")).toBe(true);
});

test("an answer reaches the agent: the chosen option is what it hears", async () => {
  const app = await live();
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  await app.press("Say ask");
  await app.waitFor("label:Permission request");
  await app.clock!.runFor(450);
  await pressUntil(app, "label:Allow once", "Phase: blockedOnQuestion");
  await app.waitFor("label:Question from the agent");
  await app.clock!.runFor(450);
  expect(app.texts().some((t) => t.startsWith("Pick one?"))).toBe(true);

  await app.press("label:b");
  await pressUntil(app, "Accept", "answered:allow/accept");
  await app.waitFor("Phase: idle");
  expect(app.shows("label:Question from the agent")).toBe(false);
});

test("declining tells the agent so", async () => {
  const app = await live();
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  await app.press("Say ask");
  await app.waitFor("label:Permission request");
  await app.clock!.runFor(450);
  await pressUntil(app, "label:Allow once", "Phase: blockedOnQuestion");
  await app.waitFor("label:Question from the agent");
  await app.clock!.runFor(450);
  await pressUntil(app, "Decline", "answered:allow/decline");
  await app.waitFor("Phase: idle");
});
