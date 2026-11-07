// The message box's costs through the real Rust module: `bun`-free, run with
//   nsh test .perf/composer.test.tsx
// after `python3` made `.scratch/perf/project20k` (20,000 empty files) and `.scratch/perf/noise.png` (a 4 MB picture nothing
// compresses; see `docs/PERFORMANCE.md`, "The message box"). It prints `COMPOSER-PERF` lines. Hidden directory: `nsh test` skips it.
import { open, test } from "nsh/test";

/** Where the project and the picture were made: `.scratch/perf` of this repository. */
const DATA = new URL("../.scratch/perf", import.meta.url).pathname;

test("composer costs", async () => {
  const app = await open("../components/composer-perf-lab.tsx", {
    width: 800,
    height: 600,
    platform: "linux",
    host: { params: { root: `${DATA}/project20k`, picture: `${DATA}/noise.png` } },
  });
  await app.waitFor("composer perf lab");
  await app.waitUntil(() => app.texts().includes("done"), { timeout: 160_000 });
}, 120_000);
