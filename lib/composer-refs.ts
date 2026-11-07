import type { IconName } from "#kit";
import { isImageName, sizeText } from "#lib/files";

/**
 * What the chat's message box holds besides its words, and the rules that keep the two in step. A box is one native text
 * field (it keeps IME, undo, the screen reader's text and the system's paste), so nothing is drawn inside it: a reference
 * is a **token** in the text and a chip above it.
 *
 * - a file or folder is `@src/main.rs` (`@"my notes.md"` when the name has a space), the form agents that only read text
 *   understand, and also a `resource_link` or embedded `resource` when the message is sent;
 * - a picture is no text at all, only a thumbnail above the box (it has no token; `refKey` tells pictures apart);
 * - a long paste is `[Pasted text #1 +480 lines]` and goes out as the whole text.
 *
 * A reference is *active* while its token stands in the text (a picture, while it is in the box): delete the words and
 * the chip goes, type them again (or undo) and it is back. The refs a box ever made are kept (`known`) until the message is sent, which is what lets Undo
 * bring a chip back. Everything here is pure; `components/session-composer.tsx` holds the signals.
 */

/** A file or folder named by a `@`. */
export interface MentionRef {
  kind: "mention";
  /** Absolute, on the session's machine. */
  path: string;
  /** Relative to the session's folder (the text of the token), no trailing slash. */
  rel: string;
  folder: boolean;
}

/** A picture of this computer made ready by `Compose.preparePicture`. */
export interface PictureRef {
  kind: "picture";
  id: string;
  /** The `n` of `Image n of m`: it stays with the picture when another is taken off. */
  number: number;
  /** The prepared file, on this computer. */
  path: string;
  /** What the transcript calls it. */
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  scaled: boolean;
  /** Base64 JPEG for the chip. */
  thumb: string;
}

/** A paste too long for the box, kept whole. */
export interface PasteRef {
  kind: "paste";
  id: string;
  number: number;
  text: string;
  lines: number;
}

export type Ref = MentionRef | PictureRef | PasteRef;

/** A paste longer than this many characters becomes a chip. */
export const PASTE_COLLAPSE = 5000;

/** Where a token stands in a text. */
export interface Span {
  ref: Ref;
  start: number;
  end: number;
}

/**
 * The text a ref stands for in the box. A picture stands for none: it is a thumbnail and one notice, never words, so
 * a sentence cannot point at "#2" (the cost of keeping the field free of a second copy of what the strip shows).
 */
