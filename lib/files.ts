import { signal } from "nsh";

import type { EntryView } from "herdr-desktop/native";

import type { IconName } from "#kit";
import { DEFAULT_SORT, type FileSort } from "#lib/file-table";
import { mediaKindOf } from "#lib/media";
import { apple } from "#lib/shortcuts";
import { ageText } from "#lib/sidebar";

/**
 * What the Files tab, the viewers and pages from a machine need that is not a screen: the rules for naming, sizing and
 * routing a link, and the glyph of a file. Which tab opens is `lib/open-files.ts`; the table's rules are
 * `lib/file-table.ts`. Reading and writing files is Rust (`Files`, `Pages`).
 */

/** A page on a remote machine's localhost is open in `WebPage`. `url` is as the machine knows it (`http://localhost:5173/`). */
export interface PageRequest {
  machine: string;
  url: string;
}
export const pageRequest = signal<PageRequest | null>(null);

/** Files were dropped on a pane: `paths` (local) are to be sent into `folder` on `machine`. */
export interface SendRequest {
  machine: string;
  folder: string;
  paths: string[];
}
export const sending = signal<SendRequest | null>(null);

/** How a folder is ordered and whether dotfiles show; shared by every Files tab and kept between their openings (not between runs). */
export const fileSort = signal<FileSort>(DEFAULT_SORT);
export const showHidden = signal(false);

/** What a pressed link in a pane does. */
export type LinkRoute = "browser" | "page" | "file" | "address";

/**
 * Where a link goes. A file path opens in the file viewer, on the pane's machine. A web address on a machine's own
 * `localhost` is a page of that machine: on a remote one it is tunnelled and shown here, on this computer it is the
 * browser's (nothing to tunnel). Any other http or https address opens in the browser. Anything else (a `file:` or
 * `javascript:` address) is only copied, never opened.
 */
export function routeLink(
  kind: "url" | "path",
  target: string,
  where: { local: boolean; loopback: boolean },
): LinkRoute {
  if (kind === "path") return "file";
  if (where.loopback && !where.local) return "page";
  return /^https?:\/\//i.test(target) ? "browser" : "address";
}

/** The folder part of an absolute path; `/` has none. */
export function parentOf(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** `dir/name` without a doubled slash. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** `812 KB`, `1.4 MB`, `37 bytes`: the units a person reads. */
export function sizeText(bytes: number): string {
  // A size the machine could not give (negative, not a number) says nothing rather than something false.
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const units = ["MB", "GB", "TB", "PB"];
  let value = bytes / (1024 * 1024);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a file changed: `just now`, `4 min`, `3 h`, `5 d` ago within a month, else `12 Mar` (and the year when it is not this one). `now` is seconds since the epoch: the caller's clock, so a test needs none. */
export function modifiedText(modified: number | null | undefined, now: number): string {
  if (modified === null || modified === undefined) return "";
  const age = now - modified;
  // A clock ahead of ours by more than a minute is not "just now": the date says what the machine wrote.
  if (age >= -60 && age < 30 * 86400) return age < 45 ? "just now" : `${ageText(age)} ago`;
  const then = new Date(modified * 1000);
  const year = then.getUTCFullYear() === new Date(now * 1000).getUTCFullYear() ? "" : ` ${then.getUTCFullYear()}`;
  return `${then.getUTCDate()} ${MONTHS[then.getUTCMonth()]}${year}`;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** Whether the name is a picture the viewer draws (the core decides the same by extension). */
export const isImageName = (name: string): boolean => IMAGE.test(name);

/** What a screen reader says of a row: `<name>, folder|file, <size>, <changed>`, and why it cannot be opened. */
export function entryLabel(entry: EntryView, now: number): string {
  const kind = entry.kind === "dir" ? "folder" : entry.kind === "file" ? "file" : "not a regular file";
  return [
    entry.name,
    entry.link ? `link, ${kind}` : kind,
    entry.kind === "file" ? sizeText(entry.size) : "",
    modifiedText(entry.modified, now),
    entry.readable ? "" : "no permission",
  ]
    .filter(Boolean)
    .join(", ");
}

/** What the button that shows a file in the system's file manager is called: Finder on a Mac. */
export const revealLabel = (): string => (apple() ? "Reveal in Finder" : "Reveal in the file manager");

/** Where the viewer steps from `current` through `names`: the neighbour before or after it, `null` at either end or when it is not there. */
export function stepOf(names: readonly string[], current: string, step: -1 | 1): string | null {
  const at = names.indexOf(current);
  return at < 0 ? null : (names[at + step] ?? null);
}

/** `Photo 2 of 3` for a picture, `File 4 of 9` for anything else: where the viewer is among the files it steps through. */
export function placeText(names: readonly string[], current: string, picture: boolean): string {
  const at = names.indexOf(current);
  return at < 0 ? "" : `${picture ? "Photo" : "File"} ${at + 1} of ${names.length}`;
}

/** The names the viewer steps through from `current`: the pictures of the folder when it is a picture, else every file. */
export function stepNames(entries: readonly EntryView[], current: string): string[] {
  const files = entries.filter((e) => e.kind === "file").map((e) => e.name);
  return isImageName(current) ? files.filter(isImageName) : files;
}

const CODE =
  /\.(rs|ts|tsx|js|jsx|mjs|py|go|java|kt|c|cc|cpp|h|hpp|rb|php|swift|dart|lua|zig|css|html|svelte|vue|sql)$/i;
const SCRIPT = /\.(sh|bash|zsh|fish|ps1|bat)$|^Makefile$|^Dockerfile$/i;
const CONFIG = /\.(json|toml|ya?ml|ini|conf|lock|env|xml)$|^\./;
const ARCHIVE = /\.(zip|tar|tgz|gz|jar|7z|rar|xz|bz2)$/i;

/**
 * The glyph of a file or folder by its name: a shape per kind, never a colour. The one set every list of files uses
 * (the Files tab, the attach list, quick open, the `@` list), so a file looks the same wherever it is listed.
 */
export function fileGlyph(name: string, folder: boolean): IconName {
  if (folder) return "folder";
  if (isImageName(name)) return "image";
  const media = mediaKindOf(name);
  if (media) return media === "video" ? "film" : "music";
  if (ARCHIVE.test(name)) return "archive";
  if (SCRIPT.test(name)) return "terminal";
  if (CONFIG.test(name)) return "sliders";
  if (CODE.test(name)) return "file";
  if (/\.(md|markdown|txt|rst)$/i.test(name)) return "list";
  return "file";
}
