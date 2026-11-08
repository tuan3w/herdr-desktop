// The cost of scrolling a long chat (`components/long-chat-lab.tsx`: 420 synthetic turns), by phase: open, Home, 30 pages
// down, 30 pages up, 120 wheel steps. Each phase logs `COUNTS <phase> {...}` (what the rows did, `lib/perf-counts.ts`, and
// where the list is). Hidden directory: `nsh test` skips it. Run it headless with the trace and read the commits per step:
//   HERDR_DESKTOP_TEST=1 nsh test .perf/long-chat.test.tsx --trace > .scratch/lc.txt; node .perf/long-chat-trace.mjs .scratch/lc.txt
// or in a Mac window with the monitor: scripts/nsh-test-mac.sh .perf/long-chat.test.tsx --fps -v (docs/PERFORMANCE.md).
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

const lab = () => open("../components/long-chat-lab.tsx", { ...DESKTOP, host: { params: {} } });

async function readCounts(app: App): Promise<Record<string, number>> {
  await app.keyboard.press("ctrl+alt+r");
  let line = "";
  await app.waitUntil(() => {
    line = app.texts().find((t) => t.startsWith("Counts: {")) ?? "";
    return line !== "";
  });
  return JSON.parse(line.slice("Counts: ".length)) as Record<string, number>;
}

async function reset(app: App): Promise<void> {
  await app.keyboard.press("ctrl+alt+0");
  await app.waitUntil(() => app.texts().includes("Counts: "));
}

const atEnd = (app: App) => app.texts().includes("At end: yes");

/** Presses `key` `n` times, each after the list has had a moment to bind and measure what it shows. */
async function keys(app: App, key: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await app.keyboard.press(key);
    await app.wait(30);
  }
}

test("measure: page down through a long chat and back up", async () => {
  const app = await lab();
  await app.waitUntil(() => app.texts().some((t) => /^Rows: [1-9]/.test(t)));
  await app.waitUntil(() => atEnd(app));
  await app.wait(300);
  const opened = await readCounts(app);
  console.log(`COUNTS open ${JSON.stringify(opened)}`);

  await reset(app);
  await app.keyboard.press("home");
  await app.waitUntil(() => !atEnd(app));
  await app.wait(300);
  const home = await readCounts(app);
  console.log(`COUNTS home ${JSON.stringify(home)}`);

  await reset(app);
  const t0 = Date.now();
  const down = 30;
  await keys(app, "pagedown", down);
  const downMs = Date.now() - t0;
  const pageDown = await readCounts(app);
  console.log(`COUNTS down ${down} pages ${downMs}ms ${JSON.stringify(pageDown)}`);

  await reset(app);
  const t1 = Date.now();
  await keys(app, "pageup", down);
  const upMs = Date.now() - t1;
  const pageUp = await readCounts(app);
  console.log(`COUNTS up ${down} pages ${upMs}ms ${JSON.stringify(pageUp)}`);

  await reset(app);
  const t2 = Date.now();
  for (let i = 0; i < 120; i++) await app.scroll("label:Conversation", 120);
  const wheelMs = Date.now() - t2;
  const wheel = await readCounts(app);
  console.log(`COUNTS wheel 120x120 ${wheelMs}ms ${JSON.stringify(wheel)}`);
  expect(down).toBeGreaterThan(10);
}, 600_000);
