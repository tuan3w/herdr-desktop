import type { PhaseName, SessionItem, SessionView, ToolItem, ToolStatusName } from "herdr-desktop/native";

import type { IconName } from "#kit";
import { AGENT_KINDS } from "#lib/agent-kinds";

/**
 * What the chat says in words, kept out of the screens so the same sentence is spoken, shown and tested once: tool
 * lines, durations, labels for a screen reader. Nothing here reads the Sessions module.
 */

/** How the person calls an agent: `Claude Code`, else the route id. */
export const agentName = (agent: string): string => AGENT_KINDS.find((a) => a.kind === agent)?.title ?? agent;

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// C0 and C1 controls except tab and newline: an agent's output can carry an escape sequence, which draws nothing and hides text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const hex = (c: string): string => `‹U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`;

/**
 * Text an agent sent, made safe to show: direction overrides and control characters become `‹U+202E›`, because a command
 * written with a right-to-left override reads as another command, and a person approves what they read. Everything
 * the chat shows of a tool call goes through it.
 */
export const visibleText = (s: string): string => s.replace(BIDI, hex).replace(CONTROL, hex);

/**
 * A call that started another agent (a worker, a reviewer): shown as its own bordered line, outside the fold of the
 * work around it, because what it hands back is a result the person reads, not a step they skim. Agents name these
 * calls `task`, `subagent` or `agent`.
 */
export const isSubagent = (tool: ToolItem): boolean =>
  tool.toolKind === "task" || tool.toolKind === "subagent" || tool.toolKind === "agent";

/** The first `max` characters on one line, with an ellipsis when it was cut. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** `4s`, `1m 12s`, `2h 3m`: whole seconds in the shortest honest form. */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** `path` relative to `cwd` when it is inside it, else with the home folder as `~`; the file name is never cut. */
export function shortPath(path: string, cwd: string | null | undefined): string {
  const folder = cwd ? cwd.replace(/\/+$/, "") : "";
  if (folder && path.startsWith(`${folder}/`)) return path.slice(folder.length + 1);
  return path;
}

/** The tool kinds with an icon of their own; anything else the agent names falls to `other`. */
export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other";

const KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  execute: "execute",
  search: "search",
  fetch: "fetch",
  think: "think",
};

/** Which of the known kinds a tool is; a kind the agent does not say, or one this app does not know, is `other`. */
export const toolKindOf = (tool: ToolItem): ToolKind => KINDS[tool.toolKind ?? ""] ?? "other";

const ICONS: Record<ToolKind, IconName> = {
  read: "file",
  edit: "pencil",
  execute: "terminal",
  search: "search",
  fetch: "globe",
  think: "lightbulb",
  other: "list",
};

/** The kit icon of a tool kind. */
export const toolIcon = (kind: ToolKind): IconName => ICONS[kind];

/** Lines an edit added and removed, summed over the files a call changed. */
export function diffStat(tool: ToolItem): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of tool.diffs) {
    added += d.added;
    removed += d.removed;
  }
  return { added, removed };
}

/** The words a status has for a person and for a screen reader. */
export function toolStatusText(status: ToolStatusName): string {
  switch (status) {
    case "pending":
      return "waiting";
    case "inProgress":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
  }
}

/** One quiet line for a tool call: a verb, what it acted on (monospace), and the edit's size. */
export interface ToolLine {
  kind: ToolKind;
  /** `Read`, `Ran`; empty when the agent's title already says it all. */
  verb: string;
  /** The command, path or title, on one line. */
  object: string;
  added: number;
  removed: number;
}

const VERBS: Record<ToolKind, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  execute: ["Running", "Ran"],
  search: ["Searching", "Searched"],
  fetch: ["Fetching", "Fetched"],
  think: ["Thinking", "Thought"],
  other: ["", ""],
};

/**
 * `Read src/main.rs`, `Edited CHANGELOG.md +6`, `Running pnpm test`. The verb is only added when the agent said what
 * the call acts on (`subject`): without it the agent's title is the whole line, as the agent worded it. A new file reads
 * `Created`.
 */
export function toolLine(tool: ToolItem, cwd?: string | null): ToolLine {
  const kind = toolKindOf(tool);
  const live = tool.status === "pending" || tool.status === "inProgress";
  const subject = tool.subject?.trim();
  const { added, removed } = diffStat(tool);
  const first = tool.diffs[0];
  const target = subject || (kind === "edit" && first ? first.path : "");
  if (!target || kind === "other")
    return { kind, verb: "", object: oneLine(visibleText(tool.title), 160), added, removed };
  const [doing, did] = VERBS[kind];
  const created = kind === "edit" && tool.diffs.length > 0 && tool.diffs.every((d) => d.old == null);
  const verb = live ? doing : created ? "Created" : did;
  const shown = kind === "read" || kind === "edit" ? shortPath(target, cwd) : target;
  return { kind, verb, object: oneLine(visibleText(shown), 160), added, removed };
}

