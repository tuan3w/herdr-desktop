// Scenarios for the Changes tab (`components/changes.tsx`), run by `bun scripts/perf.mjs .perf/changes.test.tsx` (same markers as
// `scenarios.test.tsx`; a window per repository: `changes-lab-app.tsx` in the repository root, because an entry finds its fonts only
// under its own directory). Hidden directory: `nsh test` skips it (it needs a window).
import { open, test } from "nsh/test";

const TEST_TIMEOUT = 300_000;
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
/**
 * What opening a big change may take from the press to its lines drawn. The product target is 300 ms; this run is unoptimized
 * Rust (the highlighter is most of it) with CPU-drawn frames, where 330 to 360 ms was measured, so the guard is twice that and a
 * release figure is still to be taken on a real display (docs/PERFORMANCE.md).
 */
const OPEN_BUDGET_MS = 700;

function mark(name: string) {
  console.log(`PERF-SCENARIO ${name}`);
}

const lab = (params: Record<string, unknown>) => open("../changes-lab-app.tsx", { ...DESKTOP, host: { params } });

test(
  "changes scenarios",
  async () => {
    mark("changes, 500 files scrolled");
    const many = await lab({ kind: "many" });
    await many.waitFor("label:Changed files", { timeout: 20000 });
    await many.wait(1000);
    /** The highest module number a row of the list shows: it moves only when the list really scrolled. */
    const reached = () =>
      Math.max(-1, ...many.texts().flatMap((t) => (/^module\d+\.ts$/.test(t) ? [Number(t.slice(6, -3))] : [])));
    const seen: string[] = [];
    for (let i = 0; i < 24; i++) {
      await many.scroll("label:Changed files", i % 6 === 5 ? -2500 : 1200);
      await many.wait(100);
      seen.push(String(reached()));
    }
    if (new Set(seen).size < 5) throw new Error(`the list did not scroll: ${seen.join(", ")}`);
    console.log(`PERF-NOTE changes many: highest module shown after each scroll: ${seen.join(", ")}`);

    mark("changes, a 5000-line change opened");
    const big = await lab({ kind: "big" });
    await big.waitFor("label:Changed files", { timeout: 20000 });
    await big.wait(1500);
    // `big.ts` is first and selected; `j` shows the small file, `k` brings the big one back: press to its diff drawn.
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await big.keyboard.press("j");
      await big.waitFor("label:/^Diff of src\\/small\\.ts/");
      await big.wait(400);
      const from = Date.now();
      await big.keyboard.press("k");
      await big.waitFor("label:/^Diff of src\\/big\\.ts/");
      times.push(Date.now() - from);
      await big.wait(400);
    }
    console.log(
      `PERF-NOTE changes big: press to diff drawn, ms: ${times.join(", ")} (guard ${OPEN_BUDGET_MS}, target 300 in a release build)`,
    );
    if (Math.min(...times) > OPEN_BUDGET_MS) throw new Error(`a big change took ${times.join(", ")} ms to open`);

    mark("changes at rest");
    await big.wait(4000);

    mark("end");
  },
  TEST_TIMEOUT,
);
