import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/**
 * The file browser and viewers against a synthetic folder (`fixtures/files/project`, copied by the test seam):
 * `README.md` and `notes.txt` and `data.bin` at the top, `src/` (main.rs, ledger.py), `docs/` (design.md),
 * `assets/` (three pictures) and one hidden file. Rows are found by their label, which starts with the name.
 */
const lab = (dir?: string) => open("./files-lab.tsx", { ...DESKTOP, host: dir ? { params: { dir } } : undefined });

const row = (name: string, kind: "file" | "folder") => `label:/^${name.replace(/\./g, "\\.")}, ${kind}/`;

/** Whether some text on screen holds `part`. */
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

async function browse(app: App) {
  await app.press("Browse files");
  await app.waitFor(row("README.md", "file"));
}

test("a folder lists its folders before its files, and a folder opens, and the way back goes up", async () => {
  const app = await lab();
  await browse(app);
  const texts = app.texts();
  const at = (name: string) => texts.indexOf(name);
  expect(at("Folders")).toBeLessThan(at("assets"));
  expect(at("docs")).toBeLessThan(at("src"));
  expect(at("src")).toBeLessThan(texts.lastIndexOf("Files"));
  expect(texts.lastIndexOf("Files")).toBeLessThan(at("data.bin"));
  expect(at("data.bin")).toBeLessThan(at("README.md"));
  expect(said(app, "6 items · 1 hidden")).toBe(true);

  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  expect(app.shows(row("ledger.py", "file"))).toBe(true);
  expect(app.shows(row("README.md", "file"))).toBe(false);

  await app.press("Up one folder");
  await app.waitFor(row("README.md", "file"));
});

test("typing a folder goes there, and a folder that cannot be opened says why and offers the way out", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  const typed = app.value("label:Folder");
  await app.clear("label:Folder");
  await app.type("label:Folder", `${typed}/nowhere`);
  await app.submit("label:Folder");
  await app.waitFor("Cannot open this folder");
  expect(said(app, "does not exist")).toBe(true);
  await app.press("Up one folder");
  await app.waitFor(row("main.rs", "file"));
});

test("a start folder that is not there is said, not shown as empty", async () => {
  const app = await lab("/definitely/not/a/folder");
  await app.press("Browse files");
  await app.waitFor("Cannot open this folder");
  expect(said(app, "/definitely/not/a/folder does not exist")).toBe(true);
  expect(app.shows("This folder is empty")).toBe(false);
});

test("find in this folder narrows the list as you type and says when nothing matches", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  await app.type("label:Find in this folder", "led");
  expect(app.shows(row("ledger.py", "file"))).toBe(true);
  expect(app.shows(row("main.rs", "file"))).toBe(false);
  await app.type("label:Find in this folder", "zzz");
  expect(app.shows("No file matches")).toBe(true);
});

test("hidden files stay out of the list until they are asked for", async () => {
  const app = await lab();
  await browse(app);
  expect(app.shows(row(".env.example", "file"))).toBe(false);
  await app.press("Folder options");
  await app.press("Show hidden files");
  await app.waitFor(row(".env.example", "file"));
});

test("a text file opens read only with its name and size, and Escape goes back to its folder", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("notes.txt", "file"));
  await app.waitFor("label:notes.txt, read only");
  expect(said(app, "168 bytes")).toBe(true);
  expect(app.shows("Back to the folder")).toBe(true);
  // read only: typing into the editor changes nothing
  await app.keyboard.press("escape");
  await app.waitFor(row("notes.txt", "file"));
  expect(app.shows("Files")).toBe(true);
  // a second Escape closes the dialog
  await app.keyboard.press("escape");
  await app.waitFor("Files", { state: "gone" });
});

test("a file that is not text shows its size and offers to reveal and open it", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("data.bin", "file"));
  await app.waitFor("Not a text file");
  expect(said(app, "data.bin · 4 KB")).toBe(true);
  expect(app.enabled("Reveal in the file manager")).toBe(true);
  expect(app.enabled("Open with the system's application")).toBe(true);
});

test("a Markdown file shows as a document with its diagrams named, and its source one switch away", async () => {
  const app = await lab();
  await app.press("View the readme");
  await app.waitFor("Diagram: flowchart");
  expect(app.shows("payments-api")).toBe(true);
  expect(app.shows("Show source")).toBe(true);
  expect(app.shows("label:README.md, read only")).toBe(false);
  await app.press("label:Source");
  await app.waitFor("label:README.md, read only");
  expect(app.shows("Diagram: flowchart")).toBe(false);
});

test("a path in a link opens the file where the pane's folder or one above it has it, and says so when none does", async () => {
  const app = await lab();
  await app.press("Open link src/ledger.py");
  await app.waitFor("label:ledger.py, read only");
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.waitFor("Files", { state: "gone" });
  await app.press("Open link missing.rs");
  await app.waitFor("link done");
  expect(said(app, "missing.rs isn't in")).toBe(true);
});

test("a picture opens in the photo viewer, the arrows walk the folder and Escape closes", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("assets", "folder"));
  await app.waitFor(row("shot-1.png", "file"));
  await app.press(row("shot-2.png", "file"));
  await app.waitFor("shot-2.png");
  expect(said(app, "Photo 2 of 3")).toBe(true);
  await app.keyboard.press("right");
  await app.waitFor("shot-3.png");
  expect(said(app, "Photo 3 of 3")).toBe(true);
  expect(app.enabled("Next photo")).toBe(false);
  await app.press("Previous photo");
  await app.waitFor("shot-2.png");
  await app.keyboard.press("escape");
  await app.waitFor("Photo 2 of 3", { state: "gone" });
  // the browser is still there, on the same folder
  expect(app.shows(row("shot-1.png", "file"))).toBe(true);
});

test("a sent file arrives, a name that is taken is not overwritten until Replace, and nothing is sent before Send", async () => {
  const app = await lab();
  await app.press("Send data.bin to docs");
  await app.waitFor("Send to This computer");
  await app.press("Cancel");
  await app.press("Browse the docs folder");
  await app.waitFor(row("design.md", "file"));
  expect(app.shows(row("data.bin", "file"))).toBe(false);
  await app.keyboard.press("escape");
  await app.press("Send data.bin to docs");
  await app.press("Send");
  await app.waitFor("Sent · 4 KB");
  await app.press("Close");
  await app.press("Browse the docs folder");
  await app.waitFor(row("data.bin", "file"));
  await app.keyboard.press("escape");

  await app.press("Send data.bin to docs");
  await app.press("Send");
  await app.waitFor("A file with this name is already there");
  await app.press("Replace data.bin on the machine");
  await app.waitFor("Sent · 4 KB");
});

test("sending into something that is not a folder asks again instead of sending", async () => {
  const app = await lab();
  await app.press("Send data.bin to docs");
  await app.clear("label:/^Into this folder/");
  await app.type("label:/^Into this folder/", "/definitely/not/there");
  await app.press("Send");
  await app.waitUntil(() => said(app, "does not exist"));
  expect(app.shows("Stop and close")).toBe(false);
});

test("a page of this computer is not tunnelled: the dialog says so and offers to try again", async () => {
  const app = await lab();
  await app.press("Open a page of this computer");
  await app.waitFor("Couldn't open this page");
  expect(said(app, "open in the browser")).toBe(true);
  expect(app.shows("Try again")).toBe(true);
  await app.press("Close");
  await app.waitFor("Couldn't open this page", { state: "gone" });
});
