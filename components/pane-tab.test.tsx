import { Herdr } from "herdr-desktop/native";
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * The pane tab against the scripted herdr of `fixtures/herdr/mixed.json`: `w1:p1` is a Claude Code agent waiting on a
 * question, `w1:p3` a finished Claude Code, `w1:p4` a working omp, `w2:p4` a plain shell.
 */
const WORKING = "w1:p4";
const BLOCKED = "w1:p1";
const DONE = "w1:p3";
const SHELL = "w2:p4";

const lab = (pane: string, extra: Record<string, unknown> = {}) =>
  open("./pane-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    host: { params: { fixture: "mixed", pane, ...extra } },
  });

const inputs = () =>
  Herdr.testRequests("pane.send_input").map((r) => r.params as { pane_id: string; text?: string; keys?: string[] });
const keysSent = () => Herdr.testRequests("pane.send_keys").map((r) => (r.params as { keys: string[] }).keys.join(" "));
const textsSent = () => Herdr.testRequests("pane.send_text").map((r) => (r.params as { text: string }).text);

/** Whether some text on screen holds `part` (the sentences around a name or a reason). */
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

const BOX = "label:/^Message /";
const SHELL_BOX = "label:/^Send a line to /";

/** Waits until the tab has read its pane (the header names it). */
async function ready(app: App, name: string) {
  await app.waitFor(`label:Terminal, ${name} on This computer`);
}

test("Enter sends the text and presses Enter in the pane, a multi-line message goes whole, and Enter on an empty box does nothing", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");

  await app.submit(BOX);
  expect(inputs()).toEqual([]);

  // The line break is what Shift+Enter inserts (the headless keyboard cannot tell it from Enter, so the test types it).
  await app.type(BOX, "first line\nsecond line");
  expect(app.value(BOX)).toBe("first line\nsecond line");
  expect(inputs()).toEqual([]);

  await app.submit(BOX);
  await app.waitUntil(() => inputs().length === 1);
  expect(inputs()[0]).toEqual({ pane_id: WORKING, text: "first line\nsecond line", keys: ["enter"] });
  expect(app.value(BOX)).toBe("");
});

test("while the agent waits on a question an empty Enter sends nothing and points at the answers; a typed reply still goes", async () => {
  const app = await lab(BLOCKED);
  await ready(app, "payments review");
  await app.waitFor("Do you want to proceed?");

  await app.submit(BOX);
  expect(app.shows("Pick an answer above")).toBe(true);
  expect(inputs()).toEqual([]);

  await app.type(BOX, "no, use the other folder");
  expect(app.shows("Pick an answer above")).toBe(false);
  await app.submit(BOX);
  await app.waitUntil(() => inputs().length === 1);
  expect(inputs()[0].text).toBe("no, use the other folder");
});

test("a message that could not be sent is back in the box with the reason", async () => {
  const app = await lab(WORKING, { broken: true });
  await app.type(BOX, "do not lose me");
  await app.submit(BOX);
  await app.waitUntil(() => said(app, "Could not send: "));
  expect(app.value(BOX)).toBe("do not lose me");
  expect(said(app, "Your message is still in the box")).toBe(true);

  // Typing again takes the error away: it was about the text before.
  await app.type(BOX, "!");
  expect(said(app, "Could not send: ")).toBe(false);
});

test("the key row presses keys in the pane, and its symbols go into the message box", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.press("label:Esc");
  await app.press("label:Shift+Tab");
  await app.press("label:Ctrl+C");
  await app.waitUntil(() => keysSent().length === 3);
  expect(keysSent()).toEqual(["esc", "shift+tab", "ctrl+c"]);

  await app.press("label:Insert @");
  expect(app.value(BOX)).toBe("@");
  expect(textsSent()).toEqual([]);
});

