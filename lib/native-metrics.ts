import { Herdr } from "herdr-desktop/native";

import type { Metrics } from "herdr-desktop/native";

import { registerMetric } from "#lib/perf";

/**
 * The Rust side's figures in the developer panel (`components/dev-panel.tsx` imports this file): the live pane path
 * and the process. `docs/PERFORMANCE.md` says how each is measured. They carry no budget yet (`health` is omitted), so the
 * panel never colors them; budgets come from measured runs.
 */

/** One `Herdr.metrics()` call serves every line of one refresh: the panel reads each metric in the same instant. */
const SHARE_MS = 100;
let read: { at: number; value: Metrics } | undefined;

function current(): Metrics {
  const now = performance.now();
  if (!read || now - read.at > SHARE_MS) read = { at: now, value: Herdr.metrics() };
  return read.value;
}

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

registerMetric({
  id: "read-to-paint",
  label: "Read to paint",
  read: () => {
    const m = current();
    return m.readToPaintSamples === 0 ? "-" : `${ms(m.readToPaintMsP50)} · p95 ${ms(m.readToPaintMsP95)} ms`;
  },
});
registerMetric({ id: "pane-reads", label: "Pane reads", read: () => `${current().paneReadsPerSecond.toFixed(1)} /s` });
registerMetric({
  id: "parse",
  label: "Parse",
  read: () => {
    const m = current();
    return m.parseUsPerRow === 0 ? "-" : `${ms(m.parseUsPerRow)} µs/row · p95 ${ms(m.parseUsPerRowP95)}`;
  },
});
registerMetric({
  id: "rebound",
  label: "Rows rebound",
  read: () => {
    const m = current();
    return `${m.rowsReboundPerUpdate.toFixed(1)} /update · max ${m.rowsReboundLast}`;
  },
});
registerMetric({ id: "memory", label: "Memory", read: () => `${current().rssMb.toFixed(0)} MB` });
registerMetric({ id: "process", label: "Threads · fds", read: () => `${current().threads} · ${current().openFds}` });
