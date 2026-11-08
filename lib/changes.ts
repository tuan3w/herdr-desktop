import { Git } from "herdr-desktop/native";
import { announce } from "nsh";

import type { BoardProject, BoardRow, ChangeView, DiffView, GroupView, StatusView } from "herdr-desktop/native";

import {
  changesKey,
  context,
  focused,
  projectOfFolder,
  HOME,
  inside,
  openPanel,
  parseChangesKey,
  rowKeyOf,
} from "#lib/dock";
import { sizeText } from "#lib/files";
import { board, projectOf, rowOf } from "#lib/herdr";
import { projectFolder } from "#lib/sidebar";
import { fold } from "#lib/text";

/**
 * What the Changes tab decides that is not drawing: how the changed files are grouped and named, which are reviewed, what a
 * note and the message made of notes say, and which checkout a key or a click means. Reading git is Rust (`Git`);
 * `lib/changes-model.ts` holds the tab's state.
 */

export type Kind = ChangeView["kind"];

/** The groups of the list, in the order they read: what needs a decision first, then by what happened. */
export const SECTIONS: readonly Kind[] = ["conflicted", "modified", "added", "deleted", "renamed", "untracked"];

const TITLE: Record<Kind, string> = {
  conflicted: "Merge conflicts",
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};

/** The word for one file's state, in a label and under a heading. */
export const KIND_WORD: Record<Kind, string> = {
  conflicted: "conflicted",
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new, not in git",
};

/** `+12 −3` (a real minus sign, so it is never read as a hyphen). */
export const plusMinus = (added: number, removed: number): string => `+${added} \u2212${removed}`;

/** What a file's numbers say: `+12 −3`, `binary`, or its size when git could not count it. */
export function statsText(c: ChangeView): string {
  if (c.binary) return c.size == null ? "binary" : `binary, ${sizeText(c.size)}`;
  if (c.submodule) return "repository";
  if (c.added == null || c.removed == null) return c.size == null ? "" : sizeText(c.size);
  return plusMinus(c.added, c.removed);
}

/** The folder and the name of a path: `src/auth.ts` is `src/` and `auth.ts`. */
export function splitPath(path: string): { dir: string; name: string } {
  const bare = path.replace(/\/+$/, "");
  const at = bare.lastIndexOf("/");
  return { dir: at < 0 ? "" : bare.slice(0, at + 1), name: at < 0 ? bare : bare.slice(at + 1) };
}

/** What a screen reader says for a row of the list: `src/auth.ts, modified, +12 −3, reviewed`. */
export function fileLabel(c: ChangeView, reviewed: boolean): string {
  const from = c.oldPath ? `, from ${c.oldPath}` : "";
  const stats = statsText(c);
  return [`${c.path}`, `${KIND_WORD[c.kind]}${from}`, stats, reviewed ? "reviewed" : ""].filter(Boolean).join(", ");
}

// ---- reviewed ----

/** A file's `reviewed` marks of one checkout: the file's path and the fingerprint of the change that was reviewed. */
export type Marks = Record<string, string>;

/** Whether the change in `c` is the one that was marked: an edit since gives another fingerprint and the mark no longer holds. */
export const isReviewed = (marks: Marks | undefined, c: Pick<ChangeView, "path" | "fingerprint">): boolean =>
  marks?.[c.path] !== undefined && marks[c.path] === c.fingerprint;

/** `marks` with `c` marked reviewed, or with its mark removed. */
export function withMark(marks: Marks | undefined, c: Pick<ChangeView, "path" | "fingerprint">, on: boolean): Marks {
  const next = { ...marks };
  if (on) next[c.path] = c.fingerprint;
  else delete next[c.path];
  return next;
}

