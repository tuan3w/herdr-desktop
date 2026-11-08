import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * A chat's inspector, through `session-inspector-lab.tsx`: a Claude Code chat whose synthetic log names three subagents (one
 * running in the background, one finished, one that fails) and five background tasks, over a port of the lab (no herdr).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const lab = (params: Record<string, unknown> = {}) =>
  open("./session-inspector-lab.tsx", { ...DESKTOP, host: { params } });
const label = (re: string) => `label:/${re}/`;
const texts = (app: App) => app.texts();
const logged = (app: App, part: string) => texts(app).some((t) => t.startsWith("Log:") && t.includes(part));

test("rows sit under their section, which says the state once; the agent type and the whole prompt are not on a row", async () => {
  const app = await lab({ open: true });
  await app.waitFor(label("^Running, 4$"));
  expect(
    app.shows(label("^Audit auth module, running 4m, Audit the auth module for session fixation\\.\\. Open")),
  ).toBe(true);
  expect(app.shows(label("^pnpm test --watch, running 14m"))).toBe(true);
  // Said once: the section heading says Running, no row says it, and the kind is only in the tooltip.
  expect(texts(app).filter((t) => /running/i.test(t) && !t.startsWith("Log:"))).toEqual(["Running"]);
  expect(texts(app).some((t) => t.includes("general-purpose"))).toBe(false);
  expect(texts(app).some((t) => t.includes("Do not change any file"))).toBe(false);
  // A subagent started in the background is one row, not a subagent and a task.
  expect(texts(app).filter((t) => t === "Audit auth module")).toHaveLength(1);
  // The command reads as the chat's lines do, not `cd /home/dev/payments && …`.
  expect(texts(app).some((t) => t.startsWith("cd "))).toBe(false);
  // No failure arrived while the chat was open: nothing needs the person.
  expect(app.shows(label("^Needs you"))).toBe(false);
});

test("finished work is one muted line that opens to rows grouped by name", async () => {
  const app = await lab({ open: true });
  await app.waitFor(label("^Finished 4 · last 35 min ago$"));
  expect(app.shows(label("^List migrations"))).toBe(false);
  await app.press(label("^Finished 4 · last 35 min ago$"));
  await app.waitFor(label("^List migrations, 1 times, last 35 min ago"));
  expect(app.shows(label("^pnpm build, 2 times, last 50 min ago$"))).toBe(true);
  expect(texts(app)).toContain("×2");
});

test("closed, the chat keeps one quiet line about what runs, and Show opens the inspector", async () => {
  const app = await lab();
  await app.waitFor(label("^2 subagents and 2 background tasks running, show activity$"));
  expect(app.shows("label:Activity")).toBe(false);
  await app.press(label("^2 subagents and 2 background tasks running, show activity$"));
  await app.waitFor(label("^Running, 4$"));
  expect(app.shows(label("show activity$"))).toBe(false);
});

test("a failure that arrives while the chat is open opens the inspector by itself under Needs you, and Clear files it", async () => {
  const app = await lab();
  await app.waitFor(label("show activity$"));
  await app.press("Subagent fails");
  await app.waitFor(label("^Needs you, 1$"));
  expect(app.shows(label("^Check schema drift, failed"))).toBe(true);
  expect(app.shows(label("^Running, 3$"))).toBe(true);
  await app.press(label("^Clear, move 1 to Finished$"));
  await app.waitUntil(() => !app.shows(label("^Needs you")));
  expect(app.shows(label("^Finished 5"))).toBe(true);
});

test("a subagent opens its own conversation, read-only, and Back returns to the list", async () => {
  const app = await lab({ open: true });
  await app.press(label("^Audit auth module, running.*Open its conversation$"));
  await app.waitFor("label:Subagent conversation: Audit auth module");
  await app.waitFor(label("^You: Audit the auth module for session fixation"));
  expect(app.shows(label("^Agent: Reading"))).toBe(true);
  expect(texts(app)).toContain("Read only. Messages go to Harden the session handling, which relays them.");
  expect(texts(app)).toContain("Running · 4m");
  expect(logged(app, "open Audit auth module")).toBe(true);
  // One message box on screen: the parent's. The subagent's conversation has none.
  expect(app.count("label:Message")).toBe(1);
  await app.press("label:Back to activity");
  await app.waitFor(label("^Running, 4$"));
  expect(logged(app, "close Audit auth module")).toBe(true);
});

test("stopping a task that ran over a minute takes a second press within 4 s; a younger one stops at once", async () => {
  const app = await lab({ open: true });
  await app.press("label:Stop pnpm test --watch");
  await app.waitFor("label:Press again to stop pnpm test --watch");
  expect(logged(app, "stop ")).toBe(false);
  await app.press("label:Press again to stop pnpm test --watch");
  await app.waitUntil(() => logged(app, "stop 0/b1"));

  await app.press("label:Stop Watch build.log for errors");
  await app.waitUntil(() => logged(app, "stop 0/b2"));
  expect(app.shows("label:Press again to stop Watch build.log for errors")).toBe(false);
});

test("a log without times shows no duration and no age: nothing is invented", async () => {
  const app = await lab({ open: true, notimes: true });
  await app.waitFor(label("^Running, 4$"));
  expect(app.shows(label("^Audit auth module, running, Audit"))).toBe(true);
  expect(app.shows(label("^Finished 4$"))).toBe(true);
  expect(texts(app).some((t) => /^(<1m|\d+m|\d+h)/.test(t) || t.endsWith(" ago"))).toBe(false);
});
