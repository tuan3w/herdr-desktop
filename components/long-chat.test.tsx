import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * Scrolling a long chat (`long-chat-lab.tsx`: 420 turns of prose, lists, fences of 10 to 80 lines, diffs, open runs of
 * calls, failures and pictures), judged by what the rows do, not by a clock: Markdown split into parts, a code block's
 * language detected, a row that rises in, how far the content moves as rows are measured, where a page key lands. What it costs in time is `.perf/long-chat.test.tsx` (`docs/PERFORMANCE.md`).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

interface Read {
  [count: string]: number;
  offset: number;
  content: number;
  size: number;
}

async function opened(): Promise<App> {
  const app = await open("./long-chat-lab.tsx", { ...DESKTOP, host: { params: { turns: 160 } } });
  await app.waitUntil(() => app.texts().some((t) => /^Rows: [1-9]/.test(t)));
  await app.waitUntil(() => app.texts().includes("At end: yes"));
  return app;
}

/** The lab's counts since the last `reset` and where the list is. */
async function read(app: App): Promise<Read> {
  await app.keyboard.press("ctrl+alt+r");
  let line = "";
  await app.waitUntil(() => {
    line = app.texts().find((t) => t.startsWith("Counts: {")) ?? "";
    return line !== "";
  });
  return JSON.parse(line.slice("Counts: ".length)) as Read;
}

/** Counting from here: what was counted so far is dropped (and the line that showed it). */
async function reset(app: App): Promise<void> {
  await app.keyboard.press("ctrl+alt+0");
  await app.waitUntil(() => app.texts().includes("Counts: "));
}

/** `n` presses of `key`, one after the other (the headless list moves at once). */
async function pages(app: App, key: "pagedown" | "pageup", n: number): Promise<void> {
  for (let i = 0; i < n; i++) await app.keyboard.press(key);
}

test("a long chat scrolled down and back up splits no message and detects no code language again on the way back", async () => {
  const app = await opened();
  await app.keyboard.press("home");
  await app.waitUntil(() => !app.texts().includes("At end: yes"));
  await pages(app, "pagedown", 20);
  await read(app);
  await reset(app);
  await pages(app, "pageup", 20);
  const back = await read(app);
  expect(back.offset).toBe(0);
  // Every row on the way back was shown on the way down: its Markdown parts and its blocks' languages are kept.
  expect(back["md.split"] ?? 0).toBe(0);
  expect(back["code.describe"] ?? 0).toBe(0);
  expect(back["row.bind"]).toBeGreaterThan(20);
}, 120_000);

test("rows scrolled into view for the first time do not rise in: only what arrives at the end does", async () => {
  const app = await opened();
  await reset(app);
  await pages(app, "pageup", 12);
  const up = await read(app);
  expect(up["row.bind"]).toBeGreaterThan(10);
  expect(up["row.rise"] ?? 0).toBe(0);
}, 120_000);

test("the content hardly grows as its rows are measured: the estimate follows the conversation's rows", async () => {
  const app = await opened();
  const before = await read(app);
  await app.keyboard.press("home");
  await app.waitUntil(() => !app.texts().includes("At end: yes"));
  await pages(app, "pagedown", 20);
  const after = await read(app);
  // At 72 pt a row it grew by a third over the same pages (133,518 to 149,745 pt on 420 turns).
  expect(Math.abs(after.content - before.content) / before.content).toBeLessThan(0.05);
}, 120_000);

test("page keys pressed faster than the list moves land a page apart each, from the top and back to it", async () => {
  const app = await opened();
  await app.keyboard.press("home");
  await app.waitUntil(() => !app.texts().includes("At end: yes"));
  const top = await read(app);
  expect(top.offset).toBe(0);
  await app.keyboard.press("pagedown");
  await app.keyboard.press("pagedown");
  await app.keyboard.press("pagedown");
  const down = await read(app);
  expect(Math.abs(down.offset - 3 * 0.9 * top.size)).toBeLessThan(1);
  await app.keyboard.press("pageup");
  await app.keyboard.press("pageup");
  await app.keyboard.press("pageup");
  const back = await read(app);
  expect(back.offset).toBeLessThan(1);
}, 120_000);