/** `marks` without the files that are no longer changed: a file that comes back changed is a new review. */
export function pruned(marks: Marks | undefined, files: readonly ChangeView[]): Marks | undefined {
  if (!marks) return marks;
  const listed = new Set(files.map((f) => f.path));
  const keep = Object.entries(marks).filter(([path]) => listed.has(path));
  return keep.length === Object.keys(marks).length ? marks : Object.fromEntries(keep);
}

/** The most checkouts whose marks are kept (the least recently written go first). Each is a few hundred bytes. */
export const MARKS_CAP = 40;

/** The saved marks of every checkout, read from a setting's JSON; anything else is nothing. */
export function readMarks(json: unknown): Record<string, Marks> {
  if (typeof json !== "object" || json === null) return {};
  const out: Record<string, Marks> = {};
  for (const [key, table] of Object.entries(json)) {
    if (typeof table !== "object" || table === null) continue;
    const marks = Object.fromEntries(Object.entries(table).filter(([, v]) => typeof v === "string"));
    if (Object.keys(marks).length > 0) out[key] = marks as Marks;
  }
  return out;
}

/** `all` with this checkout's marks replaced (newest last, so the cap drops the oldest); no marks removes the checkout. */
export function withCheckout(all: Record<string, Marks>, key: string, marks: Marks | undefined): Record<string, Marks> {
  const next = { ...all };
  delete next[key];
  if (marks && Object.keys(marks).length > 0) next[key] = marks;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MARKS_CAP))) delete next[old];
  return next;
}

// ---- the list ----

/** One line of the list: a heading with its count, or a file. */
export type Item =
  | { kind: "head"; key: string; section: Kind; title: string; count: number; open: boolean }
  | { kind: "file"; key: string; change: ChangeView; reviewed: boolean };

/** Whether `c` matches what was typed: every word is in its path (any case, accents ignored). */
export function matches(c: ChangeView, query: string): boolean {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(`${c.path} ${c.oldPath ?? ""}`);
  return words.every((w) => hay.includes(w));
}

/**
 * The list as rows: each non-empty group under its heading (folded groups show the heading only), files by path (git's own byte order, the same on every platform) inside it.
 * `marks` says which are reviewed; `folded` is the sections the person closed.
 */
export function listItems(
  files: readonly ChangeView[],
  query: string,
  marks: Marks | undefined,
  folded: ReadonlySet<Kind>,
): Item[] {
  const shown = files.filter((f) => matches(f, query));
  const items: Item[] = [];
  for (const section of SECTIONS) {
    const inSection = shown
      .filter((f) => f.kind === section)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (inSection.length === 0) continue;
    const open = !folded.has(section);
    items.push({ kind: "head", key: `h:${section}`, section, title: TITLE[section], count: inSection.length, open });
    if (open)
      for (const change of inSection)
        items.push({ kind: "file", key: `f:${change.path}`, change, reviewed: isReviewed(marks, change) });
  }
  return items;
}

/** The file `by` places after `current` in `order` (wrapping not: the ends stay). */
export function stepFile(order: readonly ChangeView[], current: string | null, by: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = order.findIndex((f) => f.path === current);
  if (at < 0) return order[by > 0 ? 0 : order.length - 1].path;
  return order[Math.max(0, Math.min(order.length - 1, at + by))].path;
}

/** `1 file`, `12 files`. */
export const filesText = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

