import { signal } from "nsh";

import type { ChangeView } from "herdr-desktop/native";
import type { Accessor, Signal } from "nsh";

import { changesKey } from "#lib/dock";

/**
 * Which files of a checkout a Changes tab opens on. A checkout's git status holds everything that differs from the last
 * commit, an agent's output folders included; the person who pressed `Edited 7 files` in a chat wants those seven. The chat
 * hands over the paths the agent's edit calls touched (`openChanges`), as the agent wrote them: absolute, or relative to
 * its folder. This file turns them into the files git reports. It keeps the paths per tab (in memory, like the notes).
 */

const sessions = new Map<string, Signal<readonly string[] | null>>();

const slot = (key: string): Signal<readonly string[] | null> => {
  let s = sessions.get(key);
  if (!s) {
    s = signal<readonly string[] | null>(null);
    sessions.set(key, s);
  }
  return s;
};

/** The paths of the session that opened the tab of `cwd`, `null` when it was opened from anywhere else. Reactive. */
export const sessionPaths = (machine: string, cwd: string): Accessor<readonly string[] | null> =>
  slot(changesKey(machine, cwd));

/** Records the files a session edited for the tab of `cwd` (`null` forgets them: the tab then shows everything). */
export function setSessionPaths(machine: string, cwd: string, paths: readonly string[] | null): void {
  slot(changesKey(machine, cwd)).set(paths && paths.length > 0 ? paths : null);
}

/** `path` without a leading `./` and without doubled or trailing slashes. */
const clean = (path: string): string =>
  path
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

/**
 * The files of `files` that the session's `paths` name. A path is matched as written when it is relative to the
 * repository, with a prefix taken off when it is absolute (`bases`: the repository's root and the folder the agent works in,
 * each as the board and git spell them), and relative to the agent's folder when that is a folder inside the repository.
 * A moved file counts through either of its names. A path git reports no change for is dropped.
 */
export function scopeFiles(
  files: readonly ChangeView[],
  paths: readonly string[],
  o: { root: string; bases: readonly string[] },
): ChangeView[] {
  const root = clean(o.root);
  const bases = [root, ...o.bases.map(clean)].filter((b) => b !== "");
  const folder = o.bases.map(clean).find((b) => b.startsWith(`${root}/`));
  const sub = folder ? folder.slice(root.length + 1) : "";
  const wanted = new Set<string>();
  for (const raw of paths) {
    const p = clean(raw);
    if (p === "") continue;
    if (p.startsWith("/")) {
      for (const base of bases) if (p.startsWith(`${base}/`)) wanted.add(p.slice(base.length + 1));
    } else {
      wanted.add(p);
      if (sub) wanted.add(`${sub}/${p}`);
    }
  }
  return files.filter((f) => wanted.has(f.path) || (f.oldPath != null && wanted.has(f.oldPath)));
}
