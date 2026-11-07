// One window per scenario, kept open long enough for `scripts/atspi_audit.py` to read its accessibility tree over
// AT-SPI. Hidden directory: `nsh test` skips it. The script runs it once per scenario with `--filter "audit <name>"`.
import { open, test } from "nsh/test";

import { SCENARIOS } from "../.shots/scenarios";

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`audit ${name}`, async () => {
    const app = await open(scenario.entry ?? "../App.tsx", {
      width: 1280,
      height: 800,
      platform: "linux",
      host: { params: { fixture: scenario.fixture, ...scenario.params } },
    });
    await app.wait(500);
    await scenario.steps(app);
    // The auditor reads the tree and presses Tab during this wait, then ends the run. With `--keep` the run goes on and
    // the window is photographed after the Tab walk, to see where the focus went.
    await app.wait(14000);
    await app.screenshot(`.scratch/a11y/${name}.png`);
    await scenario.cleanup?.(app);
    await app.wait(16000);
  });
}
