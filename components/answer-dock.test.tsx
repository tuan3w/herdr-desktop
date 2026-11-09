import { Herdr } from "herdr-desktop/native";
import { afterEach, expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import mixed from "../fixtures/herdr/mixed.json";
import { scripted, sentKeys } from "./board-seam";
import { endSessions } from "./chat-parts-seam";

/**
 * The one answer dock, from both of its sources. A terminal agent's menu runs against the scripted herdr's Claude Code
 * permission question (`fixtures/herdr/mixed.json`, pane `w1:p1`, `answer-dock-lab.tsx`). An ACP session's permission
 * request runs from `chat-parts-lab.tsx`: the rules that need a request the scripted agent cannot make (a risky command, a
 * standing grant, a queue, a command too long for its box) use a made-up `SessionView` of a session that does not exist:
 * an answer then reaches no agent and the engine refuses it, and that refusal on screen is how a test knows a press went
 * all the way to sending. The rules that need a real keeper run against herdr-mobile's scripted ACP agent.
 */
const DESKTOP = { width: 1280, height: 800, clock: {} };
afterEach(() => endSessions());
const lab = (platform?: "macos") =>
  open("./answer-dock-lab.tsx", { ...DESKTOP, platform, host: { params: { fixture: "mixed", pane: "w1:p1" } } });
const YES = "label:1. Yes";
const ALWAYS = "label:/^2\\. Yes, and always allow/";

/** Moves past the 400 ms guard that follows a question appearing. */
async function settle(app: App) {
  await app.waitFor("Do you want to proceed?");
  await app.clock!.runFor(450);
}

test("nothing is sent by itself, however long the question waits", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  await app.clock!.runFor(120000);
  expect(app.shows("Do you want to proceed?")).toBe(true);
  expect(sentKeys()).toEqual([]);
  expect(Herdr.testRequests("pane.send_input")).toEqual([]);
});

test("the command being approved is shown whole beside the answers", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  expect(app.texts()).toContain("touch /tmp/hm-capture-claude/x.txt");
});

