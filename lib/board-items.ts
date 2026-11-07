import type { BoardData, BoardRow } from "herdr-desktop/native";
import type { SectionId } from "./sidebar";

/** One line of the board's list. The list is virtualized and recycles its cells, so a line is plain data. */
export type BoardItem =
  | { kind: "header"; key: string; section: SectionId; title: string; foldable: boolean; folded: boolean; note: string }
  | { kind: "card"; key: string; row: BoardRow }
  | { kind: "row"; key: string; row: BoardRow }
  | { kind: "more"; key: string; text: string; open: boolean };

const TITLES: Record<SectionId, string> = { needsYou: "Needs you", toReview: "To review", working: "Working", idle: "Idle" };

/** The first two names behind `22 more idle`, so the person knows whether what they look for is there. */
function moreText(rest: readonly BoardRow[]): string {
  const names = rest.slice(0, 2).map((r) => r.name).join(", ");
  return `${rest.length} more idle${names ? `: ${names}${rest.length > 2 ? "…" : ""}` : ""}`;
}

/**
 * The lines of the board, top to bottom: `Needs you` (never folds; every agent that can be answered is a card, the ones
 * out of reach are dimmed rows), `To review`, `Working`, `Idle` (the five newest, the rest behind one line that opens
 * them in place). Empty sections have no header.
 */
export function boardItems(data: BoardData, foldedSections: readonly SectionId[], showRestOfIdle: boolean): BoardItem[] {
  const out: BoardItem[] = [];
  const add = (section: SectionId, rows: readonly BoardRow[], note: string, kind: (r: BoardRow) => "card" | "row") => {
    if (rows.length === 0) return;
    const foldable = section !== "needsYou";
    const isFolded = foldable && foldedSections.includes(section);
    out.push({ kind: "header", key: `h:${section}`, section, title: TITLES[section], foldable, folded: isFolded, note });
    if (isFolded) return;
    for (const row of rows) out.push({ kind: kind(row), key: row.key, row });
  };
  const offlineWaiting = data.needsYou.filter((r) => r.offline).length;
  add("needsYou", data.needsYou, offlineWaiting > 0 ? `${offlineWaiting} offline` : "", (r) => (r.offline ? "row" : "card"));
  add("toReview", data.toReview, "", () => "row");
  add("working", data.working, "", () => "row");
  const idleFolded = foldedSections.includes("idle");
  add("idle", showRestOfIdle ? [...data.idle, ...data.idleRest] : data.idle, `${data.counts.idle}`, () => "row");
  if (!idleFolded && data.idleRest.length > 0) {
    out.push({ kind: "more", key: "more:idle", text: showRestOfIdle ? "Show less" : moreText(data.idleRest), open: showRestOfIdle });
  }
  return out;
}

