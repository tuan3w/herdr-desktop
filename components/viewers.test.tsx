import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/**
 * The viewers of `fixtures/files/viewers` (a PDF, a zip and a tar.gz, a table, minified JSON, an SVG, a log, a binary) and
 * of the project folder (a PNG), plus a generated log over 4 MB, through the media lab. Each is read from the real file by
 * the real core; nothing is stubbed but the media engine (`components/media.test.tsx`).
 */
const lab = (platform: "linux" | "macos" = "linux") => open("./media-lab.tsx", { ...DESKTOP, platform });

const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

test("a minified JSON file is laid out for reading, and one switch shows it as written", async () => {
  const app = await lab();
  await app.press("View config.json");
  await app.waitFor("label:config.json, read only");
  expect(app.shows("label:config.json view")).toBe(true);
  expect(said(app, '"name": "herdr-demo"')).toBe(true);
  await app.press("label:As written");
  await app.waitFor("label:config.json, read only");
  expect(said(app, '"name": "herdr-demo"')).toBe(false);
  expect(said(app, '"name":"herdr-demo"')).toBe(true);
});

test("a table shows as a table with its header, the row count and a way to its text", async () => {
  const app = await lab();
  await app.press("View table.csv");
  await app.waitFor("label:table.csv as a table");
  expect(said(app, "24 rows · 4 columns")).toBe(true);
  await app.press("label:Text");
  await app.waitFor("label:table.csv, read only");
  expect(app.shows("label:table.csv as a table")).toBe(false);
});

test("a zip lists its entries without unpacking, and so does a tar.gz", async () => {
  const app = await lab();
  await app.press("View bundle.zip");
  await app.waitFor("label:Contents of bundle.zip");
  expect(said(app, "5 entries · 3 files · zip")).toBe(true);
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.press("View bundle.tar.gz");
  await app.waitFor("label:Contents of bundle.tar.gz");
  expect(said(app, "tar.gz")).toBe(true);
});

test("a binary shows its size, what its bytes announce and a hex dump of its first bytes", async () => {
  const app = await lab();
  await app.press("View tool.bin");
  await app.waitFor("Not a text file");
  await app.waitFor("Looks like: ELF executable");
  expect(app.shows("label:/^Hex dump of the first 4096 bytes/")).toBe(true);
  expect(said(app, "00000000  7f 45 4c 46 02 01 01 00")).toBe(true);
  expect(said(app, "The first 4 KB of 6 KB are shown")).toBe(true);
  expect(app.enabled("Reveal in the file manager")).toBe(true);
});

test("a PDF says what it is and offers the system's viewer", async () => {
  const app = await lab();
  await app.press("View report.pdf");
  await app.waitFor("PDF document · 594 bytes");
  expect(app.shows("Open in the system viewer")).toBe(true);
  expect(app.shows("label:report.pdf, PDF document")).toBe(true);
  expect(app.shows("Send to the agent")).toBe(true);
  expect(app.shows("Copy path")).toBe(true);
});

test("an SVG is a picture whose source is text: it copies as contents, not as an image", async () => {
  const app = await lab();
  await app.press("View logo.svg");
  await app.waitFor("label:logo.svg, picture");
  expect(app.shows("Copy contents")).toBe(true);
  expect(app.shows("Copy image")).toBe(false);
  await app.press("Copy contents");
  await app.waitFor("Contents copied");
  expect(app.clipboard()).toContain("<svg");
});

test("a picture has zoom, fit, actual size and a turn, and copies as an image", async () => {
  const app = await lab();
  await app.press("View shot-2.png");
  await app.waitFor("label:Picture tools");
  expect(app.shows("Copy image")).toBe(true);
  expect(app.shows("Zoom in")).toBe(true);
  expect(app.shows("Zoom out")).toBe(true);
  expect(app.shows("Rotate")).toBe(true);
  await app.press("Actual size");
  await app.waitFor("label:Zoom 100%");
  await app.press("Zoom in");
  await app.waitFor("label:Zoom 125%");
  await app.keyboard.press("minus");
  await app.waitFor("label:Zoom 100%");
  await app.keyboard.press("0");
  await app.press("Rotate");
  await app.press("Copy image");
  await app.waitFor("Image copied");
});

