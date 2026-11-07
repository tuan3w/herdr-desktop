// Scenarios for `scripts/perf.mjs` and `scripts/cpu.mjs`: one window, each scenario logs `PERF-SCENARIO <name>` where it
// starts and runs until the next marker; the last marker, `end`, closes the final row. Hidden directory: `nsh test`
// skips it (it needs a window and a display). Add a scenario by adding a step between two markers.
import { open, test } from "nsh/test";

const mark = (name: string) => console.log(`PERF-SCENARIO ${name}`);

test("scenarios", async () => {
  const app = await open("../App.tsx", { width: 1280, height: 800, platform: "linux", host: { params: { fixture: "mixed" } } });
  await app.wait(1500);

  mark("idle board");
  await app.wait(5000);

  mark("palette typing");
  await app.keyboard.press("ctrl+k");
  for (const ch of "settings") {
    await app.type("label:Search commands", ch);
    await app.wait(150);
  }
  await app.wait(2500);
  await app.keyboard.press("escape");
  await app.wait(500);

  mark("open a pane");
  await app.press("text:payments review >> nth=0");
  await app.wait(3000);

  mark("idle pane");
  await app.wait(5000);

  mark("end");
});
