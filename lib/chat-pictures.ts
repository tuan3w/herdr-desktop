import { Files } from "herdr-desktop/native";
import { signal } from "nsh";

import { isPath } from "#lib/links";
import { searchFolders } from "#lib/open-files";

/**
 * Pictures an agent's Markdown names by path (`![after](./after.png)`), shown as thumbnails (`components/chat-picture.tsx`).
 * The bytes come through the file viewer's own reads, on the session's machine (over its ssh connection for another
 * machine), off the UI thread: `Files.find` resolves the path as a pressed link would, `Files.stat` weighs it, and
 * `Files.open` hands the picture as a `data:` address. A picture is kept by where it was named (machine, folder, address),
 * so a message drawn again, a streamed chunk or a recycled row does not fetch it again; only the last few are kept, because
 * each is a whole picture in memory. Its pixel size outlives it, so a picture fetched again reserves its final box.
 */

/** The heaviest picture shown in a message, in bytes; over it the message shows a chip that opens it in the side panel. */
export const THUMB_CAP = 8 * 1024 * 1024;
/** A thumbnail's widest, in points; a narrower picture keeps its own width. */
export const THUMB_WIDTH = 280;
/** The box held for a picture whose size is not known yet: it is drawn once it arrives, the text below moved once. */
export const THUMB_PLACEHOLDER = { width: 160, height: 100 } as const;

/** Where one picture stands. `path` is where it was found, for the panel. */
export type ThumbState =
  | { state: "loading" }
  | { state: "ready"; uri: string; path: string; bytes: number }
  | { state: "large"; path: string; bytes: number }
  | { state: "missing"; message: string; at: number }
  | { state: "failed"; path: string; message: string };

const KEPT = 12;
/** A path that was not there is looked for again after this long: an agent names a picture, then writes it. */
const MISSING_RETRY_MS = 10_000;
const SIZES_KEPT = 256;
const LOADING: ThumbState = { state: "loading" };
const states = signal<ReadonlyMap<string, ThumbState>>(new Map());
const sizes = new Map<string, { width: number; height: number }>();

/** The key of a picture named `src` in a message of `folder` on `machine`. */
export const thumbKey = (machine: string, folder: string, src: string): string =>
  `${machine}\u0000${folder}\u0000${src}`;

/** The picture's state now (reactive); a picture nobody asked for yet is `loading`. */
export const thumbState = (key: string): ThumbState => states().get(key) ?? LOADING;

const set = (key: string, next: ThumbState): void =>
  states.update((all) => {
    const copy = new Map(all);
    copy.delete(key);
    copy.set(key, next);
    // Oldest loaded pictures go first; one that is loading, large or failed costs nothing.
    const ready = [...copy].filter(([, s]) => s.state === "ready");
    for (const [old] of ready.slice(0, Math.max(0, ready.length - KEPT))) copy.delete(old);
    return copy;
  });

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fetches the picture `src` of a message once; a second call while it loads or once it is known does nothing. */
export async function loadThumb(machine: string, folder: string, src: string): Promise<void> {
  const key = thumbKey(machine, folder, src);
  const now = states().get(key);
  if (asking.has(key) || (now && !(now.state === "missing" && Date.now() - now.at > MISSING_RETRY_MS))) return;
  asking.add(key);
  try {
    await find(key, machine, folder, src, now === undefined);
  } finally {
    asking.delete(key);
  }
}

/** Keys being fetched now: a retry of a missing picture keeps saying `missing` until it is found, so nothing flickers. */
const asking = new Set<string>();

