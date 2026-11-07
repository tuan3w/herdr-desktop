import type { BoardData, BoardProject, BoardRow } from "herdr-desktop/native";
import { shownRows } from "./sidebar";

/**
 * What the home lays out, as plain data: the `Needs you` strip, then the projects as cards in lines of one or two.
 * The projects come in the board's order (pinned, then by name) and are never regrouped by state: a card that starts
 * needing you gets a louder header, it does not move.
 */

/** Agents the strip answers in place; the rest wait behind `Answer one by one`. */
export const STRIP_SHOWN = 1;
/** A project with this many listed agents takes the whole width instead of half of it. */
export const WIDE_ROWS = 6;
/** The home is two columns from this width (points of the home itself, not of the window). */
export const TWO_COLUMNS_FROM = 760;

/** The agents waiting for an answer that the strip shows, longest waiting first, and how many more wait. */
export interface Strip {
  rows: BoardRow[];
  more: number;
}

/** The strip's agents: those that need you and can be answered (a machine that is not connected cannot). */
export function strip(data: BoardData): Strip {
  const waiting = data.needsYou.filter((r) => !r.offline);
  return { rows: waiting.slice(0, STRIP_SHOWN), more: Math.max(0, waiting.length - STRIP_SHOWN) };
}

/** One line of cards. */
export interface HomeLine {
  key: string;
  projects: BoardProject[];
  /** A card that takes the line alone because it lists many agents (or the home is one column). */
  alone: boolean;
}

/**
 * The projects in lines: one per line in a narrow home; two per line in a wide one, except that a project listing many
 * agents (`WIDE_ROWS`) takes a line to itself. A card's place depends only on the cards before it, so nothing before
 * the one that changed moves.
 */
export function homeLines(projects: readonly BoardProject[], columns: 1 | 2, opened: readonly string[], folds: readonly string[]): HomeLine[] {
  const lines: HomeLine[] = [];
  let pending: BoardProject[] = [];
  const flush = () => {
    if (pending.length > 0) lines.push({ key: pending.map((p) => p.key).join("+"), projects: pending, alone: false });
    pending = [];
  };
  for (const project of projects) {
    const listed = folds.includes(project.key) ? 0 : shownRows(project.rows, opened.includes(project.key)).shown.length;
    if (columns === 1 || listed >= WIDE_ROWS) {
      flush();
      lines.push({ key: project.key, projects: [project], alone: true });
      continue;
    }
    pending.push(project);
    if (pending.length === 2) flush();
  }
  flush();
  return lines;
}
