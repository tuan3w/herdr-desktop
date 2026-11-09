import { isImageName } from "#lib/files";

/**
 * How links and pictures read in an agent's Markdown (`design/chat.md`, "Links and pictures"). Pure: the text view draws
 * the result. A link shows its text as written, the whole address (owner, 2026-11-09: "no need to hide some link part,
 * full link, no special highlight"), and gets its address as its title so the tooltip and the accessible name say where it
 * goes. A picture path the agent only names (in inline code or as a link) gets its thumbnail under its paragraph, as if it
 * had been written as an image.
 */

/** The title of a picture the agent only named: drawn when it is found, nothing when it is not (it may not exist yet). */
export const MENTION = "herdr-mention";

/** A path link's file and line: `src/a.ts:12`, `src/a.ts:12:3`, `src/a.ts#L12` (and `#L12-L20`). */
export function pathLink(target: string): { path: string; line?: number; col?: number } {
  const hash = /^(.*)#L(\d+)(?:-L?\d+)?$/.exec(target);
  if (hash) return { path: hash[1]!, line: Number(hash[2]) };
  const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(target);
  if (colon && colon[1] !== "")
    return { path: colon[1]!, line: Number(colon[2]), col: colon[3] ? Number(colon[3]) : undefined };
  return { path: target.split("#")[0]! };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Whether `target` is a path on the session's machine (relative or absolute, no scheme). */
export const isPath = (target: string): boolean => target !== "" && !target.startsWith("#") && !SCHEME.test(target);

/** Escapes a file name for an image's alt text: nothing in it turns into emphasis or a tag. */
const escape = (text: string): string => text.replace(/[\\`*_{}[\]<>()#+!|~]/g, (c) => `\\${c}`);

/** The end of the bracketed run that starts at `open` (`[` or `(`), nested ones counted, or -1. */
function closing(line: string, open: number): number {
  const [o, c] = line[open] === "[" ? ["[", "]"] : ["(", ")"];
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") i++;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

/** A link destination without its title and angle brackets: `<a b> "t"` is `a b`. */
function destOf(inside: string): string {
  const t = inside.trim();
  if (t.startsWith("<")) return t.slice(1, t.indexOf(">") < 0 ? undefined : t.indexOf(">"));
  return t.split(/\s+/)[0] ?? "";
}

const escapeTitle = (text: string): string => text.replace(/["\\]/g, (c) => `\\${c}`);

/** A link that shows `text` and is named by its whole address (tooltip, accessible name): `[text](<target> "target")`. */
const titled = (text: string, target: string): string => `[${text}](<${target}> "${escapeTitle(target)}")`;

/** A bare address's end as GitHub finds it: trailing punctuation and an unbalanced `)` are not part of it. */
function bareEnd(url: string): string {
  let u = url.replace(/[.,:;!?'"*_~]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

/**
 * One line of prose with its text as written; a link without a title gets its address as one, so the whole address is
 * its tooltip and accessible name. Picture paths it names (in inline code or as a link's address) go to `pictures`.
 */
function rewriteLine(line: string, pictures: string[]): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(line.slice(i))![0];
      const end = line.indexOf(run, i + run.length);
      if (end < 0) {
        out += run;
        i += run.length;
        continue;
      }
      const code = line.slice(i + run.length, end).trim();
      if (isPath(code) && !/\s/.test(code) && isImageName(code)) pictures.push(code);
      out += line.slice(i, end + run.length);
      i = end + run.length;
      continue;
    }
    if (ch === "!" && line[i + 1] === "[") {
      // An image as written: left alone, and its address is already a picture.
      const close = closing(line, i + 1);
      const paren = close >= 0 && line[close + 1] === "(" ? closing(line, close + 1) : -1;
      const end = paren >= 0 ? paren + 1 : i + 2;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      const close = closing(line, i);
      const paren = close >= 0 && line[close + 1] === "(" ? closing(line, close + 1) : -1;
      if (paren < 0) {
        out += ch;
        i++;
        continue;
      }
      const inside = line.slice(close + 2, paren);
      const dest = destOf(inside);
      if (isPath(dest) && isImageName(pathLink(dest).path)) pictures.push(pathLink(dest).path);
      const hasTitle = /["')]\s*$/.test(inside.trim()) && inside.trim() !== dest;
      out += hasTitle || /[<>\s]/.test(dest) ? line.slice(i, paren + 1) : titled(line.slice(i + 1, close), dest);
      i = paren + 1;
      continue;
    }
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(line.slice(i));
      if (m) {
        out += titled(escape(m[1]!), m[1]!);
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(*_~]/.test(line[i - 1]!))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(line.slice(i));
      if (m) {
        const url = bareEnd(m[0]);
        out += titled(escape(url), url);
        i += url.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that is not a plain paragraph's: a list item, a quote, a table row, a heading, or indented (code or a continuation). */
const NOT_PLAIN = /^(\s{4,}|\t| {0,3}([-+*]|\d+[.)])\s| {0,3}>| {0,3}\||\s*#)/;

/**
 * An agent's prose (no top-level fences: `splitFences` took them) as the chat draws it: as written with every link titled
 * by its address, and under each plain paragraph the pictures it names by path, as images titled `MENTION`. A picture already written as an image
 * is not repeated. Lines inside a fence (one in a list item) are left alone; so are pictures named in a list, a quote or a
 * table, because an image added there would cut the list in two.
 */
export function chatMarkdown(markdown: string): string {
  const shown = new Set<string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) shown.add(m[1]!);
  const out: string[] = [];
  let fence: string | null = null;
  let pending: string[] = [];
  let plain = true;
  const flush = () => {
    if (plain)
      for (const path of pending) {
        if (shown.has(path) || /[<>\s]/.test(path)) continue;
        shown.add(path);
        out.push("", `![${escape(path.split("/").pop() ?? path)}](<${path}> "${MENTION}")`);
      }
    pending = [];
    plain = true;
  };
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      flush();
      fence = f[1]!;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push(line);
      continue;
    }
    if (NOT_PLAIN.test(line)) plain = false;
    // An indented line may be code: drawn as written.
    out.push(/^(\s{4,}|\t)/.test(line) ? line : rewriteLine(line, pending));
  }
  flush();
  return out.join("\n");
}
