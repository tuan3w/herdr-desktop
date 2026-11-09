import type { PartView } from "herdr-desktop/native";

import { isImageName } from "#lib/files";

/**
 * The files the person's own message carries, and its words without the noise of how they travelled
 * (`design/chat.md`, "The conversation reads like a chat"). A chat read from a terminal sends a file as `@path` in the
 * words (`forTerminal`), and a keeper's echo lists each attached file on a line of its own (`@name`, `[Image #1] name`)
 * beside the structured parts. The bubble shows a picture as a thumbnail and any other file as a chip under the words,
 * so the token is taken out of the words: the trailing run of them goes, one inside a sentence is left as the file's
 * name so the sentence still reads. Pure.
 */

/** A file the message carries: where it is (relative to the session's folder, or absolute), what it is called. */
export interface MessageFile {
  /** As written: relative to the session's folder, or absolute (a keeper's part). */
  path: string;
  /** What the chip says and a screen reader hears: the file's name, `src/` for a folder. */
  name: string;
  picture: boolean;
  folder: boolean;
}

/** `@path` or `@"a path"` after the start, a space or an opening bracket or quote (`me@host` is an address, not a file). */
const MENTION = /(^|[\s([{"'`])@(?:"([^"\n]+)"|([^\s"]+))/g;
/** Punctuation that ends a sentence or a bracket, never the end of a path an agent reads. */
const TRAILING = /[.,;:!?)\]}'"`]+$/;
/** A token that names a file: it has a folder in it, or an extension. `@claude` and `@here` are words. */
const PATHLIKE = /\/|\.[A-Za-z0-9]{1,10}$/;
/** A keeper's echo of a numbered picture: `[Image #1] shot.png`. */
const ECHOED = /^\[Image #\d+\](?: (.*))?$/;

const nameOf = (path: string, folder: boolean): string => {
  const parts = path.replace(/\/+$/, "").split("/");
  const last = parts.at(-1) || path;
  return folder ? `${last}/` : last;
};

const fileOf = (path: string): MessageFile => {
  const folder = path.endsWith("/");
  const clean = folder ? path.replace(/\/+$/, "") || "/" : path;
  return { path: clean, name: nameOf(path, folder), picture: !folder && isImageName(clean), folder };
};

/** The path a `file:` address names on the agent's machine, or `null` for any other address. */
export const pathOfUri = (uri: string | null | undefined): string | null => {
  if (!uri?.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
};

/**
 * `text` (the person's words, as sent) and `parts` (a keeper's structured attachments) as the bubble draws them: the
 * words without the file tokens, the files (each once, in the order named), and the parts that are not a file on the
 * machine (a picture carried as bytes, a web address), which the bubble keeps drawing as it did.
 */
export function messageFiles(
  text: string,
  parts: readonly PartView[],
): { text: string; files: MessageFile[]; rest: PartView[] } {
  const files: MessageFile[] = [];
  const rest: PartView[] = [];
  const pictureNames = new Set<string>();
  for (const part of parts) {
    const path = pathOfUri(part.uri);
    if (path === null || part.partKind === "audio") {
      rest.push(part);
      continue;
    }
    const file = { ...fileOf(path), picture: part.partKind === "image" || isImageName(path) };
    files.push(file);
    if (file.picture) pictureNames.add(part.name);
  }
  // The keeper's echo lines of its own pictures: the thumbnail is the picture.
  const lines = text
    .split("\n")
    .filter((line) => {
      const m = ECHOED.exec(line.trim());
      return !(m && pictureNames.size > 0 && (m[1] === undefined || pictureNames.has(m[1])));
    })
    .join("\n");

  const found: { at: number; end: number; file: MessageFile }[] = [];
  for (const m of lines.matchAll(MENTION)) {
    const quoted = m[2];
    const raw = quoted ?? m[3]!.replace(TRAILING, "");
    if (raw === "" || (quoted === undefined && !PATHLIKE.test(raw))) continue;
    const at = m.index + m[1]!.length;
    const end = at + 1 + (quoted === undefined ? raw.length : quoted.length + 2);
    found.push({ at, end, file: fileOf(raw) });
  }
  // The run of tokens the words end with is what was attached, and goes. When a token also stands inside the words, the
  // person wrote them all as words (`compare @a.png with @b.png`): each is left as its name, so the sentence still reads.
  const attached =
    found.length > 0 && found.every((f, i) => lines.slice(f.end, found[i + 1]?.at ?? lines.length).trim() === "");
  let words = attached ? lines.slice(0, found[0]!.at) : "";
  if (!attached) {
    let from = 0;
    for (const f of found) {
      words += lines.slice(from, f.at) + f.file.name;
      from = f.end;
    }
    words += lines.slice(from);
  }

  for (const f of found) {
    const known = files.some(
      (k) => k.path === f.file.path || (!f.file.path.startsWith("/") && k.path.endsWith(`/${f.file.path}`)),
    );
    if (!known) files.push(f.file);
  }
  return { text: found.length > 0 || lines !== text ? words.trimEnd() : text, files, rest };
}

/** What a screen reader hears of a message's files after its words: `Picture image-4.png, File notes.md`. */
export function filesLabel(files: readonly MessageFile[]): string {
  return files.map((f) => `${f.picture ? "Picture" : f.folder ? "Folder" : "File"} ${f.name}`).join(", ");
}
