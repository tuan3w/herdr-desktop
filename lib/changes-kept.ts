import type { ChangeView, StatusView } from "herdr-desktop/native";

/**
 * The rules for what a Changes tab shows again when it is opened for a checkout it showed before (`lib/changes-model.ts`
 * keeps the status and the diff by the tab's key): what is young enough to paint at once, and when a kept diff is still
 * the one the selection wants.
 */

/** A kept status older than this is not shown: what it says about the files has most likely moved on. */
const KEPT_STATUS_MS = 10 * 60 * 1000;

/** The status a tab opened at `now` starts from: the kept one while it is young enough, else none. */
export function keptStatus(saved: { status?: StatusView; statusAt?: number }, now: number): StatusView | null {
  return saved.status && saved.statusAt !== undefined && now - saved.statusAt <= KEPT_STATUS_MS ? saved.status : null;
}

/** The key a diff is read for: when it changes, the diff on screen is out of date. Empty when nothing is selected. */
export const wantedKey = (c: ChangeView | undefined, context: number, all: boolean, holding: boolean): string =>
  c ? `${c.path}|${c.fingerprint}|${context}|${all}|${holding}` : "";
