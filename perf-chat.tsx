import "#components/session-lab";

import { Herdr } from "herdr-desktop/native";
// The entry of window 2 of `scenarios.test.tsx`: the chat lab (a real keeper driving herdr-mobile's scripted ACP agent)
// plus `ctrl+alt+m`, which logs `Herdr.metrics()` (a test file cannot reach the native module under `--target linux`).
// Not part of the app.
import { keymap } from "nsh";

keymap.bind({ "ctrl+alt+m": () => console.log(`PERF-METRICS ${JSON.stringify(Herdr.metrics())}`) });