test("a shell has Ctrl+D and its symbols, no @; an agent has @ and no Ctrl+D", async () => {
  const shell = await lab(SHELL);
  await ready(shell, "bash");
  expect(shell.shows("label:Ctrl+D")).toBe(true);
  expect(shell.shows("label:Insert |")).toBe(true);
  expect(shell.shows("label:Insert @")).toBe(false);
  expect(shell.shows("label:Space")).toBe(false);

  const agent = await lab(DONE);
  await ready(agent, "Fix login flow");
  expect(agent.shows("label:Insert @")).toBe(true);
  expect(agent.shows("label:Space")).toBe(true);
  expect(agent.shows("label:Ctrl+D")).toBe(false);
});

test("Stop is offered to a working agent only, and presses Escape", async () => {
  const blocked = await lab(BLOCKED);
  await ready(blocked, "payments review");
  expect(blocked.shows("label:Stop the agent")).toBe(false);

  const working = await lab(WORKING);
  await ready(working, "Refactor ledger");
  await working.press("label:Stop the agent");
  await working.waitUntil(() => keysSent().length === 1);
  expect(keysSent()).toEqual(["esc"]);
});

test("typing into the pane: text goes as text, keys as herdr's key names, Escape reaches the pane and does not leave", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  expect(app.shows("Mirror: type with Mirror mode or the composer")).toBe(true);

  await app.press("label:Mirror mode, type into the pane");
  expect(app.shows("Typing into Refactor ledger · Ctrl+Shift+K to leave")).toBe(true);
  expect(app.shows("Capture: on")).toBe(true);

  await app.type("label:Keys go to Refactor ledger", "ls");
  await app.keyboard.press("enter");
  await app.keyboard.press("escape");
  await app.keyboard.press("ctrl+c");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("up");
  await app.waitUntil(() => keysSent().length === 5);
  expect(textsSent()).toEqual(["l", "s"]);
  expect(keysSent()).toEqual(["enter", "esc", "ctrl+c", "shift+tab", "up"]);
  expect(app.shows("Capture: on")).toBe(true);

  await app.paste("label:Keys go to Refactor ledger", { text: "echo hi" });
  await app.waitUntil(() => textsSent().length === 3);
  expect(textsSent()[2]).toBe("echo hi");
});

test("an app shortcut stays the app's while typing into the pane, and the capture key leaves with a notice", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  await app.press("label:Mirror mode, type into the pane");

  // Ctrl+K is the palette on this platform: it is not the pane's.
  await app.keyboard.press("ctrl+k");
  await app.keyboard.press("ctrl+d");
  await app.waitUntil(() => keysSent().length === 1);
  expect(keysSent()).toEqual(["ctrl+d"]);

  await app.keyboard.press("ctrl+shift+k");
  expect(app.shows("Capture: off")).toBe(true);
  expect(app.shows("Typing into Refactor ledger · Ctrl+Shift+K to leave")).toBe(false);
  expect(app.shows("Mirror: type with Mirror mode or the composer")).toBe(true);

  // Out of the mode nothing is forwarded.
  await app.keyboard.press("enter");
  await app.keyboard.press("escape");
  expect(keysSent()).toEqual(["ctrl+d"]);

  await app.keyboard.press("ctrl+shift+k");
  expect(app.shows("Capture: on")).toBe(true);
});

test("moving the keyboard to another control ends the mode instead of leaving keys going to the pane", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  await app.press("label:Mirror mode, type into the pane");
  expect(app.shows("Capture: on")).toBe(true);
  await app.type("label:Keys go to Refactor ledger", "a");

  await app.type(BOX, "hello");
  expect(app.shows("Capture: off")).toBe(true);
  await app.keyboard.press("backspace");
  expect(keysSent()).toEqual([]);
  expect(textsSent()).toEqual(["a"]);
});

test("a tab that is not in front is not typed into, and the global functions find the tab in front only", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  expect(app.shows("Pane in front: yes")).toBe(true);
  await app.press("label:Mirror mode, type into the pane");
  expect(app.shows("Capture: on")).toBe(true);

  await app.press("Make pane inactive");
  expect(app.shows("Pane in front: no")).toBe(true);
  expect(app.shows("Capture: off")).toBe(true);
  expect(app.shows("Typing into Refactor ledger · Ctrl+Shift+K to leave")).toBe(false);
});

