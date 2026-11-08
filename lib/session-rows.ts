import type { EffectKindName, SessionItem } from "herdr-desktop/native";

import { diffStat, isSubagent, oneLine, toolKindOf, toolLine, visibleText } from "#lib/session-text";

/**
 * The transcript as the rows of one virtual list. The agent's items are a flat run of messages, tool calls and thoughts;
 * a person reads turns: what I asked, what it did (quiet, folded once it is over), what it answered. So:
 *
 * - the person's message and the agent's words are rows of their own, always shown;
 * - a run of tool calls and thoughts between them, and the agent's narration between two calls, is one **work** group:
 *   one muted line (`Read 8 files, ran 4 commands`) and, while the person has it open, a row per step. It is folded
 *   until the person opens it (`open`, by row key), also while its turn runs: the live line says what happens now;
 * - after a finished turn comes its **effects**: what failed, what happened outside the machine (a push, a delete, an
 *   install) and what was edited. A turn is ranked by what it did, not by when: those never hide in a fold.
 *
 * Rows are plain data: the list recycles its cells, so a row keeps no state (the model keeps what is open). `buildRows`
 * hands back the previous row object whenever its `sig` did not change, so the list sees an unchanged row as unchanged and
 * a streamed answer rebinds one cell, not the screen.
 */