/** What the header counts: the files and the lines added and removed in them (a file git could not count adds nothing). */
export function totalsOf(files: readonly ChangeView[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { files: files.length, added, removed };
}

/** One letter for a file's state in the list's fixed column (the row's accessible name says the word, `KIND_WORD`). */
export const KIND_MARK: Record<Kind, string> = {
  conflicted: "!",
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** The agents of a checkout as the header says them: the one agent's name, else a count; the tip lists them. Empty when none. */
export function agentPart(rows: readonly Pick<BoardRow, "name" | "agent">[]): { text: string; tip: string } {
  const names = rows.map((r) => r.name || r.agent);
  if (names.length === 0) return { text: "", tip: "" };
  return { text: names.length === 1 ? names[0] : `${names.length} agents`, tip: names.join(", ") };
}

/** This computer's machine id (`store::LOCAL_ID` in the core): the header names a machine only when it is another one. */
export const LOCAL = "local";

/**
 * Which of the header's optional parts fit beside the project and the branch. Widths are the texts' own, in points (each
 * laid out once with no clamp, as the sidebar does). `room` is the identity's share of the line; the scope (counts and
 * progress) has been taken off it first. The agent goes first and then the machine, whole or not at all, never a stub; the
 * project and the branch are never dropped (they fade when really too long).
 */
export function identityFit(o: { room: number; project: number; branch: number; machine: number; agent: number }): {
  machine: boolean;
  agent: boolean;
} {
  const base = o.project + o.branch;
  const both = base + o.machine + o.agent <= o.room;
  return {
    agent: o.agent > 0 && both,
    machine: o.machine > 0 && (both || base + o.machine <= o.room),
  };
}

/** The branch line: `main`, `main · 2 ahead · 1 behind`, `detached at 4f9a1c2`, plus `worktree` for a linked one. */
export function branchText(
  s: Pick<StatusView, "branch" | "detached" | "head" | "ahead" | "behind" | "linked" | "unborn">,
): string {
  const where = s.unborn
    ? (s.branch ?? "no commits yet")
    : s.detached
      ? `detached at ${s.head ?? "HEAD"}`
      : (s.branch ?? "no branch");
  const parts = [where];
  if (s.ahead > 0) parts.push(`${s.ahead} ahead`);
  if (s.behind > 0) parts.push(`${s.behind} behind`);
  if (s.linked) parts.push("worktree");
  return parts.join(" \u00b7 ");
}

// ---- notes ----

/** A note on one group of changes: where it is, the code it is about, and what the person said. */
export interface Note {
  id: number;
  path: string;
  /** The group's place in the file's diff (for the diff view's `Change n of m`). */
  group: number;
  line: number;
  endLine: number;
  /** The group's changed lines as the patch has them (`+` or `-` first). */
  quote: string[];
  more: number;
  /** The group only removed lines: `line` is where they were. */
  removedOnly: boolean;
  text: string;
  /** The file's fingerprint when the note was written: another one means the file changed since. */
  fingerprint: string;
}

/** A note on `group` of `diff`, not yet numbered. */
export function noteOn(
  diff: Pick<DiffView, "path">,
  group: GroupView,
  text: string,
  id: number,
  fingerprint: string,
): Note {
  return {
    id,
    path: diff.path,
    group: group.index,
    line: group.line,
    endLine: group.endLine,
    quote: group.lines,
    more: group.more,
    removedOnly: group.added === 0,
    text: text.trim(),
    fingerprint,
  };
}

/** Where a note points, as an agent reads it: `src/auth.ts:12-14`, `src/auth.ts:12`. */
export const noteWhere = (n: Pick<Note, "path" | "line" | "endLine">): string =>
  n.endLine > n.line ? `${n.path}:${n.line}-${n.endLine}` : `${n.path}:${n.line}`;

/** The longest quoted line kept whole; a longer one is cut with an ellipsis. */
const QUOTE_WIDTH = 200;

/**
 * The one message the notes make: a line saying what it is, then each note as its `path:line`, the changed lines quoted,
 * and the person's words, one blank line between notes. The agent sees exactly this (the person reads it first).
 */
export function notesMessage(notes: readonly Note[], repo?: string): string {
  const head = `Notes on your changes${repo ? ` in ${repo}` : ""} (${notes.length}):`;
  const blocks = notes.map((n) => {
    const where = n.removedOnly ? `${noteWhere(n)} (lines removed here)` : noteWhere(n);
    const quote = n.quote.map((l) => `> ${l.length > QUOTE_WIDTH ? `${l.slice(0, QUOTE_WIDTH)}\u2026` : l}`);
    if (n.more > 0) quote.push(`> \u2026 ${n.more} more changed ${n.more === 1 ? "line" : "lines"}`);
    return [where, ...quote, n.text].join("\n");
  });
  return [head, ...blocks].join("\n\n");
}

// ---- which checkout, which agent ----

/**
 * The agents of `machine` working in `root` (a checkout): rows whose folder is it or inside it, online ones. Both sides
 * go through `canonical` first (`Git.canonicalPath`): git names a checkout by its real path and an agent's folder may be
 * a link to it (`/var/x` for `/private/var/x`), which raw strings never match. No case folding: the canonical text is the identity.
 */
export function agentsIn(
  rows: readonly BoardRow[],
  machine: string,
  root: string,
  canonical: (machine: string, path: string) => string,
): BoardRow[] {
  const base = canonical(machine, root).replace(/\/+$/, "");
  return rows.filter(
    (r) =>
      r.machine === machine &&
      !r.offline &&
      ((r.cwd ?? "") !== "" ? inside(canonical(machine, r.cwd!), base) : canonical(machine, r.checkout ?? "") === base),
  );
}

/** Every checkout of a project that can be reviewed: its checkouts, else the folders its agents work in. */
export function checkoutsOf(project: Pick<BoardProject, "checkouts" | "rows">): { path: string; name: string }[] {
  if (project.checkouts.length > 0) return project.checkouts.map((c) => ({ path: c.path, name: c.name }));
  const folders = [...new Set(project.rows.flatMap((r) => (r.cwd ? [r.cwd] : [])))];
  return folders.map((path) => ({ path, name: splitPath(path).name }));
}

/** The folder the focused tab is working in, with its machine; `null` when nothing says. */
export function currentCheckout(): { machine: string; cwd: string } | null {
  const tab = focused();
  const own = parseChangesKey(tab);
  if (own) return own;
  const key = rowKeyOf(tab);
  const row = key === null ? undefined : rowOf(key);
  if (row?.cwd) return { machine: row.machine, cwd: row.cwd };
  const ctx = context();
  const project = ctx === HOME ? undefined : projectOf(ctx);
  if (project) {
    const cwd = projectFolder(project);
    if (cwd) return { machine: project.machine, cwd };
  }
  return null;
}

/** Opens the Changes tab of a checkout (in its project, next to the agents'), or shows it when it is open. */
export function openChanges(machine: string, cwd: string): Promise<void> {
  return openPanel(changesKey(machine, cwd));
}

/** `Review changes`: the Changes tab of the checkout the focused tab is in; says why when there is none. */
export async function reviewChanges(): Promise<void> {
  const at = currentCheckout();
  if (!at) {
    announce("Open an agent or a project first");
    return;
  }
  await openChanges(at.machine, at.cwd);
}

/**
 * The name of a checkout of `projects` for a tab and a heading: the project's, with the folder's own name for a
 * worktree. Folders go through `canonical` (`Git.canonicalPath`): a project lists its checkouts by git's real path and
 * `cwd` may be a link to one.
 */
export function checkoutNameOf(
  projects: readonly BoardProject[],
  machine: string,
  cwd: string,
  canonical: (machine: string, path: string) => string,
): string {
  const folder = splitPath(cwd).name || cwd;
  const key = projectOfFolder(projects, machine, cwd, canonical);
  const project = key ? projects.find((p) => p.key === key) : undefined;
  const here = canonical(machine, cwd).replace(/\/+$/, "");
  const checkout = project?.checkouts.find((c) => canonical(machine, c.path).replace(/\/+$/, "") === here);
  return checkout?.linked ? `${project!.name} \u00b7 ${checkout.name}` : (project?.name ?? folder);
}

/** The name of a checkout for a tab and a heading, by the live board. */
export const checkoutName = (machine: string, cwd: string): string =>
  checkoutNameOf(board().projects, machine, cwd, Git.canonicalPath);
