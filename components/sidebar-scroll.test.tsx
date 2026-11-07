import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/** The sidebar over the `big` fixture (`sidebar-lab.tsx`): 200 agents in 25 projects, many windows tall. */
const lab = () =>
  open("./sidebar-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    clock: {},
    host: { params: { fixture: "big" } },
  });
const LIST = "label:Projects and agents";
const text = (app: App, prefix: string) => app.texts().find((t) => t.startsWith(prefix))!;
const offset = (app: App) => Number(text(app, "tree offset ").slice(12));

const ready = async () => {
  const app = await lab();
  await app.waitFor("label:/^Board, \\d+ need/");
  await app.wait(300);
  return app;
};

/** Changes an agent and waits until the sidebar has read the board again. */
async function tick(app: App) {
  const before = text(app, "board tick ");
  await app.press("Change an agent");
  await app.waitUntil(() => text(app, "board tick ") !== before);
  await app.wait(300);
}

test("a tick of the board leaves a scrolled sidebar where the person left it", async () => {
  const app = await ready();
  await app.scroll(LIST, 2000);
  await app.wait(300);
  const where = offset(app);
  expect(where).toBeGreaterThan(1500);
  for (let i = 0; i < 4; i++) await tick(app);
  expect(offset(app)).toBe(where);
});

test("going to an agent out of sight brings its row into view; going to one in view moves nothing", async () => {
  const app = await ready();
  expect(offset(app)).toBe(0);
  await app.press("Go to the last agent");
  await app.waitUntil(() => offset(app) > 1500);
  const end = offset(app);
  await app.press("Go to the first agent");
  await app.waitUntil(() => offset(app) < end);
  expect(offset(app)).toBe(0);
});
