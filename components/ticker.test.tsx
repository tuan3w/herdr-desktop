import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, clock: {} };
const timer = (app: App) => (app.texts().includes("timer on") ? "on" : "off");
const settle = (app: App) => app.clock!.runFor(50);

test("the shared timer exists only while a looping indicator is on screen, once for all of them", async () => {
  const app = await open("./ticker-lab.tsx", { ...DESKTOP, reducedMotion: false });
  await settle(app);
  expect(timer(app)).toBe("off");
  for (let i = 0; i < 3; i += 1) await app.press("More");
  await settle(app);
  expect(timer(app)).toBe("on");
  await app.press("Clear");
  await settle(app);
  expect(timer(app)).toBe("off");
});

test("a hidden window stops the timer and showing it again restarts it", async () => {
  const app = await open("./ticker-lab.tsx", { ...DESKTOP, reducedMotion: false });
  await app.press("More");
  await settle(app);
  expect(timer(app)).toBe("on");
  await app.setLifecycle("background");
  await settle(app);
  expect(timer(app)).toBe("off");
  await app.setLifecycle("active");
  await settle(app);
  expect(timer(app)).toBe("on");
});

test("an indeterminate progress bar counts as an indicator too", async () => {
  const app = await open("./ticker-lab.tsx", { ...DESKTOP, reducedMotion: false });
  for (let i = 0; i < 4; i += 1) await app.press("More");
  await app.press("Clear");
  await settle(app);
  expect(timer(app)).toBe("off");
});
