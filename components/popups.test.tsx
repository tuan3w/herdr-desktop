import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "macos" } as const;

async function lab() {
  const app = await open("./popups.fixture.tsx", DESKTOP);
  await app.wait(100);
  return app;
}

test("a popover opens on a press, is named by its title, and toggles shut on the trigger", async () => {
  const app = await lab();
  expect(app.shows("label:Visible columns")).toBe(false);
  await app.press("label:Choose columns");
  // the title names the popup for screen readers, and the description is its hint
  expect(app.shows("label:Visible columns")).toBe(true);
  expect(app.texts()).toContain("Choose the columns shown in the table.");
  expect(app.texts()).toContain("Reason: open: trigger-press");
  await app.press("label:Choose columns");
  expect(app.shows("label:Visible columns")).toBe(false);
  expect(app.texts()).toContain("Reason: close: trigger-press");
});

test("a popover closes on its close button, on a control inside that asks it to, on Escape and on a press outside", async () => {
  const app = await lab();
  await app.press("label:Choose columns");
  await app.press("label:Close columns panel");
  expect(app.shows("label:Visible columns")).toBe(false);
  expect(app.texts()).toContain("Reason: close: item-press");

  await app.press("label:Choose columns");
  await app.press("label:Apply");
  expect(app.texts()).toContain("Applied: 1");
  expect(app.shows("label:Visible columns")).toBe(false);

  await app.press("label:Choose columns");
  await app.keyboard.press("escape");
  expect(app.shows("label:Visible columns")).toBe(false);
  expect(app.texts()).toContain("Reason: close: escape-key");

  await app.press("label:Choose columns");
  await app.press("label:Keep tooltip");
  expect(app.shows("label:Visible columns")).toBe(false);
  expect(app.texts()).toContain("Reason: close: outside-press");
});

test("a popover inside a popover: a press inside it keeps the parent, and Escape closes only the topmost", async () => {
  const app = await lab();
  await app.press("label:Choose columns");
  await app.press("label:Add column");
  expect(app.shows("text:Nested popover")).toBe(true);
  expect(app.shows("label:Visible columns")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("text:Nested popover")).toBe(false);
  expect(app.shows("label:Visible columns")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Visible columns")).toBe(false);
});

test("a tooltip shows for the keyboard focus and goes with Escape or blur; a disabled one never shows", async () => {
  const app = await lab();
  expect(app.shows("text:Quick note")).toBe(false);
  await app.keyboard.press("tab");
  await app.wait(50);
  expect(app.shows("text:Quick note")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("text:Quick note")).toBe(false);

  await app.keyboard.press("shift+tab");
  await app.keyboard.press("tab");
  await app.wait(50);
  await app.keyboard.press("tab");
  await app.wait(50);
  // on to the next control: the first bubble is gone, the next one shows
  expect(app.shows("text:Quick note")).toBe(false);
  await app.keyboard.press("tab");
  await app.wait(50);
  expect(app.shows("text:Turned off")).toBe(false);
});

test("a tooltip and a popover inside a dialog live in the dialog's own root", async () => {
  const app = await lab();
  await app.press("label:Open dialog");
  await app.wait(300);
  expect(app.shows("label:Button in dialog")).toBe(true);
  await app.press("label:Choose columns >> nth=1");
  expect(app.shows("label:Visible columns")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Visible columns")).toBe(false);
  // the dialog itself is still open
  expect(app.shows("label:Button in dialog")).toBe(true);
});
