import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import app from "../nsh.json";

const DESKTOP = { width: 1280, height: 1400 };
const KEY = "herdr.settings.v1";

const saved = (a: App): Record<string, unknown> => JSON.parse(a.storage()[KEY] ?? "{}");

/** Settings is a dialog over the lab: it opens on Look, and `page` goes to another one by its nav entry. */
/** A row that only that page has, to wait for it. */
const FIRST_ROW: Record<string, string> = {
  Notifications: "label:Notify me when an agent needs me",
  Accessibility: "label:Announce agent output",
  About: "label:Check for updates",
};

async function inSettings(options: Parameters<typeof open>[1] = DESKTOP, page?: string): Promise<App> {
  const a = await open("./machines-lab.tsx", options);
  await a.press("Open settings");
  await a.waitFor("label:Settings sections");
  if (page) {
    await a.press(`label:${page}`);
    await a.waitFor(FIRST_ROW[page]);
  }
  return a;
}

test("each option applies at once and is saved at once, with no Save button", async () => {
  const a = await inSettings();
  expect(a.texts()).toContain("announce=false motion=false");
  expect(a.shows("Save")).toBe(false);

  await a.press("label:/^Chart/");
  expect(a.texts().some((t) => t.endsWith("theme=chart"))).toBe(true);
  await a.waitUntil(() => saved(a).themeId === "chart");

  await a.press("label:Accessibility");
  await a.press("label:Announce agent output");
  expect(a.texts()).toContain("announce=true motion=false");
  await a.waitUntil(() => saved(a).announceOutput === true);
});

test("the pane font size and the minimum contrast are chosen from their lists, and 1 means off", async () => {
  const a = await inSettings();
  await a.press("label:Pane font size: 13 pt");
  await a.press("label:16 pt");
  expect(a.texts().some((t) => t.includes("font=16 "))).toBe(true);
  expect(a.shows("label:Pane font size: 16 pt")).toBe(true);

  expect(a.shows("label:Minimum contrast: 4.5 (recommended)")).toBe(true);
  await a.press("label:Minimum contrast: 4.5 (recommended)");
  await a.press("label:Off");
  expect(a.texts().some((t) => t.includes("contrast=1 "))).toBe(true);
  await a.waitUntil(() => saved(a).minContrast === 1 && saved(a).paneFontSize === 16);
});

test("what was chosen before is what the window opens with, and a saved value out of range is ignored", async () => {
  const stored = {
    themeId: "graphite",
    paneFontSize: 17,
    minContrast: 7,
    announceOutput: true,
    reduceMotionOverride: true,
    // Options this app no longer has: ignored, and gone from the next save.
    paneFit: "actual",
    quickPhrases: false,
  };
  const a = await inSettings({ ...DESKTOP, storage: { [KEY]: JSON.stringify(stored) } });
  await a.waitUntil(() => a.texts().includes("announce=true motion=true"));
  expect(a.texts().some((t) => t.startsWith("font=17 contrast=7 theme=graphite"))).toBe(true);
  // the controls show the loaded values, including a font size that is not a round number
  expect(a.shows("label:Pane font size: 17 pt")).toBe(true);
  expect(a.shows("label:Minimum contrast: 7")).toBe(true);
  await a.press("label:Accessibility");
  await a.press("label:Announce agent output");
  await a.waitUntil(() => saved(a).announceOutput === false);
  expect(Object.keys(saved(a))).not.toContain("paneFit");
  expect(Object.keys(saved(a))).not.toContain("quickPhrases");

  const bad = await inSettings({
    ...DESKTOP,
    storage: { [KEY]: JSON.stringify({ themeId: "nope", paneFontSize: 99, minContrast: 12 }) },
  });
  await bad.waitUntil(() => bad.texts().some((t) => t.startsWith("font=13")));
  expect(bad.texts().some((t) => t === "font=13 contrast=4.5 theme=harbor")).toBe(true);
});

