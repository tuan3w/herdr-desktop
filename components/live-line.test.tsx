import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * The live line at the end of a running turn (`Footer` in `session-transcript.tsx`), through the scripted chat of
 * `session-lab.tsx` on a manual clock: what it says, how long, whether its glyph turns (the shared ticker runs), and that
 * all of it goes when the turn ends.
 */
const LAB = (scene: string, reducedMotion = false) =>
  open("./session-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    clock: {},
    reducedMotion,
    host: { params: { mode: "scripted", scene, ticker: true } },
  });

const LIVE = "role:timer";
const said = (app: App, text: string) => app.texts().includes(text);
const ticker = (app: App) => (said(app, "Ticker on") ? "on" : "off");

test("the line names the running call and how long it has run, by the second, and goes with the turn", async () => {
  const app = await LAB("working");
  await app.waitFor("label:Running pnpm test promo-eu");
  await app.clock!.runFor(12_000);
  expect(said(app, "Running pnpm test promo-eu")).toBe(true);
  expect(said(app, "· 12s")).toBe(true);
  await app.clock!.runFor(52_000);
  expect(said(app, "· 1m 04s")).toBe(true);
  expect(ticker(app)).toBe("off");

  await app.press("Finish the turn");
  await app.waitUntil(() => !app.shows(LIVE));
  expect(app.texts().some((t) => t.startsWith("· "))).toBe(false);
  await app.clock!.runFor(50);
  expect(ticker(app)).toBe("off");
});

test("while the agent is heard from its glyph turns; a minute of silence stills it and says so, and the end stops it", async () => {
  const app = await LAB("working");
  await app.waitFor("label:Running pnpm test promo-eu");
  await app.clock!.runFor(1_000);
  expect(ticker(app)).toBe("on");

  await app.clock!.runFor(60_000);
  expect(said(app, "Quiet for 1m")).toBe(true);
  expect(ticker(app)).toBe("off");

  // Something arrives: heard from again, it turns again and the quiet note goes.
  await app.press("Agent starts a message");
  await app.clock!.runFor(1_000);
  expect(said(app, "Quiet for 1m")).toBe(false);
  expect(ticker(app)).toBe("on");

  await app.press("Finish the turn");
  await app.waitUntil(() => !app.shows(LIVE));
  await app.clock!.runFor(50);
  expect(ticker(app)).toBe("off");
});

test("a turn the person starts says Thinking with its clock until a call opens", async () => {
  const app = await LAB("chat");
  await app.type("label:Message", "Run the tests");
  await app.submit("label:Message");
  await app.waitFor("label:Thinking");
  await app.clock!.runFor(3_000);
  expect(said(app, "· 3s")).toBe(true);

  await app.press("Start a call");
  await app.waitFor("label:Running pnpm lint");
  await app.clock!.runFor(1_000);
  expect(said(app, "· 1s")).toBe(true);
});

test("a turn already running when the chat opened has no clock: a time it did not watch would be invented", async () => {
  const app = await LAB("tools");
  await app.waitFor("label:Running pnpm test promo-eu");
  await app.clock!.runFor(5_000);
  expect(app.texts().some((t) => t.startsWith("· "))).toBe(false);
});

test("under reduced motion the glyph stands still and the clock still moves", async () => {
  const app = await LAB("working", true);
  await app.waitFor("label:Running pnpm test promo-eu");
  await app.clock!.runFor(5_000);
  expect(said(app, "· 5s")).toBe(true);
  expect(ticker(app)).toBe("off");
});
