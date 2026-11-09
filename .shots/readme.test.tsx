// The README's three pictures, each at one size and in one scheme, in the real GTK window: run by
// `scripts/readme-shots/build.sh`, which makes the synthetic data they need (without it the chats are not linked) and
// turns `.scratch/readme-shots/png/<scenario>.png` into `docs/screenshots/*.webp`. Hidden directory: `nsh test` skips it.
import { open, test } from "nsh/test";

import { SCENARIOS } from "./scenarios";

const SHOTS = { "readme-glance": "light", "readme-review": "light", "readme-night": "dark" } as const;

for (const [name, scheme] of Object.entries(SHOTS)) {
  test(name, async () => {
    const scenario = SCENARIOS[name];
    const app = await open(scenario.entry ?? "../App.tsx", {
      width: 1280,
      height: 800,
      platform: "linux",
      host: { params: { fixture: scenario.fixture, ...scenario.params } },
    });
    await app.setColorScheme(scheme);
    await app.wait(600);
    await scenario.steps(app);
    await app.screenshot(`.scratch/readme-shots/png/${name}.png`);
  });
}
