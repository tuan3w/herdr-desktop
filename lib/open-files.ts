import { Git } from "herdr-desktop/native";
import { signal } from "nsh";

import { filesKey, folderProject, inside, openPanel } from "#lib/dock";
import { parentOf } from "#lib/files";
import { projectOf } from "#lib/herdr";
import { projectFolder } from "#lib/sidebar";

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

/**
 * Where a relative path an agent named is looked for, in order: the session's own folder (`cwd`), then the checkout
 * that holds it (the agent may sit in a subfolder of it), then the project's main checkout (`main`). `canonical` turns a
 * folder into the real path git names checkouts by. Empty when no folder is known.
 */
export function linkFolders(
  cwd: string,
  checkouts: readonly string[],
  main: string,
  canonical: (path: string) => string = (p) => p,
): string[] {
  const out: string[] = [];
  const add = (folder: string) => {
    const f = folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
    if (f !== "" && !out.includes(f)) out.push(f);
  };
  add(cwd);
  if (cwd !== "") {
    const here = canonical(cwd);
    const holding = checkouts
      .filter((c) => inside(here, canonical(c)))
      .sort((a, b) => canonical(b).length - canonical(a).length)[0];
    if (holding) add(holding);
  }
  add(main);
  return out;
}

/** `linkFolders` of a session working in `cwd` on `machine`, its checkouts and project read from the live board. */
export function searchFolders(machine: string, cwd: string | null | undefined): string[] {
  const here = cwd ?? "";
  const key = here === "" ? null : folderProject(machine, here);
  const project = key === null ? undefined : projectOf(key);
  return linkFolders(here, project?.checkouts.map((c) => c.path) ?? [], project ? projectFolder(project) : "", (p) =>
    Git.canonicalPath(machine, p),
  );
}
