import { effect, signal, Storage } from "nsh";
import type { BoardData, BoardRow } from "herdr-desktop/native";
import { save } from "./save";
import { statusText } from "./status";
import { fold } from "./text";

/**
 * What the sidebar lists and how it reads it aloud. The list is the board's sections in the board's order, so the
 * sidebar and the board never disagree about who needs you; folding a section or the search narrows it, nothing else.
 */
export type SectionId = "needsYou" | "toReview" | "working" | "idle";

export const SECTIONS: { id: SectionId; title: string }[] = [
  { id: "needsYou", title: "Needs you" },
  { id: "toReview", title: "To review" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle" },
];

/** One line of the list. The list is virtualized, so a line is plain data and its view keeps no state. */
export type SidebarItem =
  | { kind: "header"; key: string; section: SectionId; title: string; count: number; folded: boolean; foldable: boolean }
  | { kind: "row"; key: string; row: BoardRow }
  | { kind: "more"; key: string; count: number; open: boolean };

const KEY = "herdr.sidebar.v1";

/** The sidebar's width in points: the person drags its edge, and a compact window overrides it with the rail. */
export const SIDEBAR_WIDTH = { default: 280, min: 200, max: 480 };
export const sidebarWidth = signal(SIDEBAR_WIDTH.default);

/** Sections the person folded. `needsYou` is never in it: what needs you stays in view. */
export const folded = signal<readonly SectionId[]>([]);
/** Whether the idle agents beyond the five newest are listed. */
export const idleOpen = signal(false);
export const sidebarReady = signal(false);

export function toggleFold(section: SectionId): void {
  if (section === "needsYou") return;
  folded.update((all) => (all.includes(section) ? all.filter((s) => s !== section) : [...all, section]));
}

export async function loadSidebar(): Promise<void> {
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (typeof saved === "object" && saved !== null) {
        if ("folded" in saved && Array.isArray(saved.folded)) {
          folded.set(saved.folded.filter((s): s is SectionId => s === "toReview" || s === "working" || s === "idle"));
        }
        if ("width" in saved && typeof saved.width === "number" && saved.width >= SIDEBAR_WIDTH.min && saved.width <= SIDEBAR_WIDTH.max) {
          sidebarWidth.set(saved.width);
        }
      }
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read the sidebar state", e);
  }
  sidebarReady.set(true);
}

effect(() => {
  const state = { folded: folded(), width: sidebarWidth() };
  if (sidebarReady()) save(KEY, JSON.stringify(state));
});

/** Whether `row` answers `query`: every word of it appears in the name, agent, machine or folder, ignoring case and accents. */
export function matches(row: BoardRow, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(`${row.name} ${row.agent} ${row.machineName} ${row.cwd ?? ""}`);
  return words.every((w) => hay.includes(w));
}

/**
 * The lines to show. A search lists every match of every section (open, without the idle cut: a hit must not hide
 * behind `22 more idle`) and drops sections with no match.
 */
export function sidebarItems(data: BoardData, query: string, foldedSections: readonly SectionId[], showRestOfIdle: boolean): SidebarItem[] {
  const searching = fold(query).trim() !== "";
  const out: SidebarItem[] = [];
  for (const { id, title } of SECTIONS) {
    const rows = id === "idle" ? [...data.idle, ...data.idleRest] : data[id];
    const hits = searching ? rows.filter((r) => matches(r, query)) : rows;
    if (hits.length === 0) continue;
    const foldable = id !== "needsYou" && !searching;
    const isFolded = foldable && foldedSections.includes(id);
    out.push({ kind: "header", key: `h:${id}`, section: id, title, count: hits.length, folded: isFolded, foldable });
    if (isFolded) continue;
    const shown = id === "idle" && !searching && !showRestOfIdle ? hits.slice(0, data.idle.length) : hits;
    for (const row of shown) out.push({ kind: "row", key: row.key, row });
    if (id === "idle" && !searching && hits.length > shown.length) {
      out.push({ kind: "more", key: "more:idle", count: hits.length - shown.length, open: false });
    } else if (id === "idle" && !searching && showRestOfIdle && data.idleRest.length > 0) {
      out.push({ kind: "more", key: "more:idle", count: data.idleRest.length, open: true });
    }
  }
  return out;
}

/** How long, as a glance wants it: `just now`, `4 min`, `2 h`, `3 d`. Empty when herdr gave no time. */
export function ageText(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} d`;
}

/** What a screen reader says for a row: `<name>, <agent>, <status>, <machine>, <age>`, plus `offline` when the last state is all we know. */
export function rowLabel(row: BoardRow): string {
  return [row.name, row.agent, statusText(row.status, row.reviewed), row.machineName, ageText(row.sinceSecs), row.offline ? "offline" : ""].filter(Boolean).join(", ");
}
