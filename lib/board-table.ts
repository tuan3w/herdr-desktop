import type { BoardCounts, BoardData, BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";

import { projectLines } from "#lib/sidebar";

/**
 * What the board's table lists, as plain data for a virtualized list: per project a header, its agents and the idle
 * fold's line. The projects, their order, folds, pins and the idle fold are `projectLines`, the same the sidebar reads,
 * so the two lists never disagree; this adds the state filter (the chips) and the text of the `Last` column.
 */

/** The chips: one state or all. A chip pressed again goes back to `all`. */
export type BoardFilter = "all" | "blocked" | "working" | "done" | "idle";

/** The chips in the order they are drawn, with the words they carry (`Need you, 2` is the accessible name). */
export const CHIPS: readonly { filter: Exclude<BoardFilter, "all">; label: string }[] = [
  { filter: "blocked", label: "Need you" },
  { filter: "working", label: "Working" },
  { filter: "done", label: "To review" },
  { filter: "idle", label: "Idle" },
];

/** One line of the table. A line is plain data and its view keeps no state: the list recycles cells. */
export type TableItem =
  | {
      kind: "project";
      key: string;
      project: BoardProject;
      folded: boolean;
      /** The machine's name for the header, or null for this computer. */
      machine: string | null;
      /** The machine is not online: its name is amber and its rows are dashed. */
      stale: boolean;
      /** How many agents the project lists (what a folded header hides). */
      count: number;
    }
  | { kind: "row"; key: string; project: string; row: BoardRow; stale: boolean; last: string }
  | { kind: "more"; key: string; project: string; count: number; open: boolean };

/**
 * Whether `row` is in the state `filter` names. The same rule as the engine's counts: an agent on a machine that is not
 * connected is in no state chip (only in `all`), so a chip's number is how many its filter lists.
 */
export function inFilter(row: BoardRow, filter: BoardFilter): boolean {
  if (filter === "all") return true;
  if (row.offline) return false;
  return filter === "idle" ? row.status === "idle" || row.status === "unknown" : row.status === filter;
}

/** The engine's count for a chip. */
export function chipCount(counts: BoardCounts, filter: Exclude<BoardFilter, "all">): number {
  switch (filter) {
    case "blocked":
      return counts.needsYou;
    case "working":
      return counts.working;
    case "done":
      return counts.toReview;
    case "idle":
      return counts.idle;
  }
}

/**
 * The `Last` column: the first line of what a blocked terminal asks (the agent stopped there, and nothing else it printed
 * matters until it is answered), else what a chat's agent said last. Empty when neither is known: herdr gives no time of
 * the last output, so the table never invents one.
 */
export function lastText(row: BoardRow): string {
  const question = row.status === "blocked" && !row.session ? row.prompt?.question.split("\n")[0].trim() : undefined;
  return question || row.lastMessage || "";
}

/**
 * The table's lines for `filter`. With a state chip every idle agent is listed (the idle fold is for the unfiltered
 * inventory), without one the idle fold applies as in the sidebar; folds apply either way.
 */
export function tableItems(
  data: BoardData,
  statuses: readonly MachineStatus[],
  filter: BoardFilter,
  folds: readonly string[],
  opened: readonly string[],
): TableItem[] {
  const out: TableItem[] = [];
  const lines = projectLines(data, statuses, {
    keep: filter === "all" ? undefined : (row) => inFilter(row, filter),
    folds,
    opened: filter === "all" ? opened : true,
  });
  for (const line of lines) {
    const { project } = line;
    out.push({
      kind: "project",
      key: `p:${project.key}`,
      project,
      folded: line.folded,
      machine: line.machine,
      stale: line.stale,
      count: line.kept.length,
    });
    for (const row of line.shown)
      out.push({ kind: "row", key: row.key, project: project.key, row, stale: line.stale, last: lastText(row) });
    if (line.more) out.push({ kind: "more", key: `m:${project.key}`, project: project.key, ...line.more });
  }
  return out;
}
