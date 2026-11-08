import { signal } from "nsh";

import type { BackgroundRow, ObservedView, SubagentRow } from "herdr-desktop/native";

import { visibleText } from "#lib/session-text";
import { commandSubject } from "#lib/tool-subject";

/**
 * The rules of a chat's inspector (`components/session-inspector.tsx`): what a terminal agent runs beside its
 * conversation (its subagents and its background tasks) sorted into the three things a supervisor asks of it: does
 * anything need me (`Needs you`: a failure that arrived while the chat was open), is it alive (`Running`), and what
 * did it do (`Finished`, folded). Pure, except the one open/closed choice of this run.
 */

/** The inspector's width while it sits beside the chat; under `snug()` it lies over the chat at the same width. */
export const INSPECTOR_WIDTH = 320;
/** Its width while it shows a subagent's conversation beside the chat: prose needs more than a list of rows. */
export const INSPECTOR_READING_WIDTH = 400;

/** A stop of a task that has run longer than this is two presses (principle 2): press, then press again within `CONFIRM_MS`. */
export const CONFIRM_AFTER_MS = 60_000;
export const CONFIRM_MS = 4_000;

/** What one row stands for. */
export type EntryState = "running" | "done" | "failed" | "stopped";

/** One row of the inspector: a subagent, or a background task that is not a subagent's. */
export interface Entry {
  /** Stable within the chat: `sub:<name>` or `task:<key>`. */
  key: string;
  kind: "subagent" | "task";
  /** What the person reads: the subagent's name, or the task's cleaned subject (`pnpm test`, not `cd /x && pnpm test`). */
  name: string;
  /** One muted line: what it does now (its latest tools) or what it was asked (the first sentence); `""` for none. */
  line: string;
  state: EntryState;
  /** By the log's clock (ms since the epoch); absent when the log does not say, and then no time is shown. */
  startedMs?: number;
  endedMs?: number;
  /** The background task the person can ask to stop (`Sessions.stopBackground`), when there is a way. */
  stop?: string;
  /** For the tooltip and the drill-in: the agent type (`general-purpose`), the whole assignment or command. */
  agent: string;
  assignment: string;
  /** A subagent's name as the log gives it: what opens its transcript. */
  subagent?: string;
}

const RUNNING = new Set(["running", "inProgress", "in_progress", "pending", "paused"]);

function subagentState(status: string): EntryState {
  if (RUNNING.has(status)) return "running";
  if (status === "failed") return "failed";
  if (status === "aborted" || status === "stopped" || status === "cancelled") return "stopped";
  return "done";
}

function taskState(row: BackgroundRow): EntryState {
  if (row.active) return "running";
  if (row.status === "failed") return "failed";
  if (row.status === "stopped") return "stopped";
  return "done";
}

/**
 * The first sentence of an assignment, on one line: what a row says it was asked. The whole prompt is the drill-in's,
 * never a row's description.
 */
export function firstSentence(text: string): string {
  const flat = visibleText(text).replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end > 0 ? flat.slice(0, end + 1) : flat;
}

/** The task's words: a command as the chat's folded lines say it, else its title. */
function taskName(row: BackgroundRow): string {
  const title = visibleText(row.title).trim();
  if (row.kind === "shell" || row.kind === "terminal") {
    const subject = commandSubject(row.detail ?? row.title);
    if (subject) return visibleText(subject);
  }
  return title || row.kind;
}

/** Every row of an observed chat, in the log's order: subagents first, then the tasks that are not a subagent's. */
export function entriesOf(observed: Pick<ObservedView, "subagents" | "background">): Entry[] {
  const tasks = new Map(observed.background.map((b) => [b.key, b]));
  const ofSubagent = new Set<string>();
  const subs = observed.subagents.map((s: SubagentRow): Entry => {
    const task = s.task ? tasks.get(s.task) : undefined;
    if (s.task) ofSubagent.add(s.task);
    const state = subagentState(s.status);
    const tools = s.recentTools.map(visibleText).filter(Boolean);
    return {
      key: `sub:${s.name}`,
      kind: "subagent",
      name: visibleText(s.name),
      line: state === "running" && tools.length > 0 ? tools.slice(-3).join(" › ") : firstSentence(s.assignment),
      state,
      startedMs: s.startedMs ?? task?.startedMs ?? undefined,
      endedMs: s.endedMs ?? task?.endedMs ?? undefined,
      stop: task?.stoppable ? task.key : undefined,
      agent: visibleText(s.agent),
      assignment: visibleText(s.assignment),
      subagent: s.name,
    };
  });
  const rest = observed.background
    .filter((b) => !ofSubagent.has(b.key))
    .map((b): Entry => ({
      key: `task:${b.key}`,
      kind: "task",
      name: taskName(b),
      line: b.kind === "shell" || b.kind === "terminal" ? "" : firstSentence(b.detail ?? ""),
      state: taskState(b),
      startedMs: b.startedMs ?? undefined,
      endedMs: b.endedMs ?? undefined,
      stop: b.stoppable ? b.key : undefined,
      agent: b.kind,
      assignment: visibleText(b.detail ?? b.title),
    }));
  return [...subs, ...rest];
}