test("typing /co in an agent's box lists its commands: the keys move and pick, and the command takes its arguments after it", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.type(BOX, "/co");
  expect(app.shows("label:/^\\/compact, /")).toBe(true);
  expect(app.shows("label:/^\\/context, /")).toBe(true);

  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  expect(app.value(BOX)).toBe("/context ");
  // Picking sent nothing, and the list is gone.
  expect(inputs()).toEqual([]);
  expect(app.shows("label:/^\\/compact, /")).toBe(false);
});

test("Escape hides the command list until the next edit", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.type(BOX, "/re");
  expect(app.shows("label:/^\\/resume, /")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:/^\\/resume, /")).toBe(false);
  await app.type(BOX, "s");
  expect(app.shows("label:/^\\/resume, /")).toBe(true);
});

test("a /word the agent does not list is held once; Send as message sends it as typed, and typing it again holds it again", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.type(BOX, "/clera now");
  await app.submit(BOX);
  expect(said(app, "isn’t one of Claude Code’s commands")).toBe(true);
  expect(inputs()).toEqual([]);
  expect(app.value(BOX)).toBe("/clera now");

  await app.press("Send as message");
  await app.waitUntil(() => inputs().length === 1);
  expect(inputs()[0].text).toBe("/clera now");
  expect(app.shows("Send as message")).toBe(false);

  await app.type(BOX, "/clera now");
  await app.submit(BOX);
  expect(app.shows("Send as message")).toBe(true);
  expect(inputs().length).toBe(1);

  // Changing the text takes the note away; a command the agent lists goes without one.
  await app.clear(BOX);
  await app.type(BOX, "/compact");
  await app.submit(BOX);
  await app.waitUntil(() => inputs().length === 2);
  expect(app.shows("Send as message")).toBe(false);
});

test("a pinned command comes first on a bare slash, and the pin is kept in the settings", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.type(BOX, "/");
  expect(app.shows("label:Pin /exit")).toBe(true);
  await app.press("label:Pin /exit");
  expect(app.shows("label:Unpin /exit")).toBe(true);
  expect(Herdr.setting("slash.v1")).toEqual({ uses: {}, pinned: { claude: ["exit"] } });
});

test("quick phrases sit above the empty box and fill it without sending, and a phrase sent twice joins them", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  expect(app.shows("label:Quick phrase: continue")).toBe(true);
  await app.press("label:Quick phrase: continue");
  expect(app.value(BOX)).toBe("continue");
  expect(inputs()).toEqual([]);
  // Once there is text the chips step aside.
  expect(app.shows("label:Quick phrase: continue")).toBe(false);

  await app.clear(BOX);
  for (let i = 0; i < 2; i++) {
    await app.type(BOX, "ship it now");
    await app.submit(BOX);
    await app.waitUntil(() => inputs().length === i + 1);
  }
  await app.waitFor("label:Quick phrase: ship it now");
});

test("a message sent once is not offered back, and nothing typed into a shell is learned", async () => {
  const agent = await lab(DONE);
  await ready(agent, "Fix login flow");
  await agent.type(BOX, "only once please");
  await agent.submit(BOX);
  await agent.waitUntil(() => inputs().length === 1);
  expect(agent.shows("label:Quick phrase: only once please")).toBe(false);

  const shell = await lab(SHELL);
  await ready(shell, "bash");
  for (let i = 0; i < 3; i++) {
    await shell.type(SHELL_BOX, "ls -la");
    await shell.submit(SHELL_BOX);
    await shell.waitUntil(() => inputs().length === i + 1);
  }
  expect(Herdr.setting("phrases.v1")).toBeNull();
});

test("quick phrases can be turned off", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  expect(app.shows("label:Quick phrase: continue")).toBe(true);
  await app.press("Turn quick phrases off");
  expect(app.shows("label:Quick phrase: continue")).toBe(false);
});

