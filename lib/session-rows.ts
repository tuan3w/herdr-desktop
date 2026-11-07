import type { SessionItem } from "herdr-desktop/native";
import { diffStat, isSubagent, toolKindOf } from "#lib/session-text";

/**
 * The transcript as the rows of one virtual list. The agent's items are a flat run of messages, tool calls and thoughts;
 * a person reads turns: what I asked, what it did (quiet, folded once it is over), what it answered. So:
 *
 * - the person's message and the agent's words are rows of their own, always shown;
 * - a run of tool calls and thoughts between them is one **work** group: a header row (`Worked for 4s`, `Working · 6s`)
 *   and, while it is open, a row per call. A group is open while its turn runs, folded once it is over, and the person's
 *   own choice (`open`, by row key) wins either way.
 *
 * Rows are plain data: the list recycles its cells, so a row keeps no state (the model keeps what is open). `buildRows`
 * hands back the previous row object whenever its `sig` did not change, so the list sees an unchanged row as unchanged and
 * a streamed answer rebinds one cell, not the screen.
 */

/** What a work group's header counts. */
export interface WorkSummary {
  /** Tool calls and thoughts in the group. */
  steps: number;
  /** Commands it ran (`execute` calls). */
  commands: number;
  /** Files its calls changed (edits, as the diffs name them). */
  changed: number;
  /** Calls that failed. */
  failed: number;
  /** Calls still waiting or running. */
  unfinished: number;
  /** Lines added across its diffs. */
  added: number;
  /** Lines removed across its diffs. */
  removed: number;
}

/** A group of tool calls and thoughts between two messages. */
export interface Work {
  /** Id of its first item: the group's identity as items arrive. */
  id: number;
  open: boolean;
  /** The turn is running and this is where it is working now. */
  running: boolean;
  /** Whole seconds it took (or has taken so far), when this window watched it happen; a replay has no times. */
  seconds: number | null;
  summary: WorkSummary;
}

/** One line of the transcript's list. */
export type Row =
  | { kind: "earlier"; key: string; sig: string; text: string }
  | { kind: "user"; key: string; sig: string; item: SessionItem }
  | { kind: "agent"; key: string; sig: string; item: SessionItem; live: boolean }
  | { kind: "work"; key: string; sig: string; work: Work }
  | { kind: "tool"; key: string; sig: string; item: SessionItem; open: boolean; all: boolean }
  | { kind: "subagent"; key: string; sig: string; item: SessionItem; open: boolean; all: boolean }
  | { kind: "thought"; key: string; sig: string; item: SessionItem; open: boolean; seconds: number | null }
  | { kind: "note"; key: string; sig: string; item: SessionItem }
  | { kind: "done"; key: string; sig: string; item: SessionItem }
  | { kind: "other"; key: string; sig: string; item: SessionItem };

/** What `buildRows` reads. */
export interface RowInput {
  /** The conversation, oldest first. */
  items: readonly SessionItem[];
  /** Said above the first row when the machine no longer keeps the oldest turns. */
  earlier: string | null;
  /** A turn is running. */
  running: boolean;
  /** What the person opened (`true`) or closed (`false`), by row key (`i:<id>`, `w:<id>` or `more:<id>`). */
  open: ReadonlyMap<string, boolean>;
  /** The session's own clock now (the units of `SessionItem.startedMs`), for what is still running; `null` when unknown. */
  nowMs: number | null;
}

/**
 * Whole seconds a run of rows took, from the first row's start to the last row's end: its own `endedMs`, else the next
 * row's start, else `nowMs` (still running). `null` when the agent gave no times (a replay), and under a second.
 */
export function spanSeconds(first: SessionItem, last: SessionItem, next: SessionItem | undefined, nowMs: number | null): number | null {
  const start = first.startedMs;
  if (start == null) return null;
  const end = last.endedMs ?? next?.startedMs ?? nowMs;
  if (end == null) return null;
  const seconds = Math.round((end - start) / 1000);
  return seconds >= 1 ? seconds : null;
}

/** The key of the row an item makes. */
export const itemKey = (id: number): string => `i:${id}`;

/** The key of the choice to show every kept line of item `id`'s output instead of its first lines. */
export const moreKey = (id: number): string => `more:${id}`;

/** The key of the group that starts at item `id`. */
export const workKey = (id: number): string => `w:${id}`;

const isWork = (item: SessionItem): boolean =>
  (item.kind === "tool" && item.tool != null && !isSubagent(item.tool)) || (item.kind === "message" && item.role === "thought");

