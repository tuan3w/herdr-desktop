// Screenshots of the real GTK window for the definition of done (1280, 960, 760 px; light and dark), against the
// scripted herdr, written to `.scratch/shots/`. Hidden directory: `nsh test` skips it. Run with `make shots`
// (SHOT_ONLY=<scenario> limits it).
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const SIZES = [1280, 960, 760] as const;
const only = process.env.SHOT_ONLY;

/** Each scenario is a state of the app worth looking at; `steps` brings the window to it. */
const SCENARIOS: Record<string, { fixture: string; steps: (app: App) => Promise<void> }> = {
  board: { fixture: "mixed", steps: async () => {} },
  storm: { fixture: "storm", steps: async () => {} },
  empty: { fixture: "empty", steps: async () => {} },
  pane: {
    fixture: "mixed",
    steps: async (app) => {
      await app.press("text:payments review");
      await app.wait(800);
    },
  },
  working: {
    fixture: "mixed",
    steps: async (app) => {
      await app.press("text:Refactor ledger");
      await app.wait(800);
    },
  },
  palette: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+k"); await app.wait(400); } },
  settings: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+,"); await app.wait(400); } },
  shortcuts: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("F1"); await app.wait(400); } },
};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  for (const scheme of ["light", "dark"] as const) {
    for (const width of SIZES) {
      test(`${name} ${scheme} ${width}`, async () => {
        const app = await open("../App.tsx", { width, height: 800, platform: "linux", host: { params: { fixture: scenario.fixture } } });
        await app.setColorScheme(scheme);
        await app.wait(600);
        await scenario.steps(app);
        await app.screenshot(`.scratch/shots/${name}-${scheme}-${width}.png`);
      });
    }
  }
}