export function tokenOf(ref: Ref): string {
  if (ref.kind === "picture") return "";
  if (ref.kind === "paste") return `[Pasted text #${ref.number} +${ref.lines} ${ref.lines === 1 ? "line" : "lines"}]`;
  const rel = ref.folder ? `${ref.rel}/` : ref.rel;
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

/** What tells one ref from another: the token, and for a picture (which has none) its id. */
export const refKey = (ref: Ref): string => (ref.kind === "picture" ? `picture:${ref.id}` : tokenOf(ref));

const OPENERS = /[\s([{"'`]/;
const CLOSERS = /[,;:)\]}?!"'`]/;

/** Whether the mention token that ends at `end` in `text` is a word of its own (`@a.rs` yes, `@a.rsx` and `me@a.rs` no). */
function standsAlone(text: string, start: number, end: number): boolean {
  const before = start === 0 ? undefined : text[start - 1];
  if (before !== undefined && !OPENERS.test(before)) return false;
  const after = text[end];
  if (after === undefined || /\s/.test(after) || CLOSERS.test(after)) return true;
  // A full stop ends a sentence, but `@a.rs.bak` is another file.
  if (after === ".") return text[end + 1] === undefined || /\s/.test(text[end + 1]!);
  return false;
}

/** Every place `ref`'s token stands in `text`. */
export function spansOf(text: string, ref: Ref): Span[] {
  const token = tokenOf(ref);
  if (token === "") return [];
  const out: Span[] = [];
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const end = at + token.length;
    if (ref.kind !== "mention" || standsAlone(text, at, end)) out.push({ ref, start: at, end });
  }
  return out;
}

/** The refs of `known` that count: a token that stands in `text`, or a picture for as long as it is in the box. */
export const activeRefs = (text: string, known: readonly Ref[]): Ref[] =>
  known.filter((r) => r.kind === "picture" || spansOf(text, r).length > 0);

/**
 * `next` when the person deleted part of a token: the rest of the token goes too, so a chip is one thing to Backspace.
 * `null` when nothing of a token was touched or the edit was not a deletion.
 */
export function keepAtomic(prev: string, next: string, known: readonly Ref[]): { text: string; caret: number } | null {
  if (next.length >= prev.length) return null;
  let head = 0;
  while (head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const delStart = head;
  const delEnd = prev.length - tail;
  for (const ref of known) {
    for (const { start, end } of spansOf(prev, ref)) {
      if (delEnd <= start || delStart >= end) continue;
      if (delStart <= start && delEnd >= end) continue;
      const from = Math.min(start, delStart);
      const to = delStart + Math.max(0, end - delEnd);
      const text = next.slice(0, from) + next.slice(to);
      return keepAtomic(next, text, known) ?? { text, caret: from };
    }
  }
  return null;
}

/** `text` with the tokens of `ref` taken out, each with the one space after it (before it at the end of the text). */
export function withoutRef(text: string, ref: Ref): string {
  let out = text;
  for (const { start, end } of spansOf(text, ref).reverse()) {
    if (out[end] === " ") out = out.slice(0, start) + out.slice(end + 1);
    else if (start > 0 && out[start - 1] === " ") out = out.slice(0, start - 1) + out.slice(end);
    else out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** Puts `insert` at `caret` with a space before it (unless a word does not precede it) and after it, and says where the caret goes. */
export function insertToken(text: string, caret: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const tail = after === "" || !/^\s/.test(after) ? " " : "";
  const next = `${before}${lead}${insert}${tail}${after}`;
  return { text: next, caret: before.length + lead.length + insert.length + tail.length };
}

/** What `Sessions.send` takes: the words with every long paste in full, the files and folders named, the pictures. */
export interface Outgoing {
  text: string;
  files: string[];
  pictures: { path: string; name: string; number: number }[];
}

/**
 * The message as it goes out. Mentions stay in the words as `@path`, so an agent that reads only text still sees where
 * they point; pastes are replaced by what they hold; `attached` are files added with `+` or a drop (not in the words).
 */
export function outgoing(text: string, known: readonly Ref[], attached: readonly string[]): Outgoing {
  const active = activeRefs(text, known);
  let words = text;
  const pastes = active
    .filter((r): r is PasteRef => r.kind === "paste")
    .flatMap((r) => spansOf(text, r))
    .sort((a, b) => b.start - a.start);
  for (const { ref, start, end } of pastes) words = words.slice(0, start) + (ref as PasteRef).text + words.slice(end);
  const files = [
    ...new Set([...attached, ...active.filter((r): r is MentionRef => r.kind === "mention").map((r) => r.path)]),
  ];
  const pictures = active
    .filter((r): r is PictureRef => r.kind === "picture")
    .sort((a, b) => a.number - b.number)
    .map((r) => ({ path: r.path, name: r.name, number: r.number }));
  return { text: words.trim(), files, pictures };
}

/** The message as history and a restored draft keep it: pastes in full (a picture is not text). */
export const plainText = (text: string, known: readonly Ref[]): string => outgoing(text, known, []).text;

/** Whether there is something to send: words, or any chip. */
export const sendable = (text: string, known: readonly Ref[], attached: readonly string[]): boolean =>
  text.trim() !== "" || attached.length > 0 || activeRefs(text, known).length > 0;

/** The number the next picture or paste takes: one past the highest ever used in this box. */
export const nextNumber = (known: readonly Ref[], kind: "picture" | "paste"): number =>
  known.reduce((n, r) => (r.kind === kind ? Math.max(n, r.number) : n), 0) + 1;

/**
 * Whether a paste's "text" is really a picture's bytes. A clipboard that offers only `image/png` still lets GTK read it as
 * text (an `xclip -t image/png`, some screenshot tools): the person meant the picture, not `\u0089PNG` and control characters.
 */
export const looksBinary = (text: string): boolean =>
  text.startsWith("\u0089PNG") ||
  text.startsWith("\u00ff\u00d8") ||
  /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(text.slice(0, 64));

/** The lines of a text, for `Pasted text (N lines)`. */
export const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;

// ---- the @ itself ----

/** A `@word` the caret is in the middle of. */
export interface Mention {
  /** Index of the `@` in the text. */
  start: number;
  /** What follows it up to the caret: `src/ma`. */
  query: string;
}

/**
 * The mention the caret is in: an `@` at the start of the text, after whitespace or after an opening bracket or quote,
 * then no whitespace up to the caret. An `@` inside a word (`me@host`) is just a character, so addresses stay typeable;
 * so is an `@` the caret has left (a token that stands alone).
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.search(/(?:^|[\s([{"'`])@[^\s@]*$/);
  if (at < 0) return null;
  const start = before.indexOf("@", at);
  return { start, query: before.slice(start + 1).replace(/^"/, "") };
}

/** `text` with the mention replaced by `token`, the caret after it. */
export function acceptMention(
  text: string,
  mention: Mention,
  caret: number,
  token: string,
): { text: string; caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const tail = after === "" || !/^\s/.test(after) ? " " : "";
  return { text: `${before}${token}${tail}${after}`, caret: before.length + token.length + tail.length };
}

/** Runs of `text[from, to)` for the matched `marks` (flat `[start, end]` pairs over the whole path), to draw the letters. */
export function markRuns(
  text: string,
  marks: readonly number[],
  from = 0,
  to = text.length,
): { text: string; marked: boolean }[] {
  const runs: { text: string; marked: boolean }[] = [];
  let at = from;
  const push = (end: number, marked: boolean) => {
    if (end > at) runs.push({ text: text.slice(at, end), marked });
    at = Math.max(at, end);
  };
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const start = Math.max(from, marks[i]!);
    const end = Math.min(to, marks[i + 1]!);
    if (end <= start) continue;
    push(start, false);
    push(end, true);
  }
  push(to, false);
  return runs;
}

const CODE =
  /\.(rs|ts|tsx|js|jsx|mjs|py|go|java|kt|c|cc|cpp|h|hpp|rb|php|swift|dart|lua|zig|css|html|svelte|vue|sql)$/i;
const SCRIPT = /\.(sh|bash|zsh|fish|ps1|bat)$|^Makefile$|^Dockerfile$/i;
const CONFIG = /\.(json|toml|ya?ml|ini|conf|lock|env|xml)$|^\./;

/** The icon of a file by its name: a shape per kind, never a colour. */
export function fileGlyph(name: string, folder: boolean): IconName {
  if (folder) return "folder";
  if (isImageName(name)) return "image";
  if (SCRIPT.test(name)) return "terminal";
  if (CONFIG.test(name)) return "sliders";
  if (CODE.test(name)) return "file";
  if (/\.(md|markdown|txt|rst)$/i.test(name)) return "list";
  return "file";
}

/** `PNG` or `JPEG`: what a chip says about a prepared picture. */
export const typeName = (mime: string): string => mime.replace("image/", "").toUpperCase();

/** The name a screen reader reads for picture `i` (0-based) of `n`: `Image 1 of 3, PNG, 1.2 MB`. */
export const pictureLabel = (p: PictureRef, i: number, n: number): string =>
  `Image ${i + 1} of ${n}, ${typeName(p.mime)}, ${sizeText(p.bytes)}`;

/** What a chip's tooltip says: the type, the size in pixels and bytes, and that it was made smaller when it was. */
export const pictureDetail = (p: PictureRef): string =>
  `${typeName(p.mime)} · ${p.width} × ${p.height} · ${sizeText(p.bytes)}${p.scaled ? " · scaled down" : ""}`;

// ---- recalling what was sent ----

/** The messages sent in one chat, newest last, and where an Up walk has got to. In memory only. */
export interface History {
  items: string[];
  /** The index being shown, `null` when the box holds the person's own text. */
  at: number | null;
  /** What the box held before the first Up. */
  draft: string;
}

export const MAX_HISTORY = 50;
export const emptyHistory = (): History => ({ items: [], at: null, draft: "" });

/** `h` after `text` was sent; a repeat of the last one and blank text are not kept. */
export function remember(h: History, text: string): History {
  const t = text.trim();
  if (t === "" || h.items[h.items.length - 1] === t) return { ...h, at: null, draft: "" };
  return { items: [...h.items, t].slice(-MAX_HISTORY), at: null, draft: "" };
}

/** One step back: the box holds `current`. `null` when there is nothing older. */
export function recallUp(h: History, current: string): { history: History; text: string } | null {
  if (h.items.length === 0) return null;
  const at = h.at === null ? h.items.length - 1 : h.at - 1;
  if (at < 0) return null;
  return { history: { ...h, at, draft: h.at === null ? current : h.draft }, text: h.items[at]! };
}

/** One step forward; past the newest the box gets its own text back. `null` when not walking. */
export function recallDown(h: History): { history: History; text: string } | null {
  if (h.at === null) return null;
  if (h.at + 1 >= h.items.length) return { history: { ...h, at: null }, text: h.draft };
  return { history: { ...h, at: h.at + 1 }, text: h.items[h.at + 1]! };
}
