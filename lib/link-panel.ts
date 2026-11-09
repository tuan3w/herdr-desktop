import { signal } from "nsh";

import type { Accessor } from "nsh";

/**
 * The side panel a pressed link opens in, beside a chat or a terminal (`components/link-panel.tsx`, `design/files.md`):
 * one per surface, replaced by the next link, closed by `Close` or Escape, and remembered nowhere (not across tabs, not
 * across launches). A surface without one (the Files tab's Markdown) opens links the old way.
 */

/** Its width beside the conversation: a page or a file needs more than the inspector's list of rows. */
export const LINK_PANEL_WIDTH = 460;

/** What the panel shows. */
export type PanelLink =
  /** A web page. `machine` is set for a page of a remote machine's own `localhost`, reached through a tunnel (`Pages`). */
  | { kind: "web"; url: string; machine?: string }
  /** A file of a machine, at `line` when the link named one. */
  | { kind: "file"; machine: string; path: string; line?: number }
  /** A picture of a machine, fitted. `uri` is its bytes when a thumbnail already holds them, so they are not read again. */
  | { kind: "picture"; machine: string; path: string; uri?: string };

/** One surface's panel. */
export interface LinkPanel {
  /** What it shows, `null` while closed. */
  link: Accessor<PanelLink | null>;
  /** Shows `link`, in place of what it showed. */
  show: (link: PanelLink) => void;
  close: () => void;
}

export function createLinkPanel(): LinkPanel {
  const link = signal<PanelLink | null>(null);
  // A fresh object each time: the same link pressed again loads it again.
  return { link, show: (next) => link.set({ ...next }), close: () => link.set(null) };
}
