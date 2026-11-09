import type { SubagentProgress, SubagentProgressStatus, ToolItem } from "herdr-desktop/native";

import { durationText, oneLine, shortPath, visibleText } from "#lib/session-text";

/**
 * What the subagent card says about the subagents of one `task` call (omp sends how far each has got with every update:
 * `ToolItem.progress`). Pure words and counts: the card draws them, the list's height estimate counts them, a screen
 * reader says them. Times are what omp last reported (`durationMs`), not a clock of ours, so a line never ticks between
 * two updates and an app at rest draws no frames.
 */

/** The subagents of a call, empty for any other call. */
export const subagentsOf = (tool: ToolItem): readonly SubagentProgress[] => tool.progress ?? [];

/** How tall one subagent's line is, and the space the block of lines takes under the card's header. */
export const SUBAGENT_LINE_PT = 24;
const SUBAGENT_LINES_PAD_PT = 8;

/** How tall `lines` subagent lines draw, for the list's height estimate (`rowPt`). */
export const subagentLinesPt = (lines: number): number =>
  lines > 0 ? SUBAGENT_LINE_PT * lines + SUBAGENT_LINES_PAD_PT : 0;

/** Whether the subagent has work left: it was asked for or is running. */
export const isActive = (status: SubagentProgressStatus): boolean => status === "pending" || status === "running";

/** Whether any subagent of the call is still working: the lines stay in view while this holds. */
export const anyActive = (list: readonly SubagentProgress[]): boolean => list.some((a) => isActive(a.status));

/** How many lines the card draws under its header: all while one works or the person opened the card, else none. */
export const linesShown = (list: readonly SubagentProgress[], open: boolean): number =>
  list.length > 0 && (open || anyActive(list)) ? list.length : 0;

/** `running`, `done`, `failed`, `stopped`, `waiting`: one word for a screen reader (the line shows a mark). */
export function subagentStatusText(status: SubagentProgressStatus): string {
  switch (status) {
    case "pending":
      return "waiting";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "aborted":
      return "stopped";
  }
}

/** The verb of omp's tool names that read as a sentence while the tool runs and after it ran; any other tool is shown as omp names it. */
const VERBS: Record<string, readonly [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"],
  bash: ["Running", "Ran"],
  grep: ["Searching", "Searched"],
};

/**
 * One tool of a subagent as a phrase: omp's `read lib/auth.ts` is `Reading lib/auth.ts` while it runs and `Read lib/auth.ts`
 * after. A path inside the session's folder is cut to the folder (`shortPath`), the rest is as omp sent it.
 */
export function toolPhrase(raw: string, running: boolean, cwd?: string | null): string {
  const text = visibleText(raw).trim();
  const space = text.indexOf(" ");
  const tool = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space + 1).trim();
  const subject = rest.startsWith("/") ? shortPath(rest, cwd) : rest;
  const verb = VERBS[tool.toLowerCase()]?.[running ? 0 : 1] ?? tool;
  return oneLine([verb, subject].filter(Boolean).join(" "), 120);
}

/** What the subagent does now (its tool, as a phrase), else the last tool it finished; empty when omp says neither. */
export function subagentDoing(a: SubagentProgress, cwd?: string | null): string {
  if (a.currentTool && isActive(a.status)) return toolPhrase(a.currentTool, true, cwd);
  const last = a.recentTools.at(-1);
  return last ? toolPhrase(last, false, cwd) : "";
}

/** `12 tools`, `1 tool`; empty when it has called none. */
export const toolCountText = (n: number): string => (n <= 0 ? "" : `${n} ${n === 1 ? "tool" : "tools"}`);

/** `1m 4s`; empty when omp reported no time yet. */
export const subagentTime = (a: SubagentProgress): string =>
  a.durationMs > 0 ? durationText(a.durationMs / 1000) : "";

/** What the line says to a screen reader, in one label: `Subagent audit, running, Reading auth.ts, 12 tools, 1m 4s`. */
export function subagentLabel(a: SubagentProgress, cwd?: string | null): string {
  return [
    `Subagent ${visibleText(a.name)}`,
    subagentStatusText(a.status),
    subagentDoing(a, cwd),
    toolCountText(a.toolCount),
    subagentTime(a),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The muted summary of a card whose subagents are all done: `3 subagents, 2m 10s` (the longest of them: they run side by
 * side), with `1 failed` and `1 stopped` said when it happened. Empty while one still works.
 */
export function subagentSummary(list: readonly SubagentProgress[]): string {
  if (list.length === 0 || anyActive(list)) return "";
  const failed = list.filter((a) => a.status === "failed").length;
  const stopped = list.filter((a) => a.status === "aborted").length;
  const longest = Math.max(...list.map((a) => a.durationMs));
  return [
    `${list.length} ${list.length === 1 ? "subagent" : "subagents"}`,
    failed ? `${failed} failed` : "",
    stopped ? `${stopped} stopped` : "",
    longest > 0 ? durationText(longest / 1000) : "",
  ]
    .filter(Boolean)
    .join(", ");
}