function summarize(group: readonly SessionItem[]): WorkSummary {
  const out: WorkSummary = { steps: group.length, commands: 0, changed: 0, failed: 0, unfinished: 0, added: 0, removed: 0 };
  const files = new Set<string>();
  for (const item of group) {
    const tool = item.tool;
    if (!tool) continue;
    if (toolKindOf(tool) === "execute") out.commands += 1;
    if (tool.status === "failed") out.failed += 1;
    if (tool.status === "pending" || tool.status === "inProgress") out.unfinished += 1;
    for (const d of tool.diffs) files.add(d.path);
    const { added, removed } = diffStat(tool);
    out.added += added;
    out.removed += removed;
  }
  out.changed = files.size;
  return out;
}

/**
 * The rows of `input`, reusing every row of `prev` (by key) that did not change. `range` limits it to the items from
 * `from` (a unit boundary: the start of a message or of a work group) up to, not including, `to`; the model builds what
 * the stream is not touching once and only the last unit again per chunk. The header says `Earlier…` only when the range
 * starts at the top.
 */
export function buildRows(input: RowInput, prev?: ReadonlyMap<string, Row>, range?: { from: number; to: number }): Row[] {
  const rows: Row[] = [];
  const keep = (row: Row): void => {
    const old = prev?.get(row.key);
    rows.push(old && old.sig === row.sig && old.kind === row.kind ? old : row);
  };
  const { items } = input;
  const from = range?.from ?? 0;
  const to = range?.to ?? items.length;
  if (input.earlier && from === 0) keep({ kind: "earlier", key: "earlier", sig: input.earlier, text: input.earlier });

  let i = from;
  while (i < to) {
    const item = items[i]!;
    if (isWork(item)) {
      let end = i;
      while (end < to && isWork(items[end]!)) end += 1;
      const group = items.slice(i, end);
      const running = input.running && end === items.length;
      const key = workKey(item.id);
      const open = input.open.get(key) ?? running;
      const after = items[end];
      const seconds = spanSeconds(item, items[end - 1]!, after, input.nowMs);
      const summary = summarize(group);
      const s = summary;
      keep({
        kind: "work",
        key,
        sig: `${open}|${running}|${seconds}|${s.steps}|${s.commands}|${s.changed}|${s.failed}|${s.unfinished}|${s.added}|${s.removed}`,
        work: { id: item.id, open, running, seconds, summary },
      });
      if (open) {
        group.forEach((member, at) => {
          const mkey = itemKey(member.id);
          const mopen = input.open.get(mkey) ?? false;
          if (member.kind === "message") {
            const secs = spanSeconds(member, member, group[at + 1] ?? after, input.nowMs);
            keep({ kind: "thought", key: mkey, sig: `${member.rev}|${mopen}|${secs}`, item: member, open: mopen, seconds: secs });
          } else {
            const all = input.open.get(moreKey(member.id)) ?? false;
            keep({ kind: "tool", key: mkey, sig: `${member.rev}|${mopen}|${all}`, item: member, open: mopen, all });
          }
        });
      }
      i = end;
      continue;
    }
    const key = itemKey(item.id);
    if (item.kind === "message" && item.role === "user") {
      keep({ kind: "user", key, sig: `${item.rev}`, item });
    } else if (item.kind === "message") {
      // An empty agent message is a stream that has not said anything yet: no row until it does.
      const live = input.running && i === items.length - 1;
      if ((item.text ?? "").trim() !== "") keep({ kind: "agent", key, sig: `${item.rev}|${live}`, item, live });
    } else if (item.kind === "tool" && item.tool && isSubagent(item.tool)) {
      const open = input.open.get(key) ?? false;
      const all = input.open.get(moreKey(item.id)) ?? false;
      keep({ kind: "subagent", key, sig: `${item.rev}|${open}|${all}`, item, open, all });
    } else if (item.kind === "note") {
      keep({ kind: "note", key, sig: `${item.rev}`, item });
    } else if (item.kind === "done") {
      keep({ kind: "done", key, sig: `${item.rev}`, item });
    } else {
      // A kind this app does not know yet (or a tool with nothing in it): a quiet generic row, never a crash.
      keep({ kind: "other", key, sig: `${item.rev}`, item });
    }
    i += 1;
  }
  return rows;
}

/** Where the unit that holds item `index` starts: a work group starts at its first call, anything else at itself. */
export function unitStart(items: readonly SessionItem[], index: number): number {
  let at = Math.max(0, Math.min(index, items.length - 1));
  if (items.length > 0 && isWork(items[at]!)) while (at > 0 && isWork(items[at - 1]!)) at -= 1;
  return at;
}
