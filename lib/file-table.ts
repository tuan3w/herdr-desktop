import type { EntryView } from "herdr-desktop/native";
import type { DataTableSort } from "nsh/base";

import { fold } from "#lib/text";

/**
 * The rules of the Files tab's table that are not drawing: the order of a folder, the breadcrumb and where it collapses,
 * the widths of the columns and the one line under the list. Pure, so a table of cases tests them (`file-table.test.ts`).
 */

export type FileSortKey = "name" | "size" | "modified";
export interface FileSort {
  key: FileSortKey;
  direction: "ascending" | "descending";
}
export const DEFAULT_SORT: FileSort = { key: "name", direction: "ascending" };

/**
 * Widths in points. The name takes what is left and is never narrower than `name`; the size and modified columns are
 * fixed, so their digits start at the same x in every row whatever the names are. `actions` holds the row's `…`.
 */
export const FILE_COLUMN = { name: 220, size: 88, modified: 120, actions: 40 } as const;

/** The sort a press on a column title asks for. The table cycles ascending, descending, then none; none is the default order. */
export function sortOfPress(press: DataTableSort | null): FileSort {
  const key = press?.key;
  if (key !== "name" && key !== "size" && key !== "modified") return DEFAULT_SORT;
  return { key, direction: press?.direction === "descending" ? "descending" : "ascending" };
}

/** The order a column is chosen in from the options menu: name from A, size and date from the largest and newest, as a person who chose them is looking for those. */
export const firstSort = (key: FileSortKey): FileSort => ({
  key,
  direction: key === "name" ? "ascending" : "descending",
});

/** Digits compare as numbers (`file2` before `file10`); letters by their folded form, so case and accents do not decide. */
function natural(a: string, b: string): number {
  const [x, y] = [fold(a).split(/(\d+)/), fold(b).split(/(\d+)/)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (i % 2 === 1) return Number(x[i]) - Number(y[i]) || (x[i] < y[i] ? -1 : 1);
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * The rows to show: dotfiles only when asked, folders first whatever the sort, then by `sort`. Names with the same
 * letters in different case keep a fixed order (the exact name decides), so a list never reshuffles between two reads.
 * Entries with no date (or a folder, for size) go last in either direction.
 */
export function arrange(entries: readonly EntryView[], options: { sort: FileSort; hidden: boolean }): EntryView[] {
  const { key, direction } = options.sort;
  const sign = direction === "ascending" ? 1 : -1;
  const byName = (a: EntryView, b: EntryView) =>
    natural(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const value = (e: EntryView): number | null =>
    key === "size" ? (e.kind === "file" ? e.size : null) : key === "modified" ? (e.modified ?? null) : null;
  return entries
    .filter((e) => options.hidden || !e.name.startsWith("."))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const folders = Number(b.e.kind === "dir") - Number(a.e.kind === "dir");
      if (folders !== 0) return folders;
      if (key !== "name") {
        const [x, y] = [value(a.e), value(b.e)];
        if (x === null || y === null) {
          if (x !== y) return x === null ? 1 : -1;
        } else if (x !== y) return (x - y) * sign;
      }
      const named = byName(a.e, b.e);
      return (key === "name" ? named * sign : named) || a.i - b.i;
    })
    .map((x) => x.e);
}

/** One step of the breadcrumb: its name and the path pressing it goes to. */
export interface Crumb {
  name: string;
  path: string;
}

/**
 * The path from its root, a crumb per folder: `/home/dev/app` is `/`, `home`, `dev`, `app`; `~/app` is `~`, `app`.
 * Doubled and trailing slashes change nothing; a name keeps its spaces and any characters.
 */
export function crumbsOf(path: string): Crumb[] {
  const home = path === "~" || path.startsWith("~/");
  const out: Crumb[] = [home ? { name: "~", path: "~" } : { name: "/", path: "/" }];
  let at = home ? "~" : "";
  for (const part of path.split("/").filter((p, i) => p !== "" && !(home && i === 0))) {
    at += `/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

/** What the breadcrumb draws: a folder, or the `…` that stands for the folders between the root and the ones kept. */
export type TrailItem = { kind: "crumb"; crumb: Crumb; current: boolean } | { kind: "gap"; hidden: Crumb[] };

/** The one muted line under the list: counts, then each limit in words. */
export function listingNote(listing: { shown: number; hidden: number; truncated: boolean; skipped: number }): string {
  return [
    `${listing.shown} ${listing.shown === 1 ? "item" : "items"}`,
    listing.hidden > 0 ? `${listing.hidden} hidden` : "",
    listing.truncated ? "Only the first 5000 entries are listed" : "",
    listing.skipped > 0 ? `${listing.skipped} names are not text and are not listed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
