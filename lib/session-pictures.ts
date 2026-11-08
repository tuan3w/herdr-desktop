import { Sessions } from "herdr-desktop/native";
import { signal } from "nsh";

import type { ImageView } from "herdr-desktop/native";

/**
 * Pictures of a chat read from a terminal's log. The log does not carry their bytes, so a row fetches its pictures when
 * it is drawn (a virtual list draws only the rows near the window) and never more than the cap allows. A loaded one is
 * kept by what it is (`ImageView.key`), not where it was seen, so scrolling a row away and back does not fetch again;
 * only the last few are kept, because each is a whole picture in memory. A row asks once: one that was let go of
 * shows a tile that fetches it on a press, so a screen with more pictures than are kept never loops.
 */

/** The biggest picture shown, in bytes: the file viewer's cap (`PICTURE_DATA_CAP`), because it too is a `data:` address. */
export const PICTURE_CAP = 16 * 1024 * 1024;

/** Where one picture stands. */
export type PictureState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; uri: string }
  | { state: "large" }
  | { state: "failed"; message: string };

const KEPT = 8;
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

/** Where the bytes come from: the session's machine. Replaceable so a test needs no session. */
export const pictureSource = {
  fetch: (machine: string, id: string, source: string): Promise<string> => Sessions.logPicture(machine, id, source),
};

/** Fetches `image` from the session's machine once; a second call while it loads, or for a picture over the cap, does nothing. */
export async function loadPicture(machine: string, id: string, image: ImageView): Promise<void> {
  const now = pictureState(image.key).state;
  if (now === "loading" || now === "ready") return;
  if ((image.bytes ?? 0) > PICTURE_CAP) {
    set(image.key, { state: "large" });
    return;
  }
  set(image.key, { state: "loading" });
  try {
    const data = await pictureSource.fetch(machine, id, image.source);
    // Base64 is four characters for three bytes.
    if ((data.length * 3) / 4 > PICTURE_CAP) set(image.key, { state: "large" });
    else set(image.key, { state: "ready", uri: `data:${image.mime};base64,${data}` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    set(image.key, message.startsWith("Too large") ? { state: "large" } : { state: "failed", message });
  }
}

/**
 * `text` of a message that has `pictures` pictures, without the agent's own `[Image #55]` placeholders: the picture
 * stands where the placeholder was named. Left whole when there are more placeholders than pictures (one did not
 * come), so a name is never lost without its picture showing.
 */
export function withoutPlaceholders(text: string, pictures: number): string {
  const marks = text.match(PLACEHOLDERS) ?? [];
  if (pictures === 0 || marks.length === 0 || marks.length > pictures) return text;
  // Only the lines that held a placeholder are tidied: the indentation of the others is the person's.
  return text
    .split("\n")
    .map((line) => (PLACEHOLDER.test(line) ? tidy(line) : line))
    .join("\n")
    .trim();
}
const tidy = (line: string): string => line.replace(PLACEHOLDERS, "").replace(/ {2,}/g, " ").trim();
const PLACEHOLDER = /\[Image #\d+\]/;
const PLACEHOLDERS = new RegExp(PLACEHOLDER, "g");

/** `105 KB`, `1.4 MB`: what a picture weighs, as the line before loading it says. */
export function pictureSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
