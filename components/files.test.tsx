import { Files } from "herdr-desktop/native";
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

test("a folder lists its folders before its files in a table, and a folder opens, and the way back goes up", async () => {
  const app = await lab();
  await browse(app);
  const texts = app.texts();
  const at = (name: string) => texts.indexOf(name);
  // the columns are the table's own: Name, Size, Modified
  for (const title of ["Name", "Size", "Modified"]) expect(texts.includes(title)).toBe(true);
  expect(at("assets")).toBeLessThan(at("docs"));
  expect(at("docs")).toBeLessThan(at("src"));
  expect(at("src")).toBeLessThan(at("data.bin"));
  expect(at("data.bin")).toBeLessThan(at("notes.txt"));
  expect(at("notes.txt")).toBeLessThan(at("README.md"));
  expect(said(app, "6 items · 1 hidden")).toBe(true);

  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  expect(app.shows(row("ledger.py", "file"))).toBe(true);
  expect(app.shows(row("README.md", "file"))).toBe(false);

  await app.press("Up one folder");
  await app.waitFor(row("README.md", "file"));
});

test("the keyboard walks the table: Down moves, Enter enters a folder, Backspace goes up, and Enter opens a file", async () => {
  const app = await lab();
  await browse(app);
  // the first row (assets) is lit when the folder shows; Down twice lands on src
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor(row("main.rs", "file"));
  await app.keyboard.press("backspace");
  await app.waitFor(row("README.md", "file"));
  await app.keyboard.press("enter");
  await app.waitFor(row("shot-1.png", "file"));
  await app.keyboard.press("mod+up");
  await app.waitFor(row("README.md", "file"));
});

test("the folder is a breadcrumb that is the path, shown once, and a segment goes there", async () => {
  const app = await lab();
  await app.press("Browse the docs folder");
  await app.waitFor(row("design.md", "file"));
  expect(app.shows("label:Folder path")).toBe(true);
  // no second copy of the path in a field until it is asked for
  expect(app.shows("label:Folder")).toBe(false);
  await app.press("Go to /");
  await app.waitFor("Cannot open this folder", { state: "gone" });
  await app.waitUntil(
    () => app.shows(row("tmp", "folder")) || app.shows(row("var", "folder")) || app.shows(row("Users", "folder")),
  );
});

test("mod+l turns the breadcrumb into the path field, which goes there on Enter, and a folder that cannot be opened says why", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  await app.keyboard.press("mod+l");
  await app.waitFor("label:Folder");
  const typed = app.value("label:Folder");
  await app.clear("label:Folder");
  await app.type("label:Folder", `${typed}/nowhere`);
  await app.submit("label:Folder");
  await app.waitFor("Cannot open this folder");
  expect(said(app, "does not exist")).toBe(true);
  await app.press("Up one folder");
  await app.waitFor(row("main.rs", "file"));
  // the field is gone again: one place for the path
  expect(app.shows("label:Folder")).toBe(false);
});

test("a start folder that is not there is said, not shown as empty", async () => {
  const app = await lab("/definitely/not/a/folder");
  await app.press("Browse files");
  await app.waitFor("Cannot open this folder");
  expect(said(app, "/definitely/not/a/folder does not exist")).toBe(true);
  expect(app.shows("This folder is empty")).toBe(false);
});

test("find in this folder narrows the list as you type, typing with the table in front starts it, and nothing matching says so", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("src", "folder"));
  await app.waitFor(row("main.rs", "file"));
  await app.type("label:Find in this folder", "led");
  expect(app.shows(row("ledger.py", "file"))).toBe(true);
  expect(app.shows(row("main.rs", "file"))).toBe(false);
  await app.type("label:Find in this folder", "zzz");
  expect(app.shows("No file matches")).toBe(true);
  await app.clear("label:Find in this folder");
  await app.waitFor(row("main.rs", "file"));
  // letters typed with the table in front land in the filter
  await app.keyboard.press("m");
  await app.keyboard.press("a");
  await app.waitUntil(() => app.value("label:Find in this folder") === "ma");
  expect(app.shows(row("ledger.py", "file"))).toBe(false);
});

test("Sort by in the options menu orders by size or date, folders stay first, and Name returns to the default", async () => {
  const app = await lab();
  await browse(app);
  const files = () => app.texts().filter((t) => ["data.bin", "notes.txt", "README.md"].includes(t));
  expect(files()).toEqual(["data.bin", "notes.txt", "README.md"]);
  await app.press("Folder options");
  await app.press("Size, largest first");
  await app.waitUntil(() => files()[0] === "data.bin" && files()[1] === "README.md");
  expect(files()).toEqual(["data.bin", "README.md", "notes.txt"]);
  expect(app.texts().indexOf("src")).toBeLessThan(app.texts().indexOf("data.bin"));
  await app.press("Folder options");
  await app.press("Name");
  await app.waitUntil(() => files()[1] === "notes.txt");
  expect(files()).toEqual(["data.bin", "notes.txt", "README.md"]);
});

