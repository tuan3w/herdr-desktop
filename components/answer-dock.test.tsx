import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { Herdr } from "herdr-desktop/native";
import mixed from "../fixtures/herdr/mixed.json";
import { scripted, sentKeys } from "./board-seam";

/** The answer dock against the scripted herdr's Claude Code permission question (`fixtures/herdr/mixed.json`, pane `w1:p1`). */
const DESKTOP = { width: 1280, height: 800, clock: {} };
const lab = (platform?: "macos") => open("./answer-dock-lab.tsx", { ...DESKTOP, platform, host: { params: { fixture: "mixed", pane: "w1:p1" } } });
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

  await app.keyboard.press("1");
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

test("with more than five answers the last chip is 'N more…' and opens every answer, with the same care", async () => {
  const app = await lab();
  await settle(app);
  scripted("mixed").show("w1:p1", SEVEN);
  await app.waitFor("3 more…");
  expect(app.shows("label:7. No")).toBe(false);
  await app.clock!.runFor(450);
  await app.press("3 more…");
  await app.waitFor("All answers");
  expect(app.shows("label:7. No")).toBe(true);

  // The list is new: an answer pressed the moment it opens is ignored.
  await app.press("label:7. No");
  expect(sentKeys()).toEqual([]);
  await app.clock!.runFor(450);
  await app.press("label:7. No");
  await app.waitFor("Reported sent: 1");
  expect(sentKeys()).toEqual(["w1:p1: 7 enter"]);
  expect(app.shows("All answers")).toBe(false);
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
