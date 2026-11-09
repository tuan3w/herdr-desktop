import type { FolderView } from "herdr-desktop/native";

/**
 * The folders the Files tab listed this run, so a folder visited again (or a tab opened again) shows its rows at once and
 * the machine's answer only corrects them. Memory only: the entries are file names, cheap to ask for again and not worth
 * a copy at rest. `at` is when the listing was read, in seconds, the same unit the tab's "N min ago" counts from.
 */
const MAX_FOLDERS = 64;

const folders = new Map<string, { view: FolderView; at: number }>();

const keyOf = (machine: string, path: string): string => `${machine}\0${path}`;

export const folderCache = {
  get(machine: string, path: string): { view: FolderView; at: number } | undefined {
    return folders.get(keyOf(machine, path));
  },
  /** Keeps `view`; a folder put again becomes the newest, and the oldest goes when there are more than 64. */
  put(machine: string, path: string, view: FolderView, at: number): void {
    const key = keyOf(machine, path);
    folders.delete(key);
    folders.set(key, { view, at });
    if (folders.size > MAX_FOLDERS) folders.delete(folders.keys().next().value as string);
  },
};

/** Whether two listings draw the same table: replacing one by the other would change nothing the person sees. */
export function sameListing(a: FolderView, b: FolderView): boolean {
  if (a.path !== b.path || a.truncated !== b.truncated || a.skipped !== b.skipped) return false;
  if (a.entries.length !== b.entries.length) return false;
  return a.entries.every((e, i) => {
    const o = b.entries[i];
    return (
      e.name === o.name &&
      e.kind === o.kind &&
      e.size === o.size &&
      (e.modified ?? null) === (o.modified ?? null) &&
      e.readable === o.readable &&
      e.link === o.link
    );
  });
}
