import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/** The file features of a pane tab in the whole app, against the scripted herdr (its folders do not exist on this computer). */
const app = () =>
  open("../App.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    host: { params: { fixture: "mixed" } },
    // These are the terminal tab's file features: the tab is off by default (`terminalEnabled`).
    storage: { "herdr.settings.v1": JSON.stringify({ terminalEnabled: true }) },
  });

const said = (a: App, part: string) => a.texts().some((t) => t.includes(part));

/** Opens the agent; an agent with a chat opens as one, so the terminal is chosen the way a person does (`Show terminal`). */
async function openTerminal(a: App) {
  await a.press("text:payments review >> nth=0");
  await a.waitFor("Show terminal");
  await a.press("Show terminal");
  await a.waitFor("label:/^Terminal, /");
}

test("Browse files in the header opens a Files tab on the pane's folder and machine, and says when the folder is not there", async () => {
  const a = await app();
  await openTerminal(a);
  await a.press("Browse files");
  await a.waitFor("Cannot open this folder");
  expect(said(a, "/home/dev/payments-api")).toBe(true);
  // a tab beside the terminal, named for the folder, and the path once as a breadcrumb
  expect(said(a, "Files \u00b7 payments-api")).toBe(true);
  expect(a.shows("label:Folder path")).toBe(true);
  // closing the tab leaves the terminal
  await a.press("label:/^Close tab Files/");
  await a.waitFor("Cannot open this folder", { state: "gone" });
  expect(a.shows("label:/^Terminal, /")).toBe(true);
});

test("a file dropped on the pane is offered to the pane's folder, and a drop that is not a local file is refused", async () => {
  const a = await app();
  await openTerminal(a);
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
