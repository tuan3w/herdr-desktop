// Scenarios for the code renderer (`components/code-block.tsx`, `diff-block.tsx`), run by `bun scripts/perf.mjs .perf/code.test.tsx`
// (same markers as `scenarios.test.tsx`; a window per lab part: `code-lab-app.tsx` in the repository root, because an entry finds
// its fonts only under its own directory). Hidden directory: `nsh test` skips it (it needs a window).
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const TEST_TIMEOUT = 300_000;
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

let running = false;
/** Ends the scenario that ran and starts `name` (this file has no app-level metrics to log in between). */
function mark(name: string) {
  console.log(`PERF-SCENARIO ${name}`);
  running = name !== "end";
}

const lab = (params: Record<string, unknown>) => open("../code-lab-app.tsx", { ...DESKTOP, host: { params } });

/** The highest line number the list has mounted, from the gutter: what shows the list really scrolled (rows are mounted ahead of the view and the headless list keeps them). */
const reached = (app: App) => {
  const numbers = app.texts().filter((t) => /^\d+$/.test(t)).map(Number);
  return numbers.length ? Math.max(...numbers) : -1;
};

test("code scenarios", async () => {
  mark("code block 3000 lines, scrolled");
  const long = await lab({ part: "long", lines: 3000, numbers: true });
  await long.wait(1500);
  const seen: number[] = [reached(long)];
  for (let i = 0; i < 24; i++) {
    await long.scroll("label:/^Code, Rust, \\d+ lines$/", i % 6 === 5 ? -1500 : 900);
    await long.wait(120);
    seen.push(reached(long));
  }
  console.log(`PERF-NOTE code long: highest line mounted after each scroll: ${seen.join(", ")}`);
  if (new Set(seen).size < 5) throw new Error(`the block did not scroll: ${seen.join(", ")}`);

  mark("code block at rest");
  await long.wait(4000);

  mark("code block streaming, 20 updates a second");
  const stream = await lab({ part: "stream", lang: "ts", chunk: 60 });
  await stream.wait(3500);

  mark("diff, side by side");
  const diff = await lab({ part: "diff", layout: "split" });
  await diff.wait(1500);
  await diff.press("label:Show 7 unchanged lines");
  for (let i = 0; i < 6; i++) {
    await diff.press("Next change");
    await diff.wait(200);
  }

  mark("end");
}, TEST_TIMEOUT);
