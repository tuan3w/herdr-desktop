import "./App";

import { Herdr } from "herdr-desktop/native";
// The entry of window 1 of `scenarios.test.tsx`: the whole app (`../App.tsx` mounts itself) plus a driver for what a test
// file cannot do under `nsh test --target linux`: that file runs apart from the host and cannot reach the native module,
// so the scripted herdr is changed from here, on a key press. Keys are `ctrl+alt+<digit>` (the app's own shortcuts never
// use alt, `lib/shortcuts.ts`), so pressing one changes nothing on screen. The driver's work is on the app's JS thread
// and so inside the figures; it logs what it cost (`PERF-NOTE driver`). Not part of the app.
import { keymap } from "nsh";

import big from "./fixtures/herdr/big.json";
import storm from "./fixtures/herdr/storm.json";

/** The eight panes of `mixed.json` that are not waiting on a question. */
const STREAMING = ["w1:p2", "w1:p3", "w1:p4", "w1:p5", "w2:p1", "w2:p2", "w2:p3", "w2:p4"];
/** The pane that shows its scrollback in the scrollback scenario. */
const HISTORY_PANE = "w1:p4";

/** The synthetic screen a streaming pane shows at tick `tick`: 48 log rows that scroll once a second, a progress bar and a spinner that change every tick. */
function frame(pane: string, tick: number): string[] {
  const second = Math.floor(tick / 20);
  const worker = pane.length + (pane.charCodeAt(pane.length - 1) % 7);
  const rows: string[] = [];
  for (let r = 0; r < 48; r++) {
    const n = second + r;
    const time = `12:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    const text = `worker-${worker} batch ${n * 17} ok in ${(n * 7) % 90} ms`;
    const plain = `${time} INFO  ${text}`;
    rows.push(
      `\u001b[90m${time}\u001b[0m \u001b[32mINFO\u001b[0m  ${text}${" ".repeat(Math.max(0, 100 - plain.length))}`,
    );
  }
  const done = tick % 20;
  rows.push(`\u001b[36m[${"█".repeat(done)}${"░".repeat(20 - done)}]\u001b[0m ${done * 5}%${" ".repeat(70)}`);
  rows.push(`\u001b[33m${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[tick % 10]}\u001b[0m Working (${second}s · ${tick} frames · esc to interrupt)`);
  return rows;
}

/** 1000 rows of scrollback with a few different lengths. */
const history = (): string[] =>
  Array.from(
    { length: 1000 },
    (_, i) =>
      `\u001b[90m${String(i).padStart(4, "0")}\u001b[0m  scrollback row ${i}: \u001b[32mok\u001b[0m ${"abcdef ".repeat((i % 9) + 1)}`,
  );

/** Updates the eight streaming panes 20 times a second for ten seconds. */
function stream() {
  const start = performance.now();
  let tick = 0;
  let spent = 0;
  const timer = setInterval(() => {
    const began = performance.now();
    for (const pane of STREAMING) {
      Herdr.testSetScreen(pane, frame(pane, tick));
      Herdr.testPush({ event: "pane_output_changed", data: { pane_id: pane } });
    }
    spent += performance.now() - began;
    if (++tick === 200) {
      clearInterval(timer);
      const wall = performance.now() - start;
      console.log(
        `PERF-NOTE driver: ${STREAMING.length} panes, 200 ticks in ${wall.toFixed(0)} ms (${((200 * 1000) / wall).toFixed(1)} Hz), ${(spent / 200).toFixed(2)} ms per tick spent in the driver`,
      );
    }
  }, 50);
}

/** Makes the scripted herdr show `fixture` from now on: its snapshot and the rows of every pane. */
function show(fixture: typeof storm | typeof big) {
  Herdr.testSetSnapshot(fixture.snapshot);
  for (const [pane, spec] of Object.entries(fixture.panes)) Herdr.testSetScreen(pane, spec.screen);
  Herdr.testPush({ event: "workspace_updated", data: {} });
}

/**
 * Makes the scripted herdr show about `agents` agents: the 200 of `big.json` again and again, each copy with ids and labels
 * of its own, so the palette has a crowd to search (one agent is a candidate, and so are its project and its commands).
 * The panes' screens are not set: the point is the size of the list the palette ranks.
 */
function crowd(agents: number) {
  const text = JSON.stringify(big.snapshot);
  const copies = Array.from({ length: Math.ceil(agents / big.snapshot.agents.length) }, (_, j) =>
    JSON.parse(
      j === 0
        ? text
        : text
            .replace(/"(t?w\d+)((?::t\d+)?(?::p\d+)?)"/g, `"$1c${j}$2"`)
            .replace(/"label":"([^"]*)"/g, `"label":"$1 ${j}"`),
    ),
  ) as (typeof big.snapshot)[];
  const [first] = copies;
  Herdr.testSetSnapshot({
    ...first,
    workspaces: copies.flatMap((c) => c.workspaces),
    tabs: copies.flatMap((c) => c.tabs),
    panes: copies.flatMap((c) => c.panes),
    layouts: copies.flatMap((c) => c.layouts),
    agents: copies.flatMap((c) => c.agents),
  });
  Herdr.testPush({ event: "workspace_updated", data: {} });
}

keymap.bind({
  // A crowd for the palette to search: about 2,000 and about 5,000 candidates (an agent, plus its project and the commands).
  "ctrl+alt+5": () => crowd(1900),
  "ctrl+alt+6": () => crowd(4900),
  "ctrl+alt+0": () => {
    for (const pane of STREAMING) Herdr.testSetScreen(pane, frame(pane, 0));
  },
  "ctrl+alt+1": () => stream(),
  "ctrl+alt+2": () => {
    Herdr.testSetScreen(HISTORY_PANE, history());
    Herdr.testPush({ event: "pane_output_changed", data: { pane_id: HISTORY_PANE } });
  },
  "ctrl+alt+3": () => show(storm),
  "ctrl+alt+4": () => show(big),
  // How many `pane.read` each pane was asked for since the window opened: only the panes with an open view are read.
  "ctrl+alt+r": () => {
    const counts: Record<string, number> = {};
    for (const request of Herdr.testRequests("pane.read")) {
      const pane = (request.params as { pane_id?: string }).pane_id ?? "?";
      counts[pane] = (counts[pane] ?? 0) + 1;
    }
    console.log(`PERF-NOTE pane.read requests by pane: ${JSON.stringify(counts)}`);
  },
  // The read rate while the stream still runs (`PERF-METRICS`, at the end of the scenario, looks back over five quiet seconds too).
  "ctrl+alt+l": () => console.log(`PERF-LIVE ${JSON.stringify(Herdr.metrics())}`),
  "ctrl+alt+m": () => console.log(`PERF-METRICS ${JSON.stringify(Herdr.metrics())}`),
});
