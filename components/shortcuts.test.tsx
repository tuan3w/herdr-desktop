import { expect, open, test } from "nsh/test";

const lab = (platform: "macos" | "linux") => open("./shortcuts-lab.tsx", { width: 1280, height: 800, platform });

test("the list names every shortcut with its keys as this platform writes them, and closes", async () => {
  const app = await lab("linux");
  expect(app.shows("Keyboard shortcuts")).toBe(false);
  await app.press("Show shortcuts");
  expect(app.shows("Keyboard shortcuts")).toBe(true);
  expect(app.shows("label:Command palette: Ctrl+P")).toBe(true);
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
  expect(app.shows("label:Command palette: ⌘P")).toBe(true);
  expect(app.shows("label:Keyboard shortcuts: ⌘/")).toBe(true);
});