/** What a work group's line counts. */
export interface WorkSummary {
  /** Tool calls, thoughts and narration in the group. */
  steps: number;
  /** Files it read (`read` calls). */
  reads: number;
  /** Searches it ran (`search` calls). */
  searches: number;
  /** Pages it fetched (`fetch` calls). */
  fetches: number;
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

/** A group of tool calls, thoughts and narration between two messages. */
export interface Work {
  /** Id of its first item: the group's identity as items arrive. */
  id: number;
  open: boolean;
  summary: WorkSummary;
}

/** A call that failed: what it was and the last line it printed (never an exit code nobody sent). */
export interface Failure {
  id: number;
  text: string;
  result: string | null;
}

/** A call that did something outside this machine, as Rust classified it. */
export interface External {
  id: number;
  kind: EffectKindName;
  text: string;
}

/** What a finished turn did that must not hide in a fold. The keys are the order they are shown in. */
export interface TurnEffects {
  failures: Failure[];
  external: External[];
  /** Files edited and the lines changed across all of the turn's edits; `null` when it edited nothing. */
  edited: { files: number; added: number; removed: number } | null;
}

/** What one work group adds to its turn's effects: computed once per group, carried to the end of the turn. */
interface Contribution {
  failures: Failure[];
  external: External[];
  paths: string[];
  added: number;
  removed: number;
}

/** The groups of the turn a range of rows ends inside, so a range that starts mid-turn need not read the turn again. */
export interface TurnCarry {
  groups: Contribution[];
}

/** Where a call stands in a run of calls drawn as one bordered box: its rows share the box's sides, only the ends round. */
export type Edge = "only" | "first" | "mid" | "last";

/** One line of the transcript's list. */
export type Row =
  | { kind: "earlier"; key: string; sig: string; text: string }
  | { kind: "user"; key: string; sig: string; item: SessionItem }
  | { kind: "agent"; key: string; sig: string; item: SessionItem; live: boolean }
  | { kind: "work"; key: string; sig: string; work: Work }
  | { kind: "effects"; key: string; sig: string; effects: TurnEffects }
  | { kind: "narration"; key: string; sig: string; item: SessionItem }
  | { kind: "tool"; key: string; sig: string; item: SessionItem; open: boolean; all: boolean; edge: Edge }
  | { kind: "subagent"; key: string; sig: string; item: SessionItem; open: boolean; all: boolean }
  | { kind: "thought"; key: string; sig: string; item: SessionItem; open: boolean; seconds: number | null }
  | { kind: "note"; key: string; sig: string; item: SessionItem }
  | { kind: "other"; key: string; sig: string; item: SessionItem };

/** What `buildRows` reads. */
export interface RowInput {
  /** The conversation, oldest first. */
  items: readonly SessionItem[];
  /** Said above the first row when the machine no longer keeps the oldest turns. */
  earlier: string | null;
  /** A turn is running. */
  running: boolean;
  /** The session's folder, so paths read short; optional. */
  cwd?: string | null;
  /** What the person opened (`true`) or closed (`false`), by row key (`i:<id>`, `w:<id>` or `more:<id>`). */
  open: ReadonlyMap<string, boolean>;
  /** The session's own clock now (the units of `SessionItem.startedMs`), for what is still running; `null` when unknown. */
  nowMs: number | null;
}

/**
 * Whole seconds a run of rows took, from the first row's start to the last row's end: its own `endedMs`, else the next
 * row's start, else `nowMs` (still running). `null` when the agent gave no times (a replay), and under a second.
 */
export function spanSeconds(
  first: SessionItem,
  last: SessionItem,
  next: SessionItem | undefined,
  nowMs: number | null,
): number | null {
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
  (item.kind === "tool" && item.tool != null && !isSubagent(item.tool)) ||
  (item.kind === "message" && item.role === "thought");

/** Narration: an agent message with work right before and right after it. The turn's last message never is. */
const isNarration = (items: readonly SessionItem[], at: number): boolean => {
  const item = items[at]!;
  return (
    item.kind === "message" &&
    item.role === "agent" &&
    at > 0 &&
    at + 1 < items.length &&
    isWork(items[at - 1]!) &&
    isWork(items[at + 1]!)
  );
};

/** Part of a work group: a call, a thought, or narration between calls. */
const isMember = (items: readonly SessionItem[], at: number): boolean => isWork(items[at]!) || isNarration(items, at);

function summarize(group: readonly SessionItem[]): WorkSummary {
  const out: WorkSummary = {
    steps: group.length,
    reads: 0,
    searches: 0,
    fetches: 0,
    commands: 0,
    changed: 0,
    failed: 0,
    unfinished: 0,
    added: 0,
    removed: 0,
  };
  const files = new Set<string>();
  for (const item of group) {
    const tool = item.tool;
    if (!tool) continue;
    const kind = toolKindOf(tool);
    if (kind === "execute") out.commands += 1;
    else if (kind === "read") out.reads += 1;
    else if (kind === "search") out.searches += 1;
    else if (kind === "fetch") out.fetches += 1;
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

function contribute(group: readonly SessionItem[], cwd: string | null | undefined): Contribution {
  const out: Contribution = { failures: [], external: [], paths: [], added: 0, removed: 0 };
  const paths = new Set<string>();
  for (const item of group) {
    const tool = item.tool;
    if (!tool) continue;
    if (tool.status === "failed") {
      const line = toolLine(tool, cwd);
      const last = [...tool.head, ...tool.tail].reverse().find((l) => l.trim() !== "");
      out.failures.push({
        id: item.id,
        text: [line.verb, line.object].filter(Boolean).join(" "),
        result: last === undefined ? null : oneLine(visibleText(last), 160),
      });
    }
    if (tool.effect)
      out.external.push({ id: item.id, kind: tool.effect.kind, text: oneLine(visibleText(tool.effect.text), 160) });
    for (const d of tool.diffs) paths.add(d.path);
    const { added, removed } = diffStat(tool);
    out.added += added;
    out.removed += removed;
  }
  out.paths = [...paths];
  return out;
}

/** A turn's groups as what it did, in the order the row shows it; `null` when there is nothing to say. */
function mergeEffects(groups: readonly Contribution[]): TurnEffects | null {
  const failures = groups.flatMap((g) => g.failures);
  const external = groups.flatMap((g) => g.external);
  const paths = new Set(groups.flatMap((g) => g.paths));
  const added = groups.reduce((n, g) => n + g.added, 0);
  const removed = groups.reduce((n, g) => n + g.removed, 0);
  if (failures.length === 0 && external.length === 0 && paths.size === 0) return null;
  return { failures, external, edited: paths.size > 0 ? { files: paths.size, added, removed } : null };
}

const effectsSig = (e: TurnEffects): string =>
  [
    e.failures.map((f) => `${f.id}:${f.result}`).join(","),
    e.external.map((x) => `${x.id}:${x.kind}`).join(","),
    e.edited ? `${e.edited.files}+${e.edited.added}-${e.edited.removed}` : "",
  ].join("|");

/**
 * The rows of `input`, reusing every row of `prev` (by key) that did not change. `range` limits it to the items from
 * `from` (a unit boundary: the start of a message or of a work group) up to, not including, `to`; the model builds what
 * the stream is not touching once and only the last unit again per chunk. The header says `Earlier…` only when the range
 * starts at the top. `carry` holds what the turn the range starts in has done so far: the caller keeps the one that the
 * built part left, and hands a copy to every build of the tail, so a turn's effects never read the turn again.
 */
export function buildRows(
  input: RowInput,
  prev?: ReadonlyMap<string, Row>,
  range?: { from: number; to: number; carry?: TurnCarry },
): Row[] {
  const rows: Row[] = [];
  const keep = (row: Row): void => {
    const old = prev?.get(row.key);
    rows.push(old && old.sig === row.sig && old.kind === row.kind ? old : row);
  };
  const { items } = input;
  const from = range?.from ?? 0;
  const to = range?.to ?? items.length;
  if (input.earlier && from === 0) keep({ kind: "earlier", key: "earlier", sig: input.earlier, text: input.earlier });

  const groups = range?.carry ? [...range.carry.groups] : [];
  /** The turn is over: say what it did, once, before whatever comes next. */
  const flush = (lastId: number): void => {
    const effects = mergeEffects(groups);
    groups.length = 0;
    if (effects) keep({ kind: "effects", key: `fx:${lastId}`, sig: effectsSig(effects), effects });
  };

  let i = from;
  while (i < to) {
    const item = items[i]!;
    if (isMember(items, i)) {
      let end = i;
      while (end < to && isMember(items, end)) end += 1;
      const group = items.slice(i, end);
      const key = workKey(item.id);
      const open = input.open.get(key) ?? false;
      const after = items[end];
      const summary = summarize(group);
      const s = summary;
      groups.push(contribute(group, input.cwd));
      keep({
        kind: "work",
        key,
        sig: `${open}|${s.steps}|${s.reads}|${s.searches}|${s.fetches}|${s.commands}|${s.changed}|${s.failed}|${s.unfinished}|${s.added}|${s.removed}`,
        work: { id: item.id, open, summary },
      });
      if (open) {
        group.forEach((member, at) => {
          const mkey = itemKey(member.id);
          const mopen = input.open.get(mkey) ?? false;
          if (member.kind === "message" && member.role !== "thought") {
            if ((member.text ?? "").trim() !== "")
              keep({ kind: "narration", key: mkey, sig: `${member.rev}`, item: member });
          } else if (member.kind === "message") {
            const secs = spanSeconds(member, member, group[at + 1] ?? after, input.nowMs);
            keep({
              kind: "thought",
              key: mkey,
              sig: `${member.rev}|${mopen}|${secs}`,
              item: member,
              open: mopen,
              seconds: secs,
            });
          } else {
            const all = input.open.get(moreKey(member.id)) ?? false;
            const isCall = (m: SessionItem | undefined) => m !== undefined && m.kind !== "message";
            const before = isCall(group[at - 1]);
            const next = isCall(group[at + 1]);
            const edge: Edge = before ? (next ? "mid" : "last") : next ? "first" : "only";
            keep({
              kind: "tool",
              key: mkey,
              sig: `${member.rev}|${mopen}|${all}|${edge}`,
              item: member,
              open: mopen,
              all,
              edge,
            });
          }
        });
      }
      i = end;
      continue;
    }
    const key = itemKey(item.id);
    if (item.kind === "message" && item.role === "user") {
      if (i > 0) flush(items[i - 1]!.id);
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
      // How long a turn took is not news and a replay has no times: a turn that ended well draws nothing; one that
      // failed says so.
      if (item.ok === false) keep({ kind: "note", key, sig: `${item.rev}`, item });
    } else {
      // A kind this app does not know yet (or a tool with nothing in it): a quiet generic row, never a crash.
      keep({ kind: "other", key, sig: `${item.rev}`, item });
    }
    i += 1;
  }
  // The turn ends where the conversation does, unless it is still running.
  if (to === items.length && !input.running && items.length > 0) flush(items[items.length - 1]!.id);
  if (range?.carry) range.carry.groups = groups;
  return rows;
}

/** Where the unit that holds item `index` starts: a work group starts at its first member, anything else at itself. */
export function unitStart(items: readonly SessionItem[], index: number): number {
  let at = Math.max(0, Math.min(index, items.length - 1));
  if (items.length > 0 && isMember(items, at)) while (at > 0 && isMember(items, at - 1)) at -= 1;
  return at;
}