test("Copy contents puts the text of a file on the clipboard", async () => {
  const app = await lab();
  await app.press("View server.log");
  await app.waitFor("label:server.log, read only");
  await app.press("Copy contents");
  await app.waitFor("Contents copied");
  expect(app.clipboard()).toContain("worker-3 handled request 299");
});

test("Send to the agent mentions the file in the open chat, and says what to do when none is open", async () => {
  const app = await lab();
  await app.press("View server.log");
  await app.waitFor("label:server.log, read only");
  await app.press("Send to the agent");
  await app.waitFor("Open the agent's chat on this machine first, then send the file");
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.press("Open the chat");
  await app.press("View server.log");
  await app.waitFor("label:server.log, read only");
  await app.press("Send to the agent");
  await app.waitFor("server.log added to the message");
  expect(said(app, "mentioned local ")).toBe(true);
  expect(said(app, "/server.log")).toBe(true);
});

test("on a Mac the file manager is Finder, in the button and its name", async () => {
  const app = await lab("macos");
  await app.press("View server.log");
  await app.waitFor("label:server.log, read only");
  expect(app.shows("Reveal in Finder")).toBe(true);
  expect(app.shows("Reveal in the file manager")).toBe(false);
});

test("a text file over 4 MB is paged by lines: the count grows, Ctrl+F finds through all of it, Go to line jumps", async () => {
  const app = await lab();
  await app.press("View big.log");
  await app.waitFor("label:big.log, read only");
  await app.waitFor("120,000 lines");
  await app.waitUntil(() => said(app, "0000000 hay"));
  await app.keyboard.press("mod+f");
  await app.waitFor("label:Text to find in the file");
  await app.type("label:Text to find in the file", "needle");
  await app.waitFor("Line 45,679");
  await app.waitUntil(() => said(app, "0045678 the NEEDLE"));
  await app.type("label:Text to find in the file", "zzzz");
  await app.waitFor("No matches");
  await app.press("label:Close find");
  await app.type("label:Go to line", "90000");
  await app.submit("label:Go to line");
  await app.waitUntil(() => said(app, "0089999 hay"));
});

test("Space previews the highlighted file beside the list, the preview follows the highlight, and Escape closes it first", async () => {
  const app = await lab();
  await app.press("Browse viewers");
  await app.waitFor("label:/^bundle.zip, file/");
  await app.keyboard.press("space");
  await app.waitFor("label:Preview");
  await app.waitFor("label:Contents of bundle.tar.gz");
  await app.type("label:Find in this folder", "");
  await app.keyboard.press("down");
  await app.waitFor("label:Contents of bundle.zip");
  await app.keyboard.press("down");
  await app.waitFor("label:config.json, read only");
  await app.keyboard.press("escape");
  await app.waitFor("label:Preview", { state: "gone" });
  expect(app.shows("label:/^bundle.zip, file/")).toBe(true);
  await app.keyboard.press("space");
  await app.waitFor("label:Preview");
  await app.keyboard.press("space");
  await app.waitFor("label:Preview", { state: "gone" });
});

test("Enter opens the previewed file in the full viewer, which steps through the folder with the bracket keys", async () => {
  const app = await lab();
  await app.press("Browse viewers");
  await app.waitFor("label:/^bundle.zip, file/");
  await app.type("label:Find in this folder", "");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("label:Contents of bundle.zip");
  expect(said(app, "File 2 of 8")).toBe(true);
  await app.keyboard.press("]");
  await app.waitFor("label:config.json, read only");
  expect(said(app, "File 3 of 8")).toBe(true);
  await app.keyboard.press("[");
  await app.waitFor("label:Contents of bundle.zip");
});

test("a video or sound in the preview is a card, never decoded or copied from another machine", async () => {
  const app = await lab();
  await app.press("Browse media");
  await app.waitFor("label:/^broken.mp4, file/");
  await app.keyboard.press("space");
  await app.waitFor("Video · 40 bytes. Enter opens it in the player.");
  expect(app.shows("label:Player controls")).toBe(false);
});
