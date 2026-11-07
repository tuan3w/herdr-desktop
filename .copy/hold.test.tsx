// One window per scenario, held open for `scripts/copy_probe.py` (real X pointer and key events through XTEST, the clipboard
// read back from the X server). Hidden directory: `nsh test` skips it. The script runs it once per scenario with
// `--filter "copy[<name>]"` and ends the run it started.
import { open, test } from "nsh/test";

import { SCENARIOS } from "../.shots/scenarios";

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`copy[${name}]`, async () => {
    const app = await open(scenario.entry ?? "../App.tsx", {
      width: 1280,
      height: 800,
      platform: "linux",
      host: { params: { fixture: scenario.fixture, ...scenario.params } },
    });
    await app.wait(500);
    await scenario.steps(app);
    // The Wayland probe starts when it reads this line; a window it cannot photograph is photographed here.
    console.log("COPY-READY");
    await app.wait(6000);
    await app.screenshot(`.scratch/copy/hold-${name}.png`);
    await app.wait(104000);
    await scenario.cleanup?.(app);
  }, 120000);
}
