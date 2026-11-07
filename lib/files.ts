import { signal } from "nsh";

import type { EntryView } from "herdr-desktop/native";

import { ageText } from "#lib/sidebar";

/**
 * What the file browser, the viewers and pages from a machine need that is not a screen: which of them is open
 * (a key, a menu item, a link in a pane and the palette all open the same one), and the rules for listing, naming and
 * routing a link. Reading and writing files is Rust (`Files`, `Pages`).
 */

/** The file browser is open on `dir` of `machine`; with `file` the viewer opens on that file first (a path an agent named). */
export interface Browse {
  machine: string;
  dir: string;
  file?: string;
  /** The line of `file` a link named (`main.rs:42`): the viewer scrolls to it. */
  line?: number;
}
export const browsing = signal<Browse | null>(null);

/** Opens the file browser on a folder of a machine. */
export function browseFiles(machine: string, dir: string): void {
  browsing.set({ machine, dir });
}

/** Opens the viewer on a file, at `line` when a link gave one; Back there lists its folder. */
export function viewFile(machine: string, path: string, line?: number | null): void {
  browsing.set({ machine, dir: parentOf(path) ?? "/", file: path, line: line ?? undefined });
}

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

/** How the folder list is ordered and whether dotfiles show; kept between openings of the browser. */
export const fileSort = signal<SortKey>("name");
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

/** One step of the breadcrumb: its name and the path pressing it goes to. */
export interface Crumb {
  name: string;
  path: string;
}

/** The path from the root, a crumb per folder: `/home/dev/app` is `/`, `home`, `dev`, `app`. */
export function crumbs(path: string): Crumb[] {
  const out: Crumb[] = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at += `/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

/** How a folder is ordered. Folders always come first. */
export type SortKey = "name" | "modified" | "size";

/**
 * The entries to show: hidden ones (a leading dot) only when asked, folders first, then by `sort`. Name runs A to Z
 * without regard to case; modified and size run newest and largest first, because that is what the person who
 * chose them is looking for. The core sorts by name already; this orders again only for the other two.
 */
export function arrange(entries: readonly EntryView[], options: { sort: SortKey; hidden: boolean }): EntryView[] {
  const shown = entries.filter((e) => options.hidden || !e.name.startsWith("."));
  if (options.sort === "name") return shown;
  const by = options.sort === "modified" ? (e: EntryView) => e.modified ?? 0 : (e: EntryView) => e.size;
  const rank = (e: EntryView) => Number(e.kind !== "dir");
  return shown
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || by(b.e) - by(a.e) || a.i - b.i)
    .map((x) => x.e);
}

/** `812 KB`, `1.4 MB`, `37 bytes`: the units a person reads. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a file changed: `just now`, `4 min`, `3 h`, `5 d` ago within a month, else `12 Mar` (and the year when it is not this one). `now` is seconds since the epoch: the caller's clock, so a test needs none. */
export function modifiedText(modified: number | null | undefined, now: number): string {
  if (modified === null || modified === undefined) return "";
  const age = now - modified;
  if (age < 30 * 86400) return age < 45 ? "just now" : `${ageText(Math.max(0, age))} ago`;
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
