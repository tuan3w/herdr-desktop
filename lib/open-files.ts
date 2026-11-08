import { signal } from "nsh";

import { filesKey, openPanel } from "#lib/dock";
import { parentOf } from "#lib/files";

/** What opened a Files tab: the folder, and with `file` the viewer opens on that file first (a path an agent named). */
export interface Browse {
  machine: string;
  dir: string;
  file?: string;
  /** The line of `file` a link named (`main.rs:42`): the viewer scrolls to it. */
  line?: number;
}

/**
 * The last thing each Files tab was asked to show, by tab key. A tab that is already open reads the new request and goes
 * there; a tab that is only now built (opened by this very call) reads the one that made it. A saved tab with no request
 * lists the folder its key names.
 */
export const requests = signal<Record<string, Browse>>({});

/** The key of the tab asked for last: the labs, which have no tab area, draw that one (`null`: none). */
export const lastAsked = signal<string | null>(null);

function ask(request: Browse): void {
  const key = filesKey(request.machine, request.dir);
  requests.update((all) => ({ ...all, [key]: request }));
  lastAsked.set(key);
  void openPanel(key);
}

/** Opens a Files tab on a folder of a machine (the open one when there is one). */
export function browseFiles(machine: string, dir: string): void {
  ask({ machine, dir });
}

/** Opens the Files tab of a file's folder with the viewer on the file, at `line` when a link gave one; Back there lists its folder. */
export function viewFile(machine: string, path: string, line?: number | null): void {
  ask({ machine, dir: parentOf(path) ?? "/", file: path, line: line ?? undefined });
}
