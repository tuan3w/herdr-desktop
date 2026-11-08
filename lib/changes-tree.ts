import type { ChangeView } from "herdr-desktop/native";

/**
 * How the changed files are grouped for reading: by folder, each folder named once by its whole path, its files under
 * it by name. Only a folder that holds a changed file gets a heading, so a chain with nothing of its own
 * (`native/app/`, whose files are all in `src/` and `tests/`) never costs a row of its own: the heading of the folder
 * below says `native/app/src`. A file with merge conflicts is the one exception to "by folder": those go first in one
 * group of their own because they need a decision before anything else.
 */

/** The group of the files git could not merge. Its key is never a folder's (a folder key starts with `dir:`). */
export const CONFLICTS = "conflicts";

/** The key of a folder's group, `dir:` and the folder without the last slash (`dir:` is the repository root). */
export const dirKey = (dir: string): string => `dir:${dir}`;

/** The title of the root's group: files that sit at the top of the repository have no folder to name. */
export const ROOT_TITLE = "Top level";

/**
 * The key of the section for files git does not know when there are many of them: output, logs and data an agent's run
 * left in the folder are not changes to read one by one. It holds the folders (`new:<dir>`), all closed until pressed.
 */
export const NEW_ROOT = "new";
const NEW_PREFIX = "new:";

/** More unknown files than this are output, not changes: they go to the closed section. A handful is a change like any other. */
export const NEW_FOLD_ABOVE = 12;

/** Whether a group is closed until the person opens it. */
export const startsClosed = (key: string): boolean => key === NEW_ROOT || key.startsWith(NEW_PREFIX);

export interface Group {
  key: string;
  /** The folder as git wrote it (`native/app/src`), `""` for the root; the conflicts group has none. */
  dir: string;
  title: string;
  files: ChangeView[];
  /** The group is part of the section of unknown files. */
  quiet?: boolean;
}

/** How much a file changed, for ordering: its lines added and removed (a file git could not count weighs nothing). */
export const weightOf = (c: Pick<ChangeView, "added" | "removed">): number => (c.added ?? 0) + (c.removed ?? 0);

export interface TreeOptions {
  /** `path`: by name. `size`: the biggest change first, folders by what they hold. */
  sort?: "path" | "size";
  /** Paths that are never put in the section of unknown files, whatever they are: the ones the session edited. */
  keep?: ReadonlySet<string>;
}

/** A path's folder without the trailing slash: `src/lib/a.ts` is `src/lib`, `a.ts` is `""`. */
export function dirOf(path: string): string {
  const bare = path.replace(/\/+$/, "");
  const at = bare.lastIndexOf("/");
  return at < 0 ? "" : bare.slice(0, at);
}

/** A path's last part, whole: `src/lib/a.ts` is `a.ts`. */
export function nameOf(path: string): string {
  const bare = path.replace(/\/+$/, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/** git's own byte order, the same on every platform (never a locale's). */
export const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Folders by their parts, so `a` is followed by `a/b` and only then by `a-b` (a plain string compare would put `-` before `/`). */
function bySegments(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = byPath(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}

/**
 * The groups, in reading order: conflicts, then the root's files, then every folder with a changed file by its path
 * (so `native/app/src` follows `native/app` and neighbours stay together), then, when git does not know more than
 * `NEW_FOLD_ABOVE` of the files, their folders as the section `NEW_ROOT`. Files inside a group go by name, then by path;
 * with `sort: "size"` the biggest change goes first and so do the folders. An empty list gives no groups.
 */
export function groupFiles(files: readonly ChangeView[], o: TreeOptions = {}): Group[] {
  const groups = new Map<string, Group>();
  const put = (key: string, dir: string, title: string, c: ChangeView, quiet = false) => {
    const g = groups.get(key);
    if (g) g.files.push(c);
    else groups.set(key, { key, dir, title, files: [c], quiet });
  };
  const unknown = files.filter((f) => f.kind === "untracked" && !o.keep?.has(f.path));
  const fold = unknown.length > NEW_FOLD_ABOVE ? new Set(unknown) : new Set<ChangeView>();
  for (const c of files) {
    const dir = dirOf(c.path);
    const title = dir === "" ? ROOT_TITLE : dir;
    if (c.kind === "conflicted") put(CONFLICTS, "", "Merge conflicts", c);
    else if (fold.has(c)) put(`${NEW_PREFIX}${dir}`, dir, title, c, true);
    else put(dirKey(dir), dir, title, c);
  }
  const size = o.sort === "size";
  const order = (g: Group) => (g.quiet ? 3 : g.key === CONFLICTS ? 0 : !size && g.dir === "" ? 1 : 2);
  const total = (g: Group) => g.files.reduce((n, f) => n + weightOf(f), 0);
  const inGroup = (a: ChangeView, b: ChangeView) =>
    (size ? weightOf(b) - weightOf(a) : 0) || byPath(nameOf(a.path), nameOf(b.path)) || byPath(a.path, b.path);
  return [...groups.values()]
    .map((g) => ({ ...g, files: g.files.sort(inGroup) }))
    .sort((a, b) => order(a) - order(b) || (size ? total(b) - total(a) : 0) || bySegments(a.dir, b.dir));
}
