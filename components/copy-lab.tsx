import "#components/pane-lab";

import { Herdr } from "herdr-desktop/native";

/**
 * The entry of the copy probe's `copy-stream` scene (`scripts/copy_probe.py`): the pane lab plus a driver that rewrites the
 * last rows of the scripted pane twice a second, as an agent working does, so a selection made in the rows above can be
 * seen to survive the output. Not part of the app.
 */
const PANE = "w1:p4";
const STATIC = Array.from(
  { length: 12 },
  (_, i) => `row ${String(i).padStart(2, "0")} stays where it is: alpha beta gamma`,
);
let tick = 0;
setInterval(() => {
  tick += 1;
  Herdr.testSetScreen(PANE, [...STATIC, `progress ${tick} ${"#".repeat(tick % 20)}`, `Working ${tick}s`]);
  Herdr.testPush({ event: "pane_output_changed", data: { pane_id: PANE } });
}, 400);
