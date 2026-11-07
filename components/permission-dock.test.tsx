import { afterEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { endSessions } from "./chat-parts-seam";

/**
 * The permission dock of an agent session. Rules that need a request the scripted agent cannot make (a risky command,
 * a standing grant, a queue, a command too long for its box) run against a made-up `SessionView` of a session that does
 * not exist: an answer then reaches no agent and the engine refuses it, and that refusal on screen is how a test knows a
 * press went all the way to sending. The rules that need a real keeper run against herdr-mobile's scripted ACP agent.
 */
const DESKTOP = { width: 1280, height: 800, clock: {} };

afterEach(() => endSessions());
const synthetic = (variant: string, platform?: "macos", bare = false) => open("./chat-parts-lab.tsx", { ...DESKTOP, platform, host: { params: { part: "synthetic", variant, bare } } });
const live = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "live" } } });

const ALLOW = "label:Allow once";
const ALWAYS = "label:/^Always allow/";
const REJECT = "label:Reject";
const CANCEL = "Cancel request";

/** What the dock says when an answer went all the way to sending and the engine refused it (there is no such session). */
const REFUSED = "Not sent: The session is not running";
const attempted = (app: App) => app.texts().includes(REFUSED);
const armedWith = (app: App, reason: string) => app.texts().includes(`Press again to send · ${reason}`);

/** Moves past the 400 ms guard that follows a request appearing. */
async function settle(app: App, shown = "Permission request") {
  await app.waitFor(`label:${shown}`);
  await app.clock!.runFor(450);
}

