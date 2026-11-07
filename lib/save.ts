import { signal, Storage } from "nsh";
import { registerMetric, timing } from "#lib/perf";

/** The keys whose last write failed. The storage quota is shared, so one full key can fail others. */
const failing = signal<ReadonlySet<string>>(new Set());
/** Counts every failed write: a screen that warns reacts to each one, not only to the first. */
export const saveFailures = signal(0);

/** True while the newest change exists only in memory: the last write of some key failed (storage full). */
export const saveFailed = () => failing().size > 0;

/** The storage's quota for every key together, in bytes (nsh: "exceed the quota of 5242880"). */
const QUOTA = 5 * 1024 * 1024;
/** Characters last written per key. UTF-8 is a few percent more for non-ASCII text, so the share shown is a little low. */
const written = new Map<string, number>();
const write = timing("write", "Save", { warn: 50, bad: 200 });

const stored = () => [...written.values()].reduce((sum, n) => sum + n, 0);

registerMetric({
  id: "storage",
  label: "Storage",
  read: () => `${(stored() / 1048576).toFixed(2)} / ${QUOTA / 1048576} MB · ${Math.round((stored() / QUOTA) * 100)}%`,
  health: () => (stored() / QUOTA > 0.9 ? "bad" : stored() / QUOTA > 0.7 ? "warn" : "ok"),
});

/** Writes `value` under `key` without waiting; a failure is recorded for `saveFailed` instead of vanishing in the console. */
export function save(key: string, value: string): void {
  written.set(key, value.length);
  const start = performance.now();
  Storage.setItem(key, value).then(
    () => {
      write.record(performance.now() - start);
      if (!failing().has(key)) return;
      const next = new Set(failing());
      next.delete(key);
      failing.set(next);
    },
    (e: unknown) => {
      console.error(`herdr-desktop: cannot save ${key}`, e);
      failing.set(new Set(failing()).add(key));
      saveFailures.update((n) => n + 1);
    },
  );
}
