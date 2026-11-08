import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "macos" } as const;

test("an icon button shows its tooltip, with the shortcut, to a keyboard user who Tabs onto it", async () => {
  const app = await open("./buttons-probe.tsx", DESKTOP);
  await app.wait(100);
  expect(app.shows("text:Reload changes")).toBe(false);
  await app.keyboard.press("tab");
  await app.wait(50);
  expect(app.shows("text:Reload changes")).toBe(true);
  // The shortcut is one cap per key (`lib/keycaps.ts`): on a Mac Ctrl is its glyph.
  expect(app.shows("text:⌃")).toBe(true);
  expect(app.shows("text:R")).toBe(true);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("reloads:1");
  await app.keyboard.press("tab");
  await app.wait(50);
  expect(app.shows("text:Reload changes")).toBe(false);
});

test("a busy button stays a stop of Tab and ignores presses until it is done; a disabled one is not a stop", async () => {
  const app = await open("./buttons-probe.tsx", DESKTOP);
  await app.wait(100);
  expect(app.enabled("label:Save, busy")).toBe(true);
  expect(app.enabled("Locked")).toBe(false);
  await app.press("label:Save, busy");
  expect(app.texts()).toContain("saves:0");
  await app.press("Finish");
  await app.press("Save");
  expect(app.texts()).toContain("saves:1");
});

test("a disabled icon button is named, says disabled, is not a stop of Tab and ignores presses", async () => {
  const app = await open("./buttons-probe.tsx", DESKTOP);
  await app.wait(100);
  // Named (found by its label) and disabled; a press on it is refused by the harness, so nothing can count.
  expect(app.enabled("label:New agent session in offline")).toBe(false);
  await expect(app.press("label:New agent session in offline")).rejects.toThrow(/disabled/);
  expect(app.texts()).toContain("reloads:0");
  // Tab lands on the enabled icon button, then leaves the disabled one out.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  expect(app.texts()).not.toContain("reloads:100");
});
