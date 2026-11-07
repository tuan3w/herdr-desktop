import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * The chat's message box, through the scripted port of `session-lab.tsx`: what the `@` list offers and what a pick does,
 * what a paste does with a picture, a long text and a file, what Up and Escape do, what is sent. The folder the
 * session works in is the lab's synthetic project (`fixtures/files/project`).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const scripted = (scene: string) =>
  open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene } } });

const BOX = "label:Message";
/** What the box holds. */
const box = (app: App): string => app.value(BOX) ?? "";
const label = (re: string) => `label:/${re}/`;
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));
const LOG = "Log: ";
const logged = (app: App, part: string) => app.texts().some((t) => t.startsWith(LOG) && t.includes(part));
const tree = (app: App) =>
  app
    .texts()
    .find((t) => t.startsWith("Tree: "))!
    .slice("Tree: ".length);

/** The lab's chat, with the box ready: the folder is walked once, so the first `@` may take a moment. */
async function chat(scene = "chat"): Promise<App> {
  const app = await scripted(scene);
  await app.waitFor(BOX);
  return app;
}

test("an @ lists the project's files and folders, typing narrows them, Tab adds one as a chip and as @path in the words", async () => {
  const app = await chat();
  await app.type(BOX, "look at @");
  await app.waitFor("label:Files");
  await app.waitFor("label:src, folder");
  expect(app.shows("label:README.md")).toBe(true);

  await app.type(BOX, "mai");
  await app.waitFor("label:src/main.rs");
  expect(app.shows("label:README.md")).toBe(false);
  await app.keyboard.press("tab");
  await app.waitUntil(() => box(app) === "look at @src/main.rs ");
  expect(app.shows("label:Files")).toBe(false);
  // The chip above the box names the file; the words carry it for an agent that reads only words.
  expect(app.shows("label:File src/main.rs")).toBe(true);
});

test("Down and Enter move along the list and add; Escape closes it and keeps what was typed", async () => {
  const app = await chat();
  await app.type(BOX, "@");
  await app.waitFor("label:Files");
  await app.keyboard.press("down");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Files"));
  expect(box(app)).toBe("@");

  // Typing again asks again.
  await app.type(BOX, "read");
  await app.waitFor("label:README.md");
  await app.keyboard.press("enter");
  await app.waitUntil(() => box(app) === "@README.md ");
  expect(app.shows("label:File README.md")).toBe(true);
});

test("Right goes into a folder and the list goes on there; a folder is added like a file", async () => {
  const app = await chat();
  await app.type(BOX, "@sr");
  await app.waitFor("label:src, folder");
  await app.keyboard.press("right");
  await app.waitUntil(() => box(app) === "@src/");
  await app.waitFor("label:src/main.rs");
  await app.clear(BOX);
  await app.type(BOX, "@sr");
  await app.waitFor("label:src, folder");
  await app.keyboard.press("tab");
  await app.waitUntil(() => box(app) === "@src/ ");
  expect(app.shows("label:Folder src")).toBe(true);
});

test("an @ inside a word is an address, not a mention; a name with a letter wrong still finds the file", async () => {
  const app = await chat();
  await app.type(BOX, "mail me@host");
  expect(app.shows("label:Files")).toBe(false);
  await app.clear(BOX);
  await app.type(BOX, "@mian.rs");
  await app.waitFor("label:src/main.rs");
});

test("Backspace takes a chip's words and the chip together, and taking the chip off takes the words", async () => {
  const app = await chat();
  await app.type(BOX, "@README");
  await app.waitFor("label:README.md");
  await app.keyboard.press("tab");
  await app.waitUntil(() => box(app) === "@README.md ");
  // The space goes first, then one more Backspace takes the whole token, not a letter of it.
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => box(app) === "");
  await app.waitUntil(() => !app.shows("label:File README.md"));

  await app.type(BOX, "@docs/des");
  await app.waitFor("label:docs/design.md");
  await app.keyboard.press("tab");
  await app.waitFor("label:File docs/design.md");
  await app.press("label:Remove docs/design.md");
  await app.waitUntil(() => box(app) === "");
});

test("a mention goes to the agent with its words: the file is sent with the message", async () => {
  const app = await chat();
  await app.type(BOX, "fix @notes");
  await app.waitFor("label:notes.txt");
  await app.keyboard.press("tab");
  await app.type(BOX, "please");
  await app.submit(BOX);
  await app.waitUntil(() => logged(app, "send fix @notes.txt please"));
  expect(logged(app, `${tree(app)}/notes.txt`)).toBe(true);
  // What was sent is no longer a chip.
  expect(app.shows("label:File notes.txt")).toBe(false);
  expect(box(app)).toBe("");
});

test("a picture pasted is a thumbnail and nothing in the words; it goes with the message and can be taken off", async () => {
  const app = await chat();
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-1.png`] });
  await app.waitFor(label("^Image 1 of 1, PNG, "));
  expect(box(app)).toBe("");
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-2.png`] });
  await app.waitFor(label("^Image 2 of 2, PNG, "));
  expect(box(app)).toBe("");

  await app.press("label:Remove image 1");
  await app.waitUntil(() => app.shows(label("^Image 1 of 1, ")) && !app.shows(label("^Image 2 of")));

  await app.type(BOX, "what is wrong here");
  await app.submit(BOX);
  await app.waitUntil(() => logged(app, "+pictures 2"));
});

test("pictures go in the order they were added, with the words about them", async () => {
  const app = await chat();
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-2.png`] });
  await app.waitFor(label("^Image 1 of 1, PNG, "));
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-1.png`] });
  await app.waitFor(label("^Image 2 of 2, PNG, "));
  await app.type(BOX, "compare them");
  await app.submit(BOX);
  await app.waitUntil(() => logged(app, "send compare them"));
  expect(logged(app, "+pictures 1,2")).toBe(true);
});

