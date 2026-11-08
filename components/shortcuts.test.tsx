import { expect, open, test } from "nsh/test";

const lab = (platform: "macos" | "linux", terminal = false) =>
  open("./shortcuts-lab.tsx", { width: 1280, height: 800, platform, host: { params: { terminal } } });

const SWITCH = "label:Switch between an agent's chat and its terminal: Ctrl+Shift+M";

test("the list names every shortcut with its keys as this platform writes them, and closes", async () => {
  const app = await lab("linux");
  expect(app.shows("Keyboard shortcuts")).toBe(false);
  await app.press("Show shortcuts");
  expect(app.shows("Keyboard shortcuts")).toBe(true);
  // the palette has a second chord a terminal program cannot take, listed after the first
  expect(app.shows("label:Command palette: Ctrl+P, Ctrl+Shift+L")).toBe(true);
  expect(app.shows("label:Next agent that needs you: Ctrl+J")).toBe(true);
  expect(app.shows("label:Open beside: Ctrl+\\")).toBe(true);
  expect(app.shows("label:Switch to the previous agent: Ctrl+Tab")).toBe(true);
  expect(app.shows("label:Back to the place you came from: Ctrl+[")).toBe(true);
  // F1 is Help on Linux, so it is listed there beside the shared key
  expect(app.shows("label:Keyboard shortcuts: F1, Ctrl+/")).toBe(true);
  await app.press("Close");
  expect(app.shows("Keyboard shortcuts")).toBe(false);
});

test("on a Mac the same list uses Command and has no F1", async () => {
  const app = await lab("macos");
  await app.press("Show shortcuts");
  expect(app.shows("label:/^Command palette: ⌘P, /")).toBe(true);
  expect(app.shows("label:Keyboard shortcuts: ⌘/")).toBe(true);
});

test("the terminal's switch is listed only while the terminal tab is on: off, its key does nothing", async () => {
  const off = await lab("linux");
  await off.press("Show shortcuts");
  expect(off.shows("label:Next agent that needs you: Ctrl+J")).toBe(true);
  expect(off.shows(SWITCH)).toBe(false);
  const on = await lab("linux", true);
  await on.press("Show shortcuts");
  expect(on.shows(SWITCH)).toBe(true);
});
