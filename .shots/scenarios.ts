// The states of the app worth looking at, shared by the screenshots (`make shots`) and the AT-SPI audit (`make a11y`).
import type { App } from "nsh/test";

export interface Scenario {
  fixture: string;
  /** Brings the window to the state. */
  steps: (app: App) => Promise<void>;
}

const pressFirst = async (app: App, selector: string) => {
  await app.press(`${selector} >> nth=0`);
  await app.wait(800);
};

export const SCENARIOS: Record<string, Scenario> = {
  board: { fixture: "mixed", steps: async () => {} },
  storm: { fixture: "storm", steps: async () => {} },
  empty: { fixture: "empty", steps: async () => {} },
  pane: { fixture: "mixed", steps: (app) => pressFirst(app, "text:payments review") },
  working: { fixture: "mixed", steps: (app) => pressFirst(app, "text:Refactor ledger") },
  triage: { fixture: "mixed", steps: (app) => pressFirst(app, "text:Answer one by one") },
  palette: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+k"); await app.wait(400); } },
  settings: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+,"); await app.wait(400); } },
  shortcuts: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("F1"); await app.wait(400); } },
  "new-agent": { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+n"); await app.wait(400); } },
  machines: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+k");
      await app.wait(300);
      await app.type("label:Search commands", "Machines");
      await app.keyboard.press("enter");
      await app.wait(400);
    },
  },
};