/** Presses until `done` shows: the engine refuses a press within 400 ms of the request on its own clock, which a test cannot move. */
async function pressUntil(app: App, button: string, done: string) {
  const deadline = Date.now() + 10_000;
  while (!app.texts().some((t) => t.startsWith(done))) {
    if (Date.now() > deadline) throw new Error(`pressing ${button} never showed ${done}; on screen: ${JSON.stringify(app.texts())}`);
    // The press that went through removes the button before the phase on screen has caught up: wait for it instead.
    if (!app.shows(button)) {
      await app.waitUntil(() => app.texts().some((t) => t.startsWith(done)));
      return;
    }
    await app.press(button);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("nothing is sent by itself, however long the request waits", async () => {
  const app = await synthetic("plain");
  await settle(app);
  await app.clock!.runFor(120_000);
  expect(app.shows("label:Permission request")).toBe(true);
  expect(attempted(app)).toBe(false);
});

test("the command being approved is shown whole, with the agent's own answers beside it", async () => {
  const app = await synthetic("long");
  await app.waitFor("label:Permission request");
  const command = Array.from({ length: 120 }, (_, i) => `echo step${i}`).join(" && ");
  expect(app.texts()).toContain(command);
  expect(app.shows(ALLOW)).toBe(true);
  expect(app.shows(REJECT)).toBe(true);
});

test("an answer pressed the moment the request appears is ignored, and works once the guard has passed", async () => {
  const app = await synthetic("plain");
  await app.waitFor("label:Permission request");
  await app.press(ALLOW);
  await app.clock!.runFor(100);
  await app.press(ALLOW);
  await app.clock!.runFor(50);
  expect(attempted(app)).toBe(false);

  await app.clock!.runFor(400);
  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("a request that changes starts the guard again: the press meant for the old one sends nothing", async () => {
  const app = await synthetic("plain");
  await settle(app);
  await app.press("Another request");
  await app.waitFor("git push --force origin main");
  await app.press(ALLOW);
  expect(attempted(app)).toBe(false);

  await app.clock!.runFor(450);
  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("a risky command is two presses: the first says why, and it is never sent by waiting", async () => {
  const app = await synthetic("risky");
  await settle(app);
  expect(app.texts()).toContain("Take a second look: pushes to a remote");

  await app.press(ALLOW);
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  expect(attempted(app)).toBe(false);

  await app.clock!.runFor(3900);
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  await app.clock!.runFor(200);
  expect(armedWith(app, "pushes to a remote")).toBe(false);
  expect(attempted(app)).toBe(false);

  // Disarmed: the next press arms again instead of sending; the one after sends.
  await app.press(ALLOW);
  expect(attempted(app)).toBe(false);
  await app.press("label:/^Allow once\\. Press again/");
  await app.waitFor(REFUSED);
});

test("a standing grant is two presses and says it is permanent", async () => {
  const app = await synthetic("risky");
  await settle(app);
  await app.press(ALWAYS);
  expect(armedWith(app, "pushes to a remote · grants this permanently")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.press("label:/^Always allow\\. Press again/");
  await app.waitFor(REFUSED);
});

test("rejecting is one press even when allowing would take two", async () => {
  const app = await synthetic("risky");
  await settle(app);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("arming one risky answer and pressing the safe one sends the safe one at once", async () => {
  const app = await synthetic("risky");
  await settle(app);
  await app.press(ALLOW);
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("a new request disarms an answer that was waiting for its second press", async () => {
  const app = await synthetic("risky");
  await settle(app);
  await app.press(ALLOW);
  await app.press("Another request");
  await app.waitFor("git push --force origin main");
  expect(armedWith(app, "pushes to a remote")).toBe(false);
  await app.clock!.runFor(450);
  await app.press(ALLOW);
  expect(attempted(app)).toBe(false);
});

test("a command too long for its box says how much is below, and the first allow reads to the end instead of sending", async () => {
  const app = await synthetic("long");
  await settle(app);
  expect(app.texts().some((t) => /^More below · \d+ lines$/.test(t))).toBe(true);

  await app.press(ALLOW);
  expect(attempted(app)).toBe(false);
  expect(app.texts()).toContain("Read it all, then press again.");

  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("a long and risky command asks to be read and to be confirmed in the same press, then sends on the next", async () => {
  const app = await synthetic("longRisky");
  await settle(app);
  await app.press(ALLOW);
  expect(app.texts()).toContain("Read it all, then press again.");
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.press("label:/^Allow once\\. Press again/");
  await app.waitFor(REFUSED);
});

test("rejecting a long command needs no reading", async () => {
  const app = await synthetic("long");
  await settle(app);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("Read all shows the whole command in a dialog, and having read it the allow goes through", async () => {
  const app = await synthetic("long");
  await settle(app);
  await app.press("Read all");
  await app.waitFor("The whole command");
  await app.press("Close");
  expect(app.shows("The whole command")).toBe(false);
  await app.clock!.runFor(400);
  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("requests queued behind this one are counted, and when it is answered elsewhere the dock goes", async () => {
  const app = await synthetic("plain");
  await settle(app);
  await app.press("Queue one more");
  await app.waitFor("1 more waiting");
  await app.press("Answered elsewhere");
  await app.waitFor("Waiting: 0");
  expect(app.shows("label:Permission request")).toBe(false);
});

test("Cancel request is a press like any other: guarded, and sent only by the person", async () => {
  const app = await synthetic("plain");
  await app.waitFor("label:Permission request");
  await app.press(CANCEL);
  expect(attempted(app)).toBe(false);
  await app.clock!.runFor(450);
  await app.press(CANCEL);
  await app.waitFor(REFUSED);
});

// Headless Tab only reaches pressable views on the macOS idiom; the rule under test is the same on every platform.
test("the digits answer only while an answer has the focus, and a risky one still needs its second press", async () => {
  const app = await synthetic("risky", "macos", true);
  await settle(app);
  await app.keyboard.press("1");
  expect(armedWith(app, "pushes to a remote")).toBe(false);
  expect(attempted(app)).toBe(false);

  await app.keyboard.press("tab");
  await app.keyboard.press("1");
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.keyboard.press("1");
  await app.waitFor(REFUSED);
});

test("the dock never takes the focus: a key pressed on arrival reaches no answer", async () => {
  const app = await synthetic("plain", "macos", true);
  await settle(app);
  await app.keyboard.press("enter");
  await app.keyboard.press("space");
  await app.keyboard.press("1");
  expect(attempted(app)).toBe(false);
});

test("an agent's request shows what it said before asking, and the answer reaches it", async () => {
  const app = await live();
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  await app.press("Say ask");
  await app.waitFor("Phase: blockedOnPermission");
  await app.waitFor("label:Permission request");
  await app.clock!.runFor(450);
  // The command is the agent's own title for the call, whole; what it wrote just before is above it.
  expect(app.texts()).toContain("Run: ls -la");
  expect(app.texts()).toContain("The agent said before asking");
  expect(app.texts()).toContain("thinking");

  await pressUntil(app, ALLOW, "Phase: blockedOnQuestion");
  // The agent went on to its next request: a question, which has its own form.
  await app.waitFor("Phase: blockedOnQuestion");
  expect(app.shows("label:Permission request")).toBe(false);
});

test("a request that changed under the person's eyes sends nothing and says so", async () => {
  const app = await live();
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  await app.press("Say ask");
  await app.waitFor("label:Permission request");
  await app.press("Show a stale request");
  await app.clock!.runFor(450);
  await pressUntil(app, ALLOW, "The request changed");
  expect(app.shows("Phase: blockedOnPermission")).toBe(true);
  expect(app.shows("label:Permission request")).toBe(true);
});

test("Cancel request answers the agent as cancelled, and it moves on", async () => {
  const app = await live();
  await app.press("Start a session");
  await app.waitFor("Phase: idle");
  await app.press("Say ask");
  await app.waitFor("label:Permission request");
  await app.clock!.runFor(450);
  await pressUntil(app, CANCEL, "Phase: blockedOnQuestion");
});
