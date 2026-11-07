import { expect, open, test } from "nsh/test";

const lab = () => open("./palette-lab.tsx", { width: 1280, height: 800, platform: "linux" });

test("typing narrows the list, Enter runs the match and closes the palette", async () => {
  const app = await lab();
  await app.press("Open palette");
  expect(app.shows("Command palette")).toBe(true);
  expect(app.shows("Go to board")).toBe(true);
  await app.type("label:Search commands", "attention");
  expect(app.shows("Go to board")).toBe(false);
  expect(app.shows("Next agent that needs you")).toBe(true);
  await app.press("Next agent that needs you");
  expect(app.texts()).toContain("ran next");
  expect(app.shows("Command palette")).toBe(false);
});

test("a query that matches nothing says so, and a disabled command is never run", async () => {
  const app = await lab();
  await app.press("Open palette");
  await app.type("label:Search commands", "zzz");
  expect(app.shows("No command matches")).toBe(true);
  await app.clear("label:Search commands");
  expect(app.enabled("Close pane")).toBe(false);
  expect(app.texts()).toContain("nothing ran");
});
