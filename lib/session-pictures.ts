import { Sessions } from "herdr-desktop/native";
import { signal } from "nsh";

import type { ImageView } from "herdr-desktop/native";

/**
 * Pictures of a chat read from a terminal's log. The log does not carry their bytes, so nothing is fetched until the
 * person presses `Load picture` (privacy and bandwidth: a picture can be 20 MB on a remote machine). A loaded one is
 * kept by what it is (`ImageView.key`), not where it was seen, so scrolling a row away and back does not fetch again;
 * only the last few are kept, because each is a whole picture in memory.
 */

/** Where one picture stands. */
export type PictureState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; uri: string }
  | { state: "failed"; message: string };

const KEPT = 6;
const IDLE: PictureState = { state: "idle" };
const states = signal<ReadonlyMap<string, PictureState>>(new Map());

/** The picture's state now (reactive). */
export const pictureState = (key: string): PictureState => states().get(key) ?? IDLE;

const set = (key: string, next: PictureState): void =>
  states.update((all) => {
    const copy = new Map(all);
    copy.delete(key);
    copy.set(key, next);
    // Oldest loaded pictures go first; one that is loading or failed costs nothing.
    const ready = [...copy].filter(([, s]) => s.state === "ready");
    for (const [old] of ready.slice(0, Math.max(0, ready.length - KEPT))) copy.delete(old);
    return copy;
  });

/** Fetches `image` from the session's machine once; a second press while it loads does nothing. */
export async function loadPicture(machine: string, id: string, image: ImageView): Promise<void> {
  if (pictureState(image.key).state === "loading") return;
  set(image.key, { state: "loading" });
  try {
    const data = await Sessions.logPicture(machine, id, image.source);
    set(image.key, { state: "ready", uri: `data:${image.mime};base64,${data}` });
  } catch (e) {
    set(image.key, { state: "failed", message: e instanceof Error ? e.message : String(e) });
  }
}

/** `105 KB`, `1.4 MB`: what a picture weighs, as the line before loading it says. */
export function pictureSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