test("how code is drawn is chosen in Settings, applies at once, is saved, and is what the window opens with", async () => {
  const a = await inSettings();
  expect(a.texts()).toContain("code=false/false/false/false");
  await a.press("label:Wrap code");
  await a.press("label:Line numbers in code");
  await a.press("label:Show tabs and spaces");
  await a.press("label:Diffs side by side");
  expect(a.texts()).toContain("code=true/true/true/true");
  await a.waitUntil(
    () =>
      saved(a).codeWrap === true &&
      saved(a).codeLineNumbers === true &&
      saved(a).codeWhitespace === true &&
      saved(a).diffSplit === true,
  );

  const again = await inSettings({
    ...DESKTOP,
    storage: { [KEY]: JSON.stringify({ codeLineNumbers: true, diffSplit: true }) },
  });
  await again.waitUntil(() => again.texts().includes("code=false/true/false/true"));
});

test("Always show scrollbars is off until chosen, is saved at once and is what the window opens with", async () => {
  const a = await inSettings();
  expect(a.shows("label:Always show scrollbars")).toBe(true);
  expect(saved(a).alwaysShowScrollbars).not.toBe(true);
  await a.press("label:Always show scrollbars");
  await a.waitUntil(() => saved(a).alwaysShowScrollbars === true);

  const again = await inSettings({ ...DESKTOP, storage: { [KEY]: JSON.stringify({ alwaysShowScrollbars: true }) } });
  // The saved choice is read back: pressing turns it off, which is only a change when it was on.
  await again.press("label:Always show scrollbars");
  await again.waitUntil(() => saved(again).alwaysShowScrollbars === false);
});

test("Reduce motion turns the app's own transitions off even when the system does not ask", async () => {
  const a = await inSettings(DESKTOP, "Accessibility");
  expect(a.texts()).toContain("press=eased");
  await a.press("label:Reduce motion");
  expect(a.texts()).toContain("press=still");
  await a.press("label:Reduce motion");
  expect(a.texts()).toContain("press=eased");

  const system = await inSettings({ ...DESKTOP, reducedMotion: true }, "Accessibility");
  expect(system.texts()).toContain("press=still");
});

test("About names the app's version from nsh.json, and Machines is a page of Settings with its own list", async () => {
  const a = await inSettings(DESKTOP, "About");
  expect(a.shows(`Version ${app.version}`)).toBe(true);
  await a.press("label:Machines");
  await a.waitFor("Add machine");
  expect(a.shows("This computer")).toBe(true);
  // the nav is still there beside the page, and a press on the scrim does not close the dialog (it holds the form being filled)
  await a.press("id:dialog-scrim");
  expect(a.shows("label:Settings sections")).toBe(true);
  // Close leaves Settings altogether
  expect(a.shows("label:Settings sections")).toBe(true);
  await a.press("label:Close settings");
  await a.waitFor("label:Settings sections", { state: "gone" });
});

test("Escape goes one layer back: a machine's form, then Settings", async () => {
  const a = await inSettings(DESKTOP, undefined);
  await a.press("label:Machines");
  await a.press("Add machine");
  await a.waitFor("label:Name *");
  await a.keyboard.press("escape");
  await a.waitFor("label:Name *", { state: "gone" });
  expect(a.shows("label:Settings sections")).toBe(true);
  await a.keyboard.press("escape");
  await a.waitFor("label:Settings sections", { state: "gone" });
});

test("notifications are off until switched on, the choice is stored by the engine, and the second switch needs the first", async () => {
  const a = await inSettings({ ...DESKTOP, height: 1400 }, "Notifications");
  expect(a.texts()).toContain("notify=false/false");
  expect(a.enabled("label:Notify me when an agent needs me")).toBe(true);
  expect(a.enabled("label:Also when an agent finishes")).toBe(false);

  await a.press("label:Notify me when an agent needs me");
  await a.waitUntil(() => a.texts().includes("notify=true/false"));
  expect(a.enabled("label:Also when an agent finishes")).toBe(true);
  await a.press("label:Also when an agent finishes");
  await a.waitUntil(() => a.texts().includes("notify=true/true"));

  await a.press("label:Notify me when an agent needs me");
  await a.waitUntil(() => a.texts().includes("notify=false/true"));
  expect(a.enabled("label:Also when an agent finishes")).toBe(false);
});
