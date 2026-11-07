import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The file features of a pane tab in the whole app, against the scripted herdr (its folders do not exist on this computer). */
const app = () => open("../App.tsx", { width: 1280, height: 800, platform: "linux", host: { params: { fixture: "mixed" } } });

const said = (a: App, part: string) => a.texts().some((t) => t.includes(part));

/** Opens the agent; an agent with a chat opens as one, so the terminal is chosen the way a person does (`Show terminal`). */
async function openPane(a: App) {
  await a.press("text:payments review >> nth=0");
  await a.waitFor("Show terminal");
  await a.press("Show terminal");
  await a.waitFor("label:/^Terminal, /");
}

test("Browse files in the header opens the pane's folder on its machine, and says when the folder is not there", async () => {
  const a = await app();
  await openPane(a);
  await a.press("Browse files");
  await a.waitFor("Cannot open this folder");
  expect(said(a, "/home/dev/payments-api")).toBe(true);
  await a.press("Close");
  await a.waitFor("Cannot open this folder", { state: "gone" });
});

test("a file dropped on the pane is offered to the pane's folder, and a drop that is not a local file is refused", async () => {
  const a = await app();
  await openPane(a);
  await a.dropFiles("label:/^Terminal, /", ["https://example.com/a.txt"]);
  await a.waitFor("Only files from this computer can be sent");
  expect(a.shows("Send to This computer")).toBe(false);

  await a.dropFiles("label:/^Terminal, /", ["file:///tmp/a%20file.txt", "file:///tmp/other.txt"]);
  await a.waitFor("Send to This computer");
  expect(a.value("label:/^Into this folder/")).toBe("/home/dev/payments-api");
  expect(said(a, "2 files: a file.txt, other.txt")).toBe(true);
  // nothing was sent: the folder is only a proposal until Send
  await a.press("Cancel");
  await a.waitFor("Send to This computer", { state: "gone" });
});