test("a picture alone can be sent, and what was typed, pictured and picked comes back when the chat is mounted again", async () => {
  const app = await chat();
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-1.png`] });
  await app.waitFor(label("^Image 1 of 1, PNG, "));
  await app.type(BOX, "keep this draft");
  await app.press("Go away");
  await app.waitUntil(() => !app.shows(BOX));
  await app.press("Come back");
  await app.waitFor(BOX);
  expect(box(app)).toBe("keep this draft");
  await app.waitFor(label("^Image 1 of 1, PNG, "));

  await app.clear(BOX);
  expect(app.enabled("label:Send message")).toBe(true);
});

test("text wins a mixed clipboard, and a picture alone is the picture", async () => {
  const app = await chat();
  await app.paste(BOX, { text: "cell value", files: [`${tree(app)}/assets/shot-1.png`] });
  await app.waitUntil(() => box(app) === "cell value");
  expect(app.shows(label("^Image 1 of 1"))).toBe(false);
});

test("a long paste is one chip that sends in full and puts itself back in the box when pressed", async () => {
  const app = await chat();
  const long = `${"line of a log\n".repeat(600)}the end`;
  await app.paste(BOX, { text: long });
  await app.waitUntil(() => /\[Pasted text #1 \+601 lines\]/.test(box(app)));
  expect(box(app).length).toBeLessThan(100);
  await app.waitFor("label:/^Pasted text, 601 lines/");

  await app.submit(BOX);
  await app.waitUntil(() => logged(app, `(${long.length} characters, ends `));
  expect(logged(app, "the end")).toBe(true);

  await app.paste(BOX, { text: long });
  await app.waitFor("label:/^Pasted text, 601 lines/");
  await app.press("label:/^Pasted text, 601 lines/");
  await app.waitUntil(() => box(app).length > 5000);
  expect(app.shows("label:/^Pasted text, 601 lines/")).toBe(false);
});

test("a short paste is plain text and a pasted file of the project is a mention", async () => {
  const app = await chat();
  await app.paste(BOX, { text: "short" });
  await app.waitUntil(() => box(app) === "short");
  await app.clear(BOX);
  await app.paste(BOX, { uris: [`file://${tree(app)}/notes.txt`] });
  await app.waitUntil(() => box(app) === "@notes.txt ");
  expect(app.shows("label:File notes.txt")).toBe(true);
});

test("a dropped picture is a thumbnail, a dropped file of the project a mention", async () => {
  const app = await chat();
  await app.dropFiles(BOX, [`file://${tree(app)}/assets/shot-3.png`, `file://${tree(app)}/notes.txt`]);
  await app.waitFor(label("^Image 1 of 1, PNG, "));
  await app.waitFor("label:File notes.txt");
  expect(box(app)).toBe("@notes.txt ");
});

test("the file dialog attaches what it picks: a picture as a thumbnail, a file of the project as a mention", async () => {
  const app = await chat();
  await app.press("label:Attach");
  await app.press("label:/^Files from this computer/");
  // The dialog is the system's; the seam answers it with what a test says.
  expect(app.shows("label:/^Files from this computer/")).toBe(false);
});

test("an agent that cannot see pictures says so on them and offers to save them into the project", async () => {
  const app = await chat("blind");
  await app.paste(BOX, { files: [`${tree(app)}/assets/shot-1.png`] });
  await app.waitFor(label("^Image 1 of 1, PNG, "));
  await app.waitFor("Claude Code cannot see images.");
  await app.press("Save to the project and mention the path");
  await app.waitUntil(() => box(app).includes("@.herdr-desktop/attachments/"));
  expect(app.shows(label("^Image 1 of 1"))).toBe(false);
  expect(app.shows("Claude Code cannot see images.")).toBe(false);
});

test("Up in an empty box brings back the last message, Down goes forward again, and Escape never clears the box", async () => {
  const app = await chat();
  await app.type(BOX, "first thing");
  await app.submit(BOX);
  await app.waitUntil(() => logged(app, "send first thing"));
  expect(box(app)).toBe("");
  await app.keyboard.press("up");
  await app.waitUntil(() => box(app) === "first thing");
  await app.keyboard.press("down");
  await app.waitUntil(() => box(app) === "");

  // Words that were typed are never lost to Escape.
  await app.type(BOX, "half a thought");
  await app.keyboard.press("escape");
  expect(box(app)).toBe("half a thought");
});

test("a command list opens at a slash in the same list as files", async () => {
  const app = await chat("commands");
  await app.type(BOX, "/re");
  await app.waitFor("label:Commands");
  await app.keyboard.press("tab");
  await app.waitUntil(() => box(app) === "/review ");
  expect(said(app, "takes <branch>")).toBe(true);
});

test("the command list tells what the highlighted command does in full, and the rows stay as they were", async () => {
  const app = await chat("commands");
  await app.type(BOX, "/");
  await app.waitFor("label:Commands");
  // The footer is drawn after the rows, so it is the last text of the list.
  const footer = () => app.texts().findLast((t) => /^(Summarise|Review|Write|Show)/.test(t));
  const rows = () => app.texts().filter((t) => /^\/(compact|review|init|cost)$/.test(t)).length;
  await app.waitUntil(() => footer() === "Summarise the conversation to free context");
  expect(rows()).toBe(4);
  await app.keyboard.press("down");
  await app.waitUntil(() => footer() === "Review the changes on this branch");
  expect(rows()).toBe(4);
});
