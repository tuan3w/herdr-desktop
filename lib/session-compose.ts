import type { EntryView, QueuedView, SessionView } from "herdr-desktop/native";
import { fold } from "./text";

/**
 * The rules of the chat's message box, pure: the `@` that lists files, what a send does while the agent works, how a
 * message taken back from the queue lands in the box. The box itself is `components/session-composer.tsx`.
 */

/** A `@word` the caret is in the middle of. */
export interface Mention {
  /** Index of the `@` in the text. */
  start: number;
  /** What follows it up to the caret: `src/ma`. */
  query: string;
}

/**
 * The mention the caret is in: an `@` at the start of the text or after whitespace, then no whitespace up to the caret.
 * An `@` inside a word (`me@host`) is just a character, so addresses stay typeable.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.search(/(?:^|\s)@[^\s@]*$/);
  if (at < 0) return null;
  const start = before.indexOf("@", at);
  return { start, query: before.slice(start + 1) };
}

/** The folder a query names (`src/ma` is in `src`) and the part of a name typed so far (`ma`). */
export function splitQuery(query: string): { dir: string; name: string } {
  const slash = query.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: query } : { dir: query.slice(0, slash + 1), name: query.slice(slash + 1) };
}

/** Most files the mention list shows: it is a list to pick from, not a file browser. */
export const MENTION_ROWS = 8;

/**
 * The entries of a folder that `name` picks: names that start with it first, then names that hold it, folders before
 * files within each, hidden ones only when the name starts with a dot. Case, diacritics and invisible characters do not
 * matter.
 */
export function rankEntries(entries: readonly EntryView[], name: string): EntryView[] {
  const needle = fold(name);
  const rank = (e: EntryView): number => {
    const n = fold(e.name);
    if (needle === "") return 0;
    return n.startsWith(needle) ? 0 : n.includes(needle) ? 1 : 2;
  };
  return entries
    .filter((e) => (needle.startsWith(".") || !e.name.startsWith(".")) && rank(e) < 2)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || Number(a.e.kind !== "dir") - Number(b.e.kind !== "dir") || a.i - b.i)
    .map((x) => x.e)
    .slice(0, MENTION_ROWS);
}

/**
 * `text` with the mention replaced by the path picked. A file ends with a space (unless one follows already), so typing goes on; a folder ends with
 * `/` and no space, so the list goes on into it. Returns where the caret belongs.
 */
export function applyMention(text: string, mention: Mention, caret: number, path: string, folder: boolean): { text: string; caret: number } {
  const tail = text.slice(caret);
  const insert = folder ? `@${path}/` : /^\s/.test(tail) ? `@${path}` : `@${path} `;
  const next = text.slice(0, mention.start) + insert + tail;
  return { text: next, caret: mention.start + insert.length };
}

/** What sending now does, said before it is done: nothing while the message would simply go. */
export function deliveryNote(view: Pick<SessionView, "running" | "queue">): string | null {
  if (view.running) return "Goes into the queue and is sent when the turn ends. Esc stops the turn.";
  if (view.queue.length > 0) return "Messages already waiting go first, in order.";
  return null;
}

/** Why queued messages are held (the turn failed), when any is: `releaseQueue` lets them go. */
export const heldReason = (queue: readonly QueuedView[]): string | null => queue.find((q) => q.held)?.held ?? null;

/** A message taken back from the queue lands after what is already typed, on its own line: nothing typed is lost. */
export function restoreText(typed: string, taken: string): string {
  return typed.trim() === "" ? taken : `${taken}\n${typed}`;
}

/** Most files one message carries: a chip row is a row. */
export const MAX_FILES = 5;

/** `report.pdf` for `/home/me/report.pdf`. */
export const fileName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
