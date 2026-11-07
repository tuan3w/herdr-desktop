import { effect, signal, untracked } from "nsh";

/**
 * Developer metrics: what the dev panel (`components/dev-panel.tsx`, `GLOBAL.devPanel` in `lib/shortcuts.ts`) shows. nsh's own monitor (`--fps`) measures the
 * frame, CPU, GPU and memory; JS cannot read those. This file is for what only the app knows (data size, storage use,
 * time to save) plus the JS thread's own frame rate and lag. Nothing runs while the panel is closed except `timing`
 * recording, which is two clock reads per measured call.
 *
 * To add a metric: `registerMetric({ id, label, read })` where it lives, or `timing(id, label).time(() => work())`.
 */

/** Samples a rolling window keeps: five seconds at 60 fps. */
const WINDOW = 300;

/** The `p` quantile (0 to 1) of `samples`; 0 when there are none. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** The last `size` samples; a new one past that drops the oldest. */
export class Rolling {
  private items: number[] = [];

  constructor(private readonly size = WINDOW) {}

  push(value: number): void {
    this.items.push(value);
    if (this.items.length > this.size) this.items.shift();
  }

  clear(): void {
    this.items = [];
  }

  get count(): number {
    return this.items.length;
  }

  get last(): number {
    return this.items.length ? this.items[this.items.length - 1] : 0;
  }

  get max(): number {
    return this.items.reduce((m, v) => Math.max(m, v), 0);
  }

  p(quantile: number): number {
    return percentile(this.items, quantile);
  }
}

/** How a reading stands against its budget: the panel colors it. */
export type Health = "ok" | "warn" | "bad";

export interface Metric {
  id: string;
  /** Short, in English: a developer reads it. */
  label: string;
  /** The reading as short text, one line of a narrow panel (about 22 characters). Called twice a second while it is open: keep it cheap. */
  read: () => string;
  /** A few characters for the collapsed panel (`60 fps`). Omitted: the metric is not in the summary. */
  brief?: () => string;
  /** Against the metric's budget. Omitted: always ok. */
  health?: () => Health;
}

export interface Reading {
  id: string;
  label: string;
  text: string;
  brief?: string;
  health: Health;
}

const registry = new Map<string, Metric>();

/** Adds a metric to the panel (replacing one with the same `id`). Returns what removes it. */
export function registerMetric(metric: Metric): () => void {
  registry.set(metric.id, metric);
  return () => {
    if (registry.get(metric.id) === metric) registry.delete(metric.id);
  };
}

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/**
 * A metric of how long something takes, in milliseconds: shows the last run, the 95th percentile and the worst of the
 * last 300. `budget` colors it: over `warn` ms at the 95th percentile is amber, over `bad` red.
 */
export function timing(id: string, label: string, budget?: { warn: number; bad: number }) {
  const samples = new Rolling();
  let runs = 0;
  registerMetric({
    id,
    label,
    read: () => (samples.count === 0 ? "-" : `${ms(samples.last)} ms · p95 ${ms(samples.p(0.95))} · ×${runs}`),
    health: () =>
      !budget || samples.count === 0
        ? "ok"
        : samples.p(0.95) > budget.bad
          ? "bad"
          : samples.p(0.95) > budget.warn
            ? "warn"
            : "ok",
  });
  const record = (millis: number) => {
    samples.push(millis);
    runs++;
  };
  return {
    record,
    /** Runs `work`, records how long it took (also when it throws), returns its result. */
    time<T>(work: () => T): T {
      const start = performance.now();
      try {
        return work();
      } finally {
        record(performance.now() - start);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// the panel's state and the JS thread's own meters

/** Whether the dev panel shows. Session only: not a setting. */
export const perfOpen = signal(false);
/** What the panel shows, refreshed twice a second while it is open. */
export const perfReadings = signal<Reading[]>([]);
/** The panel as one line (a summary and the open button). Session only. */
export const perfCollapsed = signal(false);

/** The gap between two frames the JS thread saw, p95, in ms: over `warn` is below 50 fps, over `bad` below 30. */
const FRAME_BUDGET = { warn: 20, bad: 33 };
/** How late a 100 ms timer fires, p95, in ms: the JS thread was busy that long. */
const LAG_BUDGET = { warn: 16, bad: 50 };

const frameGaps = new Rolling();
const lags = new Rolling();
let fps = 0;

const level = (value: number, budget: { warn: number; bad: number }): Health =>
  value > budget.bad ? "bad" : value > budget.warn ? "warn" : "ok";

registerMetric({
  id: "frames",
  label: "FPS",
  read: () => (frameGaps.count === 0 ? "-" : `${fps.toFixed(0)} · p95 gap ${ms(frameGaps.p(0.95))} ms`),
  brief: () => (frameGaps.count === 0 ? "-" : `${fps.toFixed(0)} fps`),
  health: () => (frameGaps.count === 0 ? "ok" : level(frameGaps.p(0.95), FRAME_BUDGET)),
});
registerMetric({
  id: "lag",
  label: "JS lag",
  read: () => (lags.count === 0 ? "-" : `p95 ${ms(lags.p(0.95))} ms · max ${ms(lags.max)}`),
  brief: () => (lags.count === 0 ? "-" : `lag ${ms(lags.p(0.95))} ms`),
  health: () => (lags.count === 0 ? "ok" : level(lags.p(0.95), LAG_BUDGET)),
});

/** The registered metrics, read now. */
export function readMetrics(): Reading[] {
  return [...registry.values()].map((m) => ({
    id: m.id,
    label: m.label,
    text: m.read(),
    brief: m.brief?.(),
    health: m.health?.() ?? "ok",
  }));
}

function refresh(): void {
  perfReadings.set(readMetrics());
}

/** Measures frames and lag, and refreshes the readings, until the returned function stops it. */
function sample(): () => void {
  frameGaps.clear();
  lags.clear();
  fps = 0;
  let frames = 0;
  let windowStart = performance.now();
  let lastFrame = windowStart;
  let lastLag = windowStart;
  let raf: number | undefined;
  const onFrame = () => {
    const now = performance.now();
    frameGaps.push(now - lastFrame);
    lastFrame = now;
    frames++;
    raf = requestAnimationFrame(onFrame);
  };
  raf = requestAnimationFrame(onFrame);
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - lastLag - 100));
    lastLag = now;
  }, 100);
  const readout = setInterval(() => {
    const now = performance.now();
    fps = (frames * 1000) / (now - windowStart);
    frames = 0;
    windowStart = now;
    refresh();
  }, 500);
  refresh();
  return () => {
    cancelAnimationFrame(raf);
    clearInterval(lagTimer);
    clearInterval(readout);
  };
}

effect(() => {
  if (!perfOpen()) return;
  return untracked(sample);
});