async function find(key: string, machine: string, folder: string, src: string, first: boolean): Promise<void> {
  if (first) set(key, LOADING);
  let target = src;
  try {
    target = decodeURI(src);
  } catch {
    // A malformed escape is looked for as written.
  }
  if (!isPath(target)) {
    set(key, { state: "missing", message: "Not a path on the agent's machine", at: Date.now() });
    return;
  }
  let path: string;
  try {
    const found = await Files.find(machine, searchFolders(machine, folder), target);
    if (found.kind !== "file") throw new Error(`${target} is not a file`);
    path = found.path;
  } catch (e) {
    set(key, { state: "missing", message: message(e), at: Date.now() });
    return;
  }
  try {
    const { size } = await Files.stat(machine, path);
    if (size > THUMB_CAP) {
      set(key, { state: "large", path, bytes: size });
      return;
    }
    const data = await Files.open(machine, path);
    if (!data.image) {
      set(key, { state: "failed", path, message: data.notice ?? "This picture cannot be shown" });
      return;
    }
    // The header's size holds the final box from the first frame on; the drawn picture confirms it.
    const dims = pictureDimensions(data.image);
    if (dims) rememberSize(key, dims);
    set(key, { state: "ready", uri: data.image, path, bytes: data.size });
  } catch (e) {
    set(key, { state: "failed", path, message: message(e) });
  }
}

/** The pixel size of a picture, from its header or from when it was last drawn, so drawing it again reserves its box. */
export const thumbSize = (key: string): { width: number; height: number } | undefined => sizes.get(key);

export function rememberSize(key: string, size: { width: number; height: number }): void {
  sizes.delete(key);
  sizes.set(key, size);
  if (sizes.size > SIZES_KEPT) sizes.delete(sizes.keys().next().value!);
}

/** The box a thumbnail of `size` takes at most `max` wide, its aspect kept; a smaller picture keeps its own size. */
export function thumbBox(size: { width: number; height: number }, max: number): { width: number; height: number } {
  if (size.width <= 0 || size.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / size.width);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/** Base64 characters read for a JPEG's size: its frame header follows the metadata, which is rarely longer than this. */
const JPEG_HEAD = 87_384;

/**
 * The pixel size a picture's own header states (PNG, GIF, JPEG, WebP, BMP), read from its `data:` address, so its box is
 * held at the final size before it is drawn; `undefined` for a kind that states none here (SVG) or a header cut short.
 */
export function pictureDimensions(uri: string): { width: number; height: number } | undefined {
  const comma = uri.indexOf(",");
  if (comma < 0 || !uri.slice(0, comma).endsWith(";base64")) return undefined;
  const body = uri.slice(comma + 1, comma + 1 + JPEG_HEAD);
  let bytes: string;
  try {
    bytes = atob(body.slice(0, body.length - (body.length % 4)));
  } catch {
    return undefined;
  }
  const at = (i: number) => bytes.charCodeAt(i);
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => be16(i) * 65536 + be16(i + 2);
  const le32 = (i: number) => (le16(i) + le16(i + 2) * 65536) | 0;
  const le24 = (i: number) => le16(i) + at(i + 2) * 65536;
  const sized = (width: number, height: number) =>
    width > 0 && height !== 0 ? { width, height: Math.abs(height) } : undefined;
  if (bytes.startsWith("\x89PNG") && bytes.length >= 24) return sized(be32(16), be32(20));
  if (bytes.startsWith("GIF8") && bytes.length >= 10) return sized(le16(6), le16(8));
  // A BMP stored top-down states a negative height.
  if (bytes.startsWith("BM") && bytes.length >= 26) return sized(le32(18), le32(22));
  if (bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP" && bytes.length >= 30) {
    const chunk = bytes.slice(12, 16);
    if (chunk === "VP8 ") return sized(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (chunk === "VP8L") {
      // 14 bits of width minus one, then 14 of height minus one, after the signature byte.
      const bits = le32(21);
      return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return sized(le24(24) + 1, le24(27) + 1);
    return undefined;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // Walk the segments to the first start-of-frame marker (C0 to CF, except the DHT, JPG and DAC ones).
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return undefined;
      const marker = at(i + 1);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return sized(be16(i + 7), be16(i + 5));
      i += 2 + be16(i + 2);
    }
  }
  return undefined;
}
