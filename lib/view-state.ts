import { Storage } from "nsh";

import type { Ref } from "#lib/composer-refs";
import { save } from "#lib/save";

/**
 * What a tab keeps that a layout swap would lose. The workspace shows one project's tabs at a time (`lib/dock.ts`): the
 * tabs of the project left are unmounted, and `DockArea` drops everything a panel held (its input text, its scroll
 * offset) when a layout no longer lists it. A composer and a chat list therefore read and write here, by their panel key,
 * and find what they held when the project is shown again.
 *
 * - **Drafts** are text the person has not sent. They can hold something pasted that must not be written down (a token),
 *   so they live in memory only: they survive a project switch and never a restart. Pictures a draft holds are files in
 *   the app's own folder (`Compose.preparePicture`), removed by age.
 * - **Scroll anchors** of chats are two numbers per tab and are kept in `Storage` (`herdr.views.v1`) so a chat comes back
 *   where it was left after a restart as well. A terminal pane has none: it is live, and a restored pane tab is a fresh
 *   mirror of the same pane.
 */

export const VIEWS_KEY = "herdr.views.v1";
/** Anchors kept: the newest by write. A chat tab is a few bytes; this is a bound, not a budget. */
export const ANCHOR_CAP = 200;
/** Quiet time before the anchors are written: a chat reports its scroll on every frame of a drag. */
export const SAVE_DELAY_MS = 500;

/**
 * What a message box held: the words, the files chosen with `+` or a drop and not yet sent (a chat only), and every
 * mention, picture and long paste the box made (`lib/composer-refs.ts`; their tokens are in `text`). The refs are kept
 * with the words so a project switch brings the chips back with them.
 */
export interface Draft {
  text: string;
  files: string[];
  refs: Ref[];
}

/** Where a chat was left: at the end (it follows new messages), or this many points above the end of its content. */
export interface Anchor {
  atEnd: boolean;
  fromEnd: number;
}

const drafts = new Map<string, Draft>();
const anchors = new Map<string, Anchor>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** The unsent message of a tab, `undefined` when it has none. */
export const draftOf = (key: string): Draft | undefined => drafts.get(key);

/** Remembers a tab's unsent message; an empty one forgets it. */
export function setDraft(key: string, draft: Draft): void {
  if (draft.text === "" && draft.files.length === 0 && draft.refs.length === 0) drafts.delete(key);
  else drafts.set(key, draft);
}

/** The chat's last scroll position, `undefined` when it has none. */
export const anchorOf = (key: string): Anchor | undefined => anchors.get(key);

/** Remembers where a chat is, and writes the anchors once the scrolling goes quiet. */
export function setAnchor(key: string, anchor: Anchor): void {
  const before = anchors.get(key);
  if (before && before.atEnd === anchor.atEnd && Math.abs(before.fromEnd - anchor.fromEnd) < 1) return;
  // Newest last, so the cap drops the oldest.
  anchors.delete(key);
  anchors.set(key, anchor);
  while (anchors.size > ANCHOR_CAP) anchors.delete(anchors.keys().next().value as string);
  clearTimeout(timer);
  timer = setTimeout(() => save(VIEWS_KEY, serialize()), SAVE_DELAY_MS);
}

/** Forgets what a tab held (its pane or session is gone). */
export function forgetView(key: string): void {
  drafts.delete(key);
  if (anchors.delete(key)) save(VIEWS_KEY, serialize());
}

const serialize = (): string => JSON.stringify({ v: 1, anchors: Object.fromEntries(anchors) });

/** The anchors a file holds; anything unreadable is nothing. Pure, for the test. */
export function readAnchors(raw: string | null | undefined): [string, Anchor][] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const table = typeof parsed === "object" && parsed !== null && "anchors" in parsed ? parsed.anchors : null;
    if (typeof table !== "object" || table === null) return [];
    return Object.entries(table).flatMap(([key, a]) => {
      const at = a as Partial<Anchor> | null;
      return typeof at?.atEnd === "boolean" && typeof at.fromEnd === "number" && Number.isFinite(at.fromEnd)
        ? [[key, { atEnd: at.atEnd, fromEnd: Math.max(0, at.fromEnd) }] as [string, Anchor]]
        : [];
    });
  } catch {
    return [];
  }
}

/** Reads the saved anchors once; a storage failure leaves none. */
export async function loadViews(): Promise<void> {
  try {
    for (const [key, anchor] of readAnchors(await Storage.getItem(VIEWS_KEY))) anchors.set(key, anchor);
  } catch (e) {
    console.error("herdr-desktop: cannot read the saved scroll positions", e);
  }
}