test("an answer pressed the moment the question appears is ignored, and works once the guard has passed", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  await app.press(YES);
  await app.clock!.runFor(100);
  await app.press(YES);
  expect(sentKeys()).toEqual([]);

  await app.clock!.runFor(400);
  await app.press(YES);
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("a question that changes starts the guard again: the press meant for the old one sends nothing", async () => {
  const app = await lab();
  await settle(app);
  scripted("mixed").ask("w1:p1", "cat README.md");
  await app.waitFor("cat README.md");
  await app.press(YES);
  expect(sentKeys()).toEqual([]);

  await app.clock!.runFor(450);
  await app.press(YES);
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("when the agent moved on since the person looked, nothing is sent and the answer says the question changed", async () => {
  const app = await lab();
  await settle(app);
  // The pane shows another command, but this window has not heard of it yet: the re-read before sending catches it.
  Herdr.testSetScreen("w1:p1", [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"]);
  await app.press(YES);
  await app.waitFor("The question changed");
  expect(sentKeys()).toEqual([]);
  expect(app.shows("Reported sent: 0")).toBe(true);

  // The notice goes after a moment, and the answer is there to press again.
  await app.clock!.runFor(1600);
  expect(app.shows("The question changed")).toBe(false);
});

test("a risky answer needs two presses: the first only says why, and it is never sent by waiting", async () => {
  const app = await lab();
  await settle(app);
  await app.press(ALWAYS);
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(true);
  expect(sentKeys()).toEqual([]);

  await app.clock!.runFor(3900);
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(true);
  await app.clock!.runFor(200);
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(false);
  expect(sentKeys()).toEqual([]);

  // Disarmed: the next press arms again instead of sending.
  await app.press(ALWAYS);
  expect(sentKeys()).toEqual([]);
  await app.press(ALWAYS);
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toHaveLength(1);
  expect(sentKeys()[0]).toContain("w1:p1: 2");
});

test("arming one risky answer and pressing another answer sends the other only if it needs no second press", async () => {
  const app = await lab();
  await settle(app);
  await app.press(ALWAYS);
  await app.press(YES);
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("a new question disarms a risky answer that was waiting for its second press", async () => {
  const app = await lab();
  await settle(app);
  await app.press(ALWAYS);
  scripted("mixed").ask("w1:p1", "cat README.md");
  await app.waitFor("cat README.md");
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(false);
  await app.clock!.runFor(450);
  await app.press(ALWAYS);
  expect(sentKeys()).toEqual([]);
});

// Headless Tab only reaches pressable views on the macOS idiom; the rule under test is the same on every platform.
test("the digits answer only while an answer has the focus, and a risky one still needs its second press", async () => {
  const app = await lab("macos");
  await settle(app);
  await app.keyboard.press("1");
  expect(sentKeys()).toEqual([]);

  await app.keyboard.press("tab");
  await app.keyboard.press("2");
  expect(sentKeys()).toEqual([]);
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(true);

  // A key pressed while the dock is re-drawing for the armed answer can be lost by the headless harness: press until the
  // answer is reported (a second press after it was sent has no answer left to take it).
  for (let attempt = 0; attempt < 5 && !app.shows("Reported sent: 1"); attempt++) {
    await app.keyboard.press("1");
    await app.clock!.runFor(300);
  }
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("the dock never takes the focus: a key pressed on arrival reaches no answer", async () => {
  const app = await lab();
  await settle(app);
  await app.keyboard.press("enter");
  await app.keyboard.press("space");
  expect(sentKeys()).toEqual([]);
});

/** The permission screen of the fixture with seven answers instead of four. */
const SEVEN = [
  " Bash command",
  " Create empty file x.txt in /tmp/hm-capture-claude",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " cat README.md",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, this once and read-only",
  "   3. Yes, and switch to auto mode",
  "   4. Yes, but ask me again for each file",
  "   5. Yes, in this folder only",
  "   6. No, and tell the agent why",
  "   7. No",
  "",
  " Esc to cancel · Tab to amend",
];

test("with more than six answers the list ends in 'N more…' and opens every answer in place, with the same care", async () => {
  const app = await lab();
  await settle(app);
  scripted("mixed").show("w1:p1", SEVEN);
  await app.waitFor("2 more…");
  expect(app.shows("label:7. No")).toBe(false);
  await app.clock!.runFor(450);
  await app.press("2 more…");
  await app.waitFor("label:7. No");
  // In place: no dialog opens over the window.
  expect(app.shows("All answers")).toBe(false);
  expect(app.shows("Do you want to proceed?")).toBe(true);

  // The list is new: an answer pressed the moment it opens is ignored.
  await app.press("label:7. No");
  expect(sentKeys()).toEqual([]);
  await app.clock!.runFor(450);
  await app.press("label:7. No");
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 7 enter"]);
});

test("an agent that is not waiting any more gets nothing, and the dock says so", async () => {
  const app = await lab();
  await settle(app);
  // Answered somewhere else: herdr says the agent works again, but this window has not heard of it yet.
  const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
  for (const p of [...snapshot.panes, ...snapshot.agents]) if (p.pane_id === "w1:p1") p.agent_status = "working";
  Herdr.testSetSnapshot(snapshot);
  await app.press(YES);
  await app.waitFor("Not waiting for an answer any more. Nothing was sent.");
  expect(sentKeys()).toEqual([]);
});

test("each answer is a row with its key at the left, and a numbered menu's own number is not said twice", async () => {
  const app = await lab();
  await settle(app);
  for (const key of ["1", "2", "3", "4"]) expect(app.texts()).toContain(key);
  expect(app.texts()).toContain("Yes");
  expect(app.texts()).not.toContain("1. Yes");
  // The row keeps the agent's whole words as its name.
  expect(app.shows(YES)).toBe(true);
  expect(app.texts()).toContain("Nothing is sent until you choose");
});

test("after an answer the dock offers Next with the count of others waiting, and Next is the person's press", async () => {
  const app = await lab();
  await settle(app);
  // Before an answer there is nothing to move on from.
  expect(app.shows("Next")).toBe(false);
  expect(app.texts()).toContain("1 more waiting");

  await app.press(YES);
  await app.waitFor("Reported sent: 1");
  await app.waitFor("Next");
  // However long, the dock never moves on by itself and never answers again.
  await app.clock!.runFor(60_000);
  expect(app.texts()).toContain("Next pressed: 0");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);

  await app.press("Next");
  expect(app.texts()).toContain("Next pressed: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

// Headless Tab only reaches pressable views on the macOS idiom; the same holds for focus from code.
test("mod+2 puts the keyboard on the first answer: it sends and arms nothing, and then a digit answers", async () => {
  const app = await lab("macos");
  await settle(app);
  await app.press("Focus the answers");
  expect(sentKeys()).toEqual([]);
  expect(app.texts().some((t) => t.startsWith("Press again to send"))).toBe(false);

  await app.keyboard.press("1");
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("a risky answer's reason is on its row, and armed the row says what to do next", async () => {
  const app = await lab();
  await settle(app);
  expect(app.texts()).toContain("standing permission");
  await app.press(ALWAYS);
  expect(app.texts().some((t) => t.startsWith("Press again to send · "))).toBe(true);
  expect(sentKeys()).toEqual([]);
});

test("Enter in the reply sends it as decline-and-say, through the same checked path", async () => {
  const app = await lab("macos");
  await settle(app);
  await app.type("label:Decline and say this", "use a temp file instead");
  await app.keyboard.press("enter");
  await app.waitUntil(() => sentKeys().length === 1);
  expect(sentKeys()).toEqual(["w1:p1: 4 enter"]);
  expect(typed()).toEqual([]);
});

test("the reply has no send button until it holds words", async () => {
  const app = await lab();
  await settle(app);
  expect(app.shows("Decline and send")).toBe(false);
  await app.type("label:Decline and say this", "x");
  expect(app.shows("Decline and send")).toBe(true);
});

/** Types words in the reply field and presses its button, past the guard. */
async function decline(app: App, words: string) {
  await app.type("label:Decline and say this", words);
  await app.press("Decline and send");
}
const typed = () => Herdr.testRequests("pane.send_input");

test("the reply declines through the checked path first, and types the words only once the menu is gone", async () => {
  const app = await lab();
  await settle(app);
  await decline(app, "use a temp file instead");
  await app.waitUntil(() => sentKeys().length === 1);
  expect(sentKeys()).toEqual(["w1:p1: 4 enter"]);
  // The menu is still on screen: words typed now would go into it. The app looks 30 times, 100 ms apart, for the menu to
  // go (`questionGone`) and every wait of a test moves its clock too, so this spends three looks, not ten: the change
  // below reaches the app in real time and must find looks left.
  await app.clock!.runFor(300);
  expect(typed()).toEqual([]);

  scripted("mixed").become("w1:p1", "working");
  // The change reaches the app in real time (herdr's event, the snapshot): the clock must not run ahead of it, or the
  // 3.5 s the app waits for the menu to go is spent before it has been told.
  await app.waitFor("Status: working");
  await app.clock!.runFor(300);
  await app.waitUntil(() => typed().length === 1);
  expect(typed()[0]!.params).toMatchObject({ pane_id: "w1:p1", text: "use a temp file instead", keys: ["enter"] });
  // The decline was the only key: nothing else was pressed into the pane.
  expect(sentKeys()).toEqual(["w1:p1: 4 enter"]);
});

test("a menu that never goes leaves the words unsent and says so", async () => {
  const app = await lab();
  await settle(app);
  await decline(app, "use a temp file instead");
  await app.waitUntil(() => sentKeys().length === 1);
  await app.clock!.runFor(3500);
  await app.waitFor("Declined, but the question is still on the screen, so your words were not sent.");
  expect(typed()).toEqual([]);
});

test("a question that changed between looking and pressing sends neither the decline nor the words", async () => {
  const app = await lab();
  await settle(app);
  Herdr.testSetScreen("w1:p1", [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"]);
  await decline(app, "use a temp file instead");
  await app.waitFor("The question changed");
  await app.clock!.runFor(3500);
  expect(sentKeys()).toEqual([]);
  expect(typed()).toEqual([]);
});

test("the reply is pressed as carefully as an answer: not within the guard", async () => {
  const app = await lab();
  await app.waitFor("Do you want to proceed?");
  await decline(app, "no");
  expect(sentKeys()).toEqual([]);
  expect(typed()).toEqual([]);
});

test("a question with no option that declines has no reply field", async () => {
  const app = await lab();
  await settle(app);
  expect(app.shows("label:Decline and say this")).toBe(true);
  scripted("mixed").show("w1:p1", [" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and always allow"]);
  // Between the two questions the dock is briefly empty, so waiting for the field to go is not enough: wait for the new
  // question's answers (named `1. Yes. The question changed` for the guard's 400 ms) with the field gone.
  await app.waitUntil(() => app.shows("label:/^1\\. Yes/") && !app.shows("label:Decline and say this"));
});

// ---- an ACP session's permission request ----

const synthetic = (variant: string, platform?: "macos", bare = false) =>
  open("./chat-parts-lab.tsx", { ...DESKTOP, platform, host: { params: { part: "synthetic", variant, bare } } });
const live = () => open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "live" } } });

const ALLOW = "label:Allow once";
const ALWAYS_ALLOW = "label:/^Always allow/";
const REJECT = "label:Reject";
const CANCEL = "Cancel request";
const SHOW_ALL = "text:/^Show all \\d+ lines$/";

/** What the dock says when an answer went all the way to sending and the engine refused it (there is no such session). */
const REFUSED = "Not sent: The session is not running";
const attempted = (app: App) => app.texts().includes(REFUSED);
const armedWith = (app: App, reason: string) => app.texts().includes(`Press again to send · ${reason}`);

/** Moves past the 400 ms guard that follows a request appearing. */
async function settleRequest(app: App) {
  await app.waitFor("label:Permission request");
  await app.clock!.runFor(450);
}

/** Presses until `done` shows: the engine refuses a press within 400 ms of the request on its own clock, which a test cannot move. */
async function pressUntil(app: App, button: string, done: string) {
  const deadline = Date.now() + 10_000;
  while (!app.texts().some((t) => t.startsWith(done))) {
    if (Date.now() > deadline)
      throw new Error(`pressing ${button} never showed ${done}; on screen: ${JSON.stringify(app.texts())}`);
    // The press that went through removes the button before the phase on screen has caught up: wait for it instead.
    if (!app.shows(button)) {
      await app.waitUntil(() => app.texts().some((t) => t.startsWith(done)));
      return;
    }
    await app.press(button);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a request is never sent by itself, however long it waits", async () => {
  const app = await synthetic("plain");
  await settleRequest(app);
  await app.clock!.runFor(120_000);
  expect(app.shows("label:Permission request")).toBe(true);
  expect(attempted(app)).toBe(false);
});

test("the command being approved is shown whole, with the agent's own answers beside it and a key on each", async () => {
  const app = await synthetic("long");
  await app.waitFor("label:Permission request");
  const command = Array.from({ length: 120 }, (_, i) => `echo step${i}`).join(" && ");
  expect(app.texts()).toContain(command);
  expect(app.shows(ALLOW)).toBe(true);
  expect(app.shows(REJECT)).toBe(true);
  for (const key of ["1", "2", "3"]) expect(app.texts()).toContain(key);
});

test("a request's answer pressed the moment it appears is ignored, and works once the guard has passed", async () => {
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
  await settleRequest(app);
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
  await settleRequest(app);
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
  await settleRequest(app);
  await app.press(ALWAYS_ALLOW);
  expect(armedWith(app, "pushes to a remote · grants this permanently")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.press("label:/^Always allow\\. Press again/");
  await app.waitFor(REFUSED);
});

test("rejecting is one press even when allowing would take two", async () => {
  const app = await synthetic("risky");
  await settleRequest(app);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("arming one risky request answer and pressing the safe one sends the safe one at once", async () => {
  const app = await synthetic("risky");
  await settleRequest(app);
  await app.press(ALLOW);
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("a new request disarms an answer that was waiting for its second press", async () => {
  const app = await synthetic("risky");
  await settleRequest(app);
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
  await settleRequest(app);
  expect(app.texts().some((t) => /^More below · \d+ lines$/.test(t))).toBe(true);

  await app.press(ALLOW);
  expect(attempted(app)).toBe(false);
  expect(app.texts()).toContain("Read it all, then press again.");

  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("a long and risky command asks to be read and to be confirmed in the same press, then sends on the next", async () => {
  const app = await synthetic("longRisky");
  await settleRequest(app);
  await app.press(ALLOW);
  expect(app.texts()).toContain("Read it all, then press again.");
  expect(armedWith(app, "pushes to a remote")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.press("label:/^Allow once\\. Press again/");
  await app.waitFor(REFUSED);
});

test("rejecting a long command needs no reading", async () => {
  const app = await synthetic("long");
  await settleRequest(app);
  await app.press(REJECT);
  await app.waitFor(REFUSED);
});

test("Show all N lines opens the whole command inside the dock, counts as reading it, and the allow goes through", async () => {
  const app = await synthetic("long");
  await settleRequest(app);
  await app.press(SHOW_ALL);
  // In place: no dialog, the box is just taller, and the dock offers to fold it back.
  expect(app.shows("The whole command")).toBe(false);
  expect(app.shows("Show fewer lines")).toBe(true);
  expect(app.shows("label:Permission request")).toBe(true);
  expect(attempted(app)).toBe(false);
  await app.press(ALLOW);
  await app.waitFor(REFUSED);
});

test("requests queued behind this one are counted, and when it is answered elsewhere the dock goes", async () => {
  const app = await synthetic("plain");
  await settleRequest(app);
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

test("a permission's reply declines first: when the decline does not go through, the words do not either", async () => {
  const app = await synthetic("plain");
  await settleRequest(app);
  await decline(app, "use the staging remote");
  // The decline reached the engine and was refused (no such session): the dock stops there and keeps the words.
  await app.waitFor(REFUSED);
  expect(app.texts().some((t) => t.startsWith("Declined and sent"))).toBe(false);
  expect(app.shows("label:Decline and say this")).toBe(true);
});

// Headless Tab only reaches pressable views on the macOS idiom; the rule under test is the same on every platform.
test("a request's digits answer only while an answer has the focus, and a risky one still needs its second press", async () => {
  const app = await synthetic("risky", "macos", true);
  await settleRequest(app);
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

test("the request dock never takes the focus: a key pressed on arrival reaches no answer", async () => {
  const app = await synthetic("plain", "macos", true);
  await settleRequest(app);
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
