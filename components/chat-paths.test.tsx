import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * Paths a chat names relative to the session's folder, and the person's own message with the files it carries, through
 * `session-lab.tsx`'s `attached` scene: a scripted chat whose folder is `src` of the synthetic tree (`Files.testTree`),
 * a picture saved into it as the message box saves one for a terminal chat, then calls and words that name `main.rs:3`,
 * `../notes.txt` and a file that is not there. What a press opens is the chat's side panel.
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const attached = () =>
  open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene: "attached" } } });

const PANEL = "label:Opened link";
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));
/** The synthetic tree the lab's chat works under (the lab prints it). */
const treeOf = (app: App) =>
  app
    .texts()
    .find((t) => t.startsWith("Tree: "))!
    .slice("Tree: ".length);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("a picture the person sent as @path is a tile in their bubble: no @ text, its name in the label, a press opens it", async () => {
  const app = await attached();
  await app.waitFor("label:You: not well aligned, the tiles sit 4 pt low. Picture image-4.png, File ledger.py");
  expect(said(app, "not well aligned, the tiles sit 4 pt low.")).toBe(true);
  expect(said(app, "@.herdr-desktop") || said(app, "@ledger.py")).toBe(false);
  expect(said(app, ".herdr-desktop/attachments")).toBe(false);

  await app.waitFor("label:Picture image-4.png");
  await app.press("label:Picture image-4.png");
  await app.waitFor(PANEL);
  const path = `${treeOf(app)}/src/.herdr-desktop/attachments/image-4.png`;
  await app.waitFor(`label:image-4.png, ${path}`);

  // The file beside it is a chip that opens it in the same panel.
  await app.press("label:File ledger.py");
  await app.waitFor("label:ledger.py, read only");
  expect(app.count(PANEL)).toBe(1);
});

test("a relative path in a tool row opens in the side panel at its line, and ../ climbs from the session's folder", async () => {
  const app = await attached();
  await app.waitFor("label:/^Read 2 files/");
  await app.press("label:/^Read 2 files/");
  await app.press("label:/^Tool: Read main\\.rs, done/");
  await app.press("label:Open main.rs at line 3");
  await app.waitFor(PANEL);
  const tree = treeOf(app);
  await app.waitFor(`label:main.rs:3, ${tree}/src/main.rs:3`);
  expect(app.shows("label:main.rs, read only")).toBe(true);

  await app.press("label:/^Tool: Read \\.\\.\\/notes\\.txt, done/");
  await app.press("label:Open ../notes.txt");
  await app.waitFor(`label:notes.txt, ${tree}/notes.txt`);
  expect(said(app, "A path must start")).toBe(false);
});

test("a relative path in the agent's words opens in the panel; a missing one says which folder it is not in", async () => {
  const app = await attached();
  await app.waitFor("label:../notes.txt");
  await app.press("label:../notes.txt");
  await app.waitFor(PANEL);
  const tree = treeOf(app);
  await app.waitFor(`label:/^notes\\.txt, ${escape(tree)}\\/notes\\.txt$/`);

  await app.press("label:.scratch/notes/plan.md");
  await app.waitUntil(() => said(app, `.scratch/notes/plan.md isn't in ${tree}/src`));
  expect(said(app, "A path must start")).toBe(false);
});
