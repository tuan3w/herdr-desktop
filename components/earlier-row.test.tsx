import { expect, open, test } from "nsh/test";

import { TOO_LONG } from "#lib/earlier";

const DESKTOP = { width: 1280, height: 800, clock: {} };

test("older rows are one press away, and the press asks once", async () => {
  const app = await open("./earlier-row-lab.tsx", { ...DESKTOP, reducedMotion: true });
  expect(app.texts()).toContain("asked 0");
  await app.press("Load earlier messages");
  expect(app.texts()).toContain("asked 1");
});

test("while it reads there is a line and no button, and when the log is whole there is nothing", async () => {
  const app = await open("./earlier-row-lab.tsx", { ...DESKTOP, reducedMotion: true });
  await app.press("Loading");
  expect(app.texts()).toContain("Loading earlier messages…");
  expect(app.texts()).not.toContain("Load earlier messages");
  await app.press("None");
  expect(app.texts()).not.toContain("Loading earlier messages…");
  expect(app.texts()).not.toContain("Load earlier messages");
});

test("a log longer than the widest read says so and offers nothing to press", async () => {
  const app = await open("./earlier-row-lab.tsx", { ...DESKTOP, reducedMotion: true });
  await app.press("Too long");
  expect(app.texts()).toContain(TOO_LONG);
  expect(app.texts()).not.toContain("Load earlier messages");
});