/** Finished rows of one name, newest last: `nvidia-smi ×3`. */
export interface FinishedGroup {
  name: string;
  entries: Entry[];
  /** The newest end time the log gives, when any. */
  lastMs?: number;
  /** One of them failed: the group says so with its mark. */
  failed: boolean;
}

export interface Sections {
  needs: Entry[];
  running: Entry[];
  finished: FinishedGroup[];
  /** How many finished rows (not groups). */
  finishedCount: number;
  /** The newest end among them, when the log gives one. */
  finishedLastMs?: number;
}

/**
 * The three sections. A failure is in `Needs you` until the person has seen it (`acknowledged` holds its key); one that
 * was already over when the chat opened is acknowledged from the start (`seedAcknowledged`): an old failure in a log
 * replayed today is history, not news.
 */
export function sectionsOf(entries: readonly Entry[], acknowledged: ReadonlySet<string>): Sections {
  const needs: Entry[] = [];
  const running: Entry[] = [];
  const groups = new Map<string, FinishedGroup>();
  let finishedCount = 0;
  let finishedLastMs: number | undefined;
  for (const e of entries) {
    if (e.state === "running") running.push(e);
    else if (e.state === "failed" && !acknowledged.has(e.key)) needs.push(e);
    else {
      finishedCount += 1;
      const g = groups.get(e.name) ?? { name: e.name, entries: [], failed: false };
      g.entries.push(e);
      g.failed ||= e.state === "failed";
      if (e.endedMs !== undefined && (g.lastMs === undefined || e.endedMs > g.lastMs)) g.lastMs = e.endedMs;
      groups.set(e.name, g);
      if (e.endedMs !== undefined && (finishedLastMs === undefined || e.endedMs > finishedLastMs))
        finishedLastMs = e.endedMs;
    }
  }
  // Newest first: what just ended is what the person looks for; groups without a time keep the log's order at the end.
  const finished = [...groups.values()].sort((a, b) => (b.lastMs ?? -1) - (a.lastMs ?? -1));
  return { needs, running, finished, finishedCount, finishedLastMs };
}

/** The keys of the failures that are over when the chat first shows them: history, never `Needs you`. */
export function seedAcknowledged(entries: readonly Entry[]): Set<string> {
  return new Set(entries.filter((e) => e.state === "failed").map((e) => e.key));
}

/** `<1m`, `4m`, `1h 12m`: how long a running row has run. */
export function elapsedText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** `just now`, `35 min ago`, `2 h ago`, `3 d ago`: when a finished row ended. */
export function agoText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** `Finished 26 · last 35 min ago`, or `Finished 26` when the log gives no end time. */
export function finishedLine(s: Pick<Sections, "finishedCount" | "finishedLastMs">, now: number): string {
  const head = `Finished ${s.finishedCount}`;
  return s.finishedLastMs === undefined ? head : `${head} · last ${agoText(now - s.finishedLastMs)}`;
}

/** `3 subagents running`, `1 subagent and 2 tasks running`: the chat's one quiet line while the inspector is closed. */
export function runningLine(running: readonly Entry[]): string {
  const subs = running.filter((e) => e.kind === "subagent").length;
  const tasks = running.length - subs;
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  const parts = [subs > 0 ? n(subs, "subagent") : "", tasks > 0 ? n(tasks, "background task") : ""].filter(Boolean);
  return parts.length === 0 ? "" : `${parts.join(" and ")} running`;
}

/** What a screen reader says of a row: its name, its state in words, its time and its line. */
export function entryLabel(e: Entry, now: number): string {
  const state =
    e.state === "running"
      ? e.startedMs !== undefined
        ? `running ${elapsedText(now - e.startedMs)}`
        : "running"
      : e.state === "failed"
        ? "failed"
        : e.state === "stopped"
          ? "stopped"
          : "finished";
  const when = e.state !== "running" && e.endedMs !== undefined ? agoText(now - e.endedMs) : "";
  return [e.name, state, when, e.line].filter(Boolean).join(", ");
}

/**
 * Whether the inspector is open, for every chat of this run: a person who opened it wants it in the next chat too. It
 * opens itself only when something needs the person (`Needs you`), and never closes by itself.
 */
export const inspectorOpen = signal(false);

/** A subagent to open in the inspector of the chat in front, once it mounts: `showSubagent`. */
export const pendingSubagent = signal<string | null>(null);

/** Opens the inspector of the chat in front on subagent `name`'s conversation (as the log names it). */
export function showSubagent(name: string): void {
  pendingSubagent.set(name);
  inspectorOpen.set(true);
}