/** What the transcript's row for `item` says to a screen reader: who spoke, then the start of what they said. */
export function itemLabel(item: SessionItem, cwd?: string | null): string {
  const said = (text: string | null | undefined, n: number) => oneLine(visibleText(text ?? ""), n);
  if (item.kind === "message") {
    if (item.role === "user") return `You: ${said(item.text, 200)}`;
    if (item.role === "thought") return "Thought";
    return `Agent: ${said(item.text, 200)}`;
  }
  if (item.kind === "tool" && item.tool) {
    const line = toolLine(item.tool, cwd);
    return `Tool: ${[line.verb, line.object].filter(Boolean).join(" ")}, ${toolStatusText(item.tool.status)}`;
  }
  if (item.kind === "done") return `${item.ok === false ? "Turn failed" : "Turn done"}: ${said(item.text, 200)}`;
  const title = item.title ? said(item.title, 80) : "";
  const text = said(item.text, 200);
  return [title, text].filter(Boolean).join(": ") || "Update";
}

/** Phase in words, for the header and the status glyph's label. */
export function phaseText(view: Pick<SessionView, "phase" | "connectionLost">): string {
  if (view.connectionLost) return "Not connected";
  const words: Record<PhaseName, string> = {
    connecting: "Opening",
    idle: "Ready",
    working: "Working",
    blockedOnPermission: "Needs you",
    blockedOnQuestion: "Needs you",
    authRequired: "Sign in needed",
    ended: "Ended",
  };
  return words[view.phase];
}

/** The status shape a phase wears, in the vocabulary of `StatusGlyph`. */
export function phaseStatus(
  view: Pick<SessionView, "phase" | "connectionLost">,
): "blocked" | "working" | "idle" | "unknown" {
  if (view.connectionLost) return "unknown";
  switch (view.phase) {
    case "blockedOnPermission":
    case "blockedOnQuestion":
    case "authRequired":
      return "blocked";
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "connecting":
    case "ended":
      return "unknown";
  }
}

/** Why the composer is off, or `null` when it takes a message. */
export function composerOff(view: Pick<SessionView, "phase" | "connectionLost" | "endedReason">): string | null {
  if (view.connectionLost) return "Not connected to the machine. Reconnect to carry on.";
  if (view.phase === "connecting") return "Opening the session…";
  if (view.phase === "authRequired") return "Sign in to the agent to carry on.";
  if (view.phase === "ended") return view.endedReason ? `Session ended: ${view.endedReason}` : "Session ended";
  return null;
}

/**
 * Arguments as one line to paste into a shell. A word with anything but plain characters is single-quoted, so what an
 * agent put in an argument can never become a second command. The result goes through `visibleText`: what the person
 * copies is what they read.
 */
export function shellLine(args: readonly string[]): string {
  const word = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return visibleText(args.map(word).join(" "));
}

/** The last `max` characters of `text` where a word starts, for an announcement of what just arrived. */
export function tailText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - max);
  // A cut in the middle of a word starts at the next whole one; a cut on a space is already clean.
  if (flat[flat.length - max - 1] === " " || cut.startsWith(" ")) return cut.trimStart();
  const space = cut.indexOf(" ");
  return space > 0 ? cut.slice(space + 1) : cut;
}

/** Lines of a tool's output shown before `Show all`. */
export const OUTPUT_LINES = 8;

/** What a tool's output panel shows. */
export interface OutputView {
  /** The lines to draw, safe to show. */
  lines: string[];
  /** Kept lines the panel is not showing yet (`Show all` brings them). */
  hidden: number;
  /** Lines the machine did not keep between the first and the last ones; said in the panel when it shows everything. */
  omitted: number;
}

/**
 * The output of a call: the first lines of a read or a search (what it found is at the top), the last of a command (how
 * it ended is at the bottom), all of what is kept once the person asks. The agent keeps a head and a tail only; the
 * lines between are `omitted` and the panel says so rather than splice them.
 */
export function outputView(tool: ToolItem, all: boolean): OutputView {
  const kept = [...tool.head, ...tool.tail].map(visibleText);
  if (all || kept.length <= OUTPUT_LINES) return { lines: kept, hidden: 0, omitted: tool.omitted };
  const lines = toolKindOf(tool) === "execute" ? kept.slice(kept.length - OUTPUT_LINES) : kept.slice(0, OUTPUT_LINES);
  return { lines, hidden: kept.length - OUTPUT_LINES, omitted: 0 };
}

/** What a work group's header counts, as plain parts: `3 commands`, `1 file changed`, `1 failed`. */
export function workParts(s: { steps: number; commands: number; changed: number; failed: number }): string[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (s.commands > 0) parts.push(plural(s.commands, "command", "commands"));
  if (s.changed > 0) parts.push(`${plural(s.changed, "file", "files")} changed`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  if (parts.length === 0) parts.push(plural(s.steps, "step", "steps"));
  return parts;
}

/** The header of a work group: `Worked for 4s`, `Working · 6s`; a replayed group has no time to say. */
export function workHead(w: { running: boolean; seconds: number | null }): string {
  if (w.running) return w.seconds === null ? "Working" : `Working · ${durationText(w.seconds)}`;
  return w.seconds === null ? "Worked" : `Worked for ${durationText(w.seconds)}`;
}

/** The tab's name for a session: the agent's own title once it has one, else the agent. */
export function sessionTitle(view: Pick<SessionView, "title"> | null, agent: string): string {
  const title = view?.title?.trim();
  return title ? title : agentName(agent);
}
