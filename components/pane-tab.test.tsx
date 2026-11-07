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

test("while the agent waits on a question the answers stand where the message box was and nothing is sent", async () => {
  const app = await lab(BLOCKED);
  await ready(app, "payments review");
  await app.waitFor("Do you want to proceed?");
  expect(app.shows(BOX)).toBe(false);
  expect(app.shows("label:Answers")).toBe(true);
  expect(inputs()).toEqual([]);
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

test("the tab says it is a read-only view, has no keys or typing mode, and keys pressed over it go nowhere", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  expect(app.shows("Read-only view")).toBe(true);
  for (const gone of ["label:Esc", "label:Ctrl+C", "label:Insert @", "label:/^Mirror mode/"])
    expect(app.shows(gone)).toBe(false);

  for (const key of ["enter", "escape", "ctrl+c", "ctrl+shift+k", "up"]) await app.keyboard.press(key);
  expect(keysSent()).toEqual([]);
  expect(textsSent()).toEqual([]);
});

test("a /command typed in the box is plain text: nothing is listed and it goes as typed", async () => {
  const app = await lab(DONE);
  await ready(app, "Fix login flow");
  await app.type(BOX, "/compact");
  expect(app.shows("label:/^Insert /")).toBe(false);
  await app.submit(BOX);
  await app.waitUntil(() => inputs().length === 1);
  expect(inputs()[0].text).toBe("/compact");
});

test("the global functions find the tab in front only", async () => {
  const app = await lab(WORKING);
  await ready(app, "Refactor ledger");
  expect(app.shows("Pane in front: yes")).toBe(true);
  await app.press("Make pane inactive");
  expect(app.shows("Pane in front: no")).toBe(true);
  await app.press("Make pane active");
  expect(app.shows("Pane in front: yes")).toBe(true);
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
