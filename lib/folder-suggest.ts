import { fold } from "#lib/text";

/**
 * What the `Folder` path field suggests, with no UI: the folders to ask a machine for, and from its answer the rows to
 * show. The listing itself is Rust (`Files.list`), which validates every path (`validate_path`: absolute or `~/`, no
 * NUL, at most 4096 bytes); a path is only ever handed over as a path, never composed into a command here.
 */

/** As the core's `PATH_MAX`: a longer path is refused there, so no listing is asked for it. */
const PATH_MAX = 4096;
/** How many folders up a typed path is tried before the field gives up and says the first one failed. */
const MAX_UP = 6;

/** The answers `Files.list` gives for a folder that is not there or is a file (`native/core/src/files/mod.rs`): the field goes on up to a folder that is. Any other failure (denied, unreachable) is shown. */
export const isMissing = (message: string): boolean => /does not exist|is not a folder/i.test(message);

/** What `Files.list` says of an entry that this needs. */
export interface FolderEntry {
  name: string;
  kind: string;
  readable: boolean;
}

/** One suggestion: the folder `path` (no trailing slash), what to call it, and why it cannot be chosen if it cannot. */
export interface FolderRow {
  path: string;
  name: string;
  /** Muted text after the name: the folder above a project, or `No permission`. */
  hint?: string;
  /** `Projects` or `Recent` for the empty field; typed rows have none. */
  group?: string;
  unreadable?: boolean;
}

/** A folder to list: `shown` is the typed text up to its slash, `dir` what the machine is asked (`~/` is asked as `~`). */
export interface Candidate {
  shown: string;
  dir: string;
}

const validStart = (typed: string): boolean =>
  (typed.startsWith("/") || typed.startsWith("~/")) && typed.length <= PATH_MAX && !/[\0\r\n]/.test(typed);

const dirOf = (shown: string): string =>
  shown === "~/" ? "~" : shown === "/" ? "/" : shown.replace(/\/+$/, "") || "/";

/** The folders whose children could complete `typed`, the nearest first, up to the root. A text that is not a path has none. */
export function parents(typed: string): Candidate[] {
  if (!validStart(typed)) return [];
  const out: Candidate[] = [];
  let shown = typed.slice(0, typed.lastIndexOf("/") + 1);
  while (shown !== "" && out.length < MAX_UP) {
    out.push({ shown, dir: dirOf(shown) });
    if (shown === "/" || shown === "~/") break;
    shown = shown.slice(0, shown.slice(0, -1).lastIndexOf("/") + 1);
  }
  return out;
}

/** A name that is a single folder name: a listing is the machine's word, and a name with a slash or a control character is not one. */
const plainName = (name: string): boolean => name !== "" && name !== "." && name !== ".." && !/[/\0\r\n]/.test(name);

const lastParts = (path: string): { name: string; hint?: string } => {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "/" };
  return { name: parts[parts.length - 1], hint: parts[parts.length - 2] };
};

const bare = (path: string): string => path.trim().replace(/\/+$/, "") || path.trim();

/**
 * The rows for `typed`. Typing: the subfolders of `listed.shown` (the nearest folder that exists) whose name matches what
 * follows it, names that start with it before names that merely hold it, hidden folders only when the tail starts with
 * a dot; none says why in `note`. Empty: `projects` then the `recents` that are not among them. A listing that is not of
 * what is typed (a late answer) offers nothing.
 */
export function suggest(o: {
  typed: string;
  listed?: { shown: string; entries: readonly FolderEntry[] };
  projects: readonly string[];
  recents: readonly string[];
}): { rows: FolderRow[]; note?: string } {
  if (o.typed.trim() === "") {
    const seen = new Set<string>();
    const rows: FolderRow[] = [];
    for (const [group, paths] of [
      ["Projects", o.projects],
      ["Recent", o.recents],
    ] as const)
      for (const raw of paths) {
        const path = bare(raw);
        if (path === "" || seen.has(path)) continue;
        seen.add(path);
        rows.push({ path, group, ...lastParts(path) });
      }
    return { rows };
  }
  const { listed } = o;
  if (!listed || !validStart(o.typed) || !o.typed.startsWith(listed.shown)) return { rows: [] };
  const tail = o.typed.slice(listed.shown.length).split("/")[0];
  const want = fold(tail);
  const folders = listed.entries.filter(
    (e) => e.kind === "dir" && plainName(e.name) && (tail.startsWith(".") || !e.name.startsWith(".")),
  );
  const starts: FolderRow[] = [];
  const holds: FolderRow[] = [];
  for (const e of folders) {
    const at = fold(e.name).indexOf(want);
    if (at < 0) continue;
    const row: FolderRow = { path: `${listed.shown}${e.name}`, name: e.name };
    if (!e.readable) {
      row.unreadable = true;
      row.hint = "No permission";
    }
    (at === 0 ? starts : holds).push(row);
  }
  const rows = [...starts, ...holds];
  if (rows.length > 0) return { rows };
  return { rows, note: tail === "" ? `No folders in ${listed.shown}` : `No folder named ${tail} in ${listed.shown}` };
}

/** What choosing `row` puts in the field: a folder of a listing gets a slash so the next level lists; a project or a recent folder is whole. */
export const complete = (row: FolderRow): string => (row.group ? row.path : `${row.path}/`);