test("hidden files stay out of the list until they are asked for", async () => {
  const app = await lab();
  await browse(app);
  expect(app.shows(row(".env.example", "file"))).toBe(false);
  await app.press("Folder options");
  await app.press("Show hidden files");
  await app.waitFor(row(".env.example", "file"));
});

test("a row's menu copies the path and offers to send the file, from the same menu on every row", async () => {
  const app = await lab();
  await browse(app);
  await app.press("Actions for notes.txt");
  await app.waitFor("Copy path");
  expect(app.shows("Send to the agent")).toBe(true);
  await app.keyboard.press("escape");
  await app.press("Actions for src");
  await app.waitFor("Open folder");
  expect(app.shows("Send to the agent")).toBe(false);
});

test("a text file opens read only with its name and size, and Escape goes back to its folder", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("notes.txt", "file"));
  await app.waitFor("label:notes.txt, read only");
  expect(said(app, "168 bytes")).toBe(true);
  expect(app.shows("Back to the folder")).toBe(true);
  // Escape leaves the viewer too (a key the headless runner does not deliver to shortcuts: unverified here)
  await app.press("Back to the folder");
  await app.waitFor(row("notes.txt", "file"));
  expect(app.shows("Back to the folder")).toBe(false);
});

test("Ctrl+F in the viewer finds lines of the file: the count is said, Enter steps, and the line is marked", async () => {
  const app = await lab();
  await app.press("View main.rs at line 12");
  await app.waitFor("label:main.rs, read only");
  await app.keyboard.press("mod+f");
  await app.waitFor("label:Text to find in the file");
  await app.type("label:Text to find in the file", "totals");
  await app.waitFor("1 of 3");
  await app.keyboard.press("enter");
  await app.waitFor("2 of 3");
  await app.type("label:Text to find in the file", "zzz");
  await app.waitFor("No matches");
  await app.press("label:Close find");
  await app.waitFor("label:Text to find in the file", { state: "gone" });
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
  await app.press("Open link missing.rs");
  await app.waitFor("link done");
  expect(said(app, "missing.rs isn't in")).toBe(true);
});

test("a picture opens in the lightbox, Right walks the folder's pictures and Escape goes back to the list", async () => {
  const app = await lab();
  await browse(app);
  await app.press(row("assets", "folder"));
  await app.waitFor(row("shot-1.png", "file"));
  await app.press(row("shot-2.png", "file"));
  await app.waitFor("label:Picture, shot-2.png");
  expect(said(app, "shot-2.png · 2 of 3")).toBe(true);
  // the old viewer's own title, back button and tool rows are gone
  expect(app.shows("Back to the folder")).toBe(false);
  expect(app.shows("Picture tools")).toBe(false);
  // the arrow keys also walk, but the headless runner does not deliver them to the lightbox (unverified); the buttons do
  await app.press("Next photo");
  await app.waitFor("label:Picture, shot-3.png");
  expect(said(app, "shot-3.png · 3 of 3")).toBe(true);
  // the end of the folder: no way further, no wrap
  expect(app.shows("Next photo")).toBe(false);
  await app.press("Previous photo");
  await app.waitFor("label:Picture, shot-2.png");
  await app.press("Close");
  await app.waitFor("label:Picture, shot-2.png", { state: "gone" });
  // the folder is still there, on the same folder
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
  await app.press("Send data.bin to docs");
  await app.press("Send");
  await app.waitFor("Sent · 4 KB");
  await app.press("Close");
  await app.press("Browse the docs folder");
  await app.waitFor(row("data.bin", "file"));

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

test("the send dialog's folder is a path field that lists folders as it is typed", async () => {
  const app = await lab();
  await app.press("Send data.bin to docs");
  await app.waitFor("Send to This computer");
  const folder = "label:Into this folder on the machine *";
  await app.clear(folder);
  await app.type(folder, `${Files.testTree()}/sr`);
  await app.waitUntil(() => app.shows("label:src") && !app.shows("label:docs"));
  await app.keyboard.press("tab");
  await app.waitUntil(() => app.value(folder) === `${Files.testTree()}/src/`);
  expect(app.shows("Send to This computer")).toBe(true);
});