test("pane options change the mirror's layout and the choice is kept", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  expect(app.shows("Fit: width")).toBe(true);
  await app.press("label:Pane options");
  await app.press("label:Wrap lines");
  expect(app.shows("Fit: wrap")).toBe(true);
  await app.waitUntil(() => (app.storage()["herdr.settings.v1"] ?? "").includes('"paneFit":"wrap"'));

  await app.press("label:Pane options");
  await app.press("label:Actual size");
  expect(app.shows("Fit: actual")).toBe(true);
});

test("Copy title and Copy pane id put them on the clipboard", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.press("label:Pane options");
  await app.press("label:Copy title");
  expect(app.clipboard()).toBe("Fix login flow");
  await app.press("label:Pane options");
  await app.press(`label:Copy pane id ${DONE}`);
  expect(app.clipboard()).toBe(DONE);
});

test("Duplicate starts the same agent in a new tab of the workspace, in the same folder, and opens it", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  await app.press("label:Pane options");
  await app.press("label:Duplicate");
  await app.waitFor("Opened local/w1:p9");
  const tab = Herdr.testRequests("tab.create")[0].params as { workspace_id: string; cwd?: string };
  expect(tab.workspace_id).toBe("w1");
  expect(tab.cwd).toBe("/home/dev/payments-api");
  expect(Herdr.testRequests("agent.start").length).toBe(1);
});

test("Duplicating a shell makes a new tab in its folder without starting an agent", async () => {
  const app = await lab(SHELL);
  await ready(app, "bash");
  await app.press("label:Pane options");
  await app.press("label:Duplicate");
  await app.waitFor("Opened local/w1:p9");
  expect(Herdr.testRequests("agent.start")).toEqual([]);
  expect((Herdr.testRequests("tab.create")[0].params as { cwd?: string }).cwd).toBe("/home/dev");
});

const SCREEN = [
  "building…",
  "docs at https://example.com/docs and a log in ./logs/build.txt:42",
  "see https://example.com/second too",
  "done",
];

test("the links of the pane are listed for the keyboard: a web address opens, a path is looked for in the pane's folder", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  Herdr.testSetScreen(WORKING, SCREEN);
  Herdr.testPush({ event: "pane_output_changed", data: { pane_id: WORKING } });

  await app.waitFor("text:building…");
  await app.press("Show links");
  await app.waitFor("Links in this pane");
  await app.waitFor("label:https://example.com/docs");
  expect(app.shows("label:https://example.com/second")).toBe(true);
  expect(app.shows("label:./logs/build.txt:42")).toBe(true);

  await app.type("label:Search links", "second");
  expect(app.shows("label:https://example.com/docs")).toBe(false);
  await app.press("label:https://example.com/second");
  expect(app.openedUrls()).toEqual(["https://example.com/second"]);

  await app.press("Show links");
  await app.press("label:./logs/build.txt:42");
  // The path is a file of the pane's machine, not text to copy: the viewer looks for it (this folder is not on this computer).
  await app.waitUntil(() => said(app, "isn't in /home/dev/payments-api"));
  expect(app.clipboard()).toBeNull();
});

test("Find lists the matches of the pane, steps through them and says how many there are", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  Herdr.testSetScreen(WORKING, SCREEN);
  Herdr.testPush({ event: "pane_output_changed", data: { pane_id: WORKING } });

  await app.keyboard.press("ctrl+f");
  await app.type("label:Text to find in the pane", "example");
  await app.waitFor("2 of 2");
  await app.submit("label:Text to find in the pane");
  await app.waitFor("1 of 2");
  await app.submit("label:Text to find in the pane");
  await app.waitFor("2 of 2");

  await app.type("label:Text to find in the pane", "zzz");
  await app.waitFor("No matches");

  await app.keyboard.press("escape");
  expect(app.shows("label:Text to find in the pane")).toBe(false);
});

test("a pane herdr no longer has says so instead of showing a dead composer", async () => {
  const app = await lab("w9:p9");
  await app.waitFor("This agent is gone");
  expect(app.shows(BOX)).toBe(false);
});
