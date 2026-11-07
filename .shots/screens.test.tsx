// Screenshots of the real GTK window for the definition of done (1280, 960, 760 px; light and dark), against the
// scripted herdr, written to `.scratch/shots/`. Hidden directory: `nsh test` skips it. Run with `make shots`; limit
// it with `--filter "<scenario> <scheme> <width>"`.
import { open, test } from "nsh/test";

import { SCENARIOS } from "./scenarios";

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 960, 760] as const) {
      test(`${name} ${scheme} ${width}`, async () => {
        const app = await open(scenario.entry ?? "../App.tsx", {
          width,
          height: 800,
          platform: "linux",
          host: { params: { fixture: scenario.fixture, ...scenario.params } },
        });
        await app.setColorScheme(scheme);
        await app.wait(600);
        await scenario.steps(app);
        await app.screenshot(`.scratch/shots/${name}-${scheme}-${width}.png`);
        await scenario.cleanup?.(app);
      });
    }
  }
}
