import { Compose, Files, Git } from "herdr-desktop/native";
import { signal } from "nsh";

import type { MentionsView } from "herdr-desktop/native";

import { remembered } from "#lib/pane-memory";

/**
 * What the `@` list is asked, and what it remembers. The ranking, the folders and the typo rule are Rust's
 * (`Compose.mentions`); this file adds what only the screen knows: the files the person mentioned lately (kept in the
 * settings file, per project) and the files git says changed (read once in a while, never on a keystroke).
 */

/** Rows the list shows: it is a list to pick from, not a file browser. */
export const MENTION_ROWS = 8;

/** Files remembered per project, and projects remembered. */
export const RECENT_FILES = 12;
export const RECENT_PROJECTS = 20;

/** `machine` and the project's folder, one key. */
const keyOf = (machine: string, root: string): string => `${machine}\n${root}`;

/** Project key to paths relative to it, newest first. */
export type RecentMap = Record<string, string[]>;

/** The map a settings file holds; anything unreadable is empty. */
export function parseRecents(json: unknown): RecentMap {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const out: RecentMap = {};
  for (const [key, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue;
    const paths = list.filter((p): p is string => typeof p === "string" && p !== "").slice(0, RECENT_FILES);
    if (paths.length > 0) out[key] = paths;
  }
  return out;
}

/** `map` after `rel` was used in a project: first in its list, the least recently used project dropped past the bound. */
export function touch(map: RecentMap, key: string, rel: string): RecentMap {
  const list = [rel, ...(map[key] ?? []).filter((p) => p !== rel)].slice(0, RECENT_FILES);
  const next: RecentMap = { ...map };
  delete next[key];
  next[key] = list;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - RECENT_PROJECTS))) delete next[old];
  return next;
}

const recents = remembered<RecentMap>("mentions.v1", parseRecents, () => ({}));

/** The files mentioned lately in a project, newest first. Reactive. */
export const recentFiles = (machine: string, root: string): string[] => recents.get()[keyOf(machine, root)] ?? [];

/** Notes that `rel` (relative to `root`) was mentioned or attached. */
export function noteMentioned(machine: string, root: string, rel: string): void {
  recents.set(touch(recents.get(), keyOf(machine, root), rel));
}

/** How long a read of git's changed files is trusted: a person does not change files between two `@`. */
export const CHANGED_FRESH_MS = 5000;

const changed = new Map<string, { at: number; paths: string[]; reading: boolean }>();
/** Moves when a read of git's changed files finished with another answer: the list asks again. */
export const changedTick = signal(0);

/** The changed files as git last said them (relative to `root`, `/` separated), whatever their age. */
export function changedPaths(machine: string, root: string): string[] {
  return changed.get(keyOf(machine, root))?.paths ?? [];
}

/**
 * Reads the files git says changed under `root` unless the last read is younger than `CHANGED_FRESH_MS`; none when it is
 * not a checkout or git cannot say. It never makes the `@` list wait: the list shows what was known and asks again when
 * this finishes (`changedTick`).
 */
export async function readChanged(machine: string, root: string, now: number = Date.now()): Promise<void> {
  const key = keyOf(machine, root);
  const known = changed.get(key);
  if (known && (known.reading || now - known.at < CHANGED_FRESH_MS)) return;
  changed.set(key, { at: known?.at ?? 0, paths: known?.paths ?? [], reading: true });
  let paths: string[] = [];
  try {
    const status = await Git.status(machine, root);
    if (!status.problem) {
      const base = root.replace(/\/+$/, "");
      paths = status.files
        .map((f) => `${status.root.replace(/\/+$/, "")}/${f.path}`)
        .filter((abs) => abs.startsWith(`${base}/`))
        .map((abs) => abs.slice(base.length + 1));
    }
  } catch {
    // Git is a convenience here: a list without the changed files is still a list.
  }
  const before = changed.get(key)?.paths ?? [];
  changed.set(key, { at: Date.now(), paths, reading: false });
  if (before.join("\n") !== paths.join("\n")) changedTick.update((n) => n + 1);
}

/** Walks the project's files ahead of the first `@`, so the list does not wait for the walk, and reads git. */
export function warmMentions(machine: string, root: string): void {
  void Files.warm(machine, root).catch(() => undefined);
  void readChanged(machine, root);
}

/** What `@query` can mean in a project: files and folders, the hot ones first. */
export function searchMentions(machine: string, root: string, query: string): Promise<MentionsView> {
  return Compose.mentions(machine, root, query, MENTION_ROWS, recentFiles(machine, root), changedPaths(machine, root));
}
