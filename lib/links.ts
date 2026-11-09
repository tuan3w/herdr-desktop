import { isImageName } from "#lib/files";

/**
 * How links and pictures read in an agent's Markdown (`design/chat.md`, "Links and pictures"). Pure: the text view draws
 * the result. A link whose text is its own address is drawn short (the host, then the rest of the path muted, with a small
 * mark; a file path as its name and line), by rewriting its label before the text view reads it: `TextView` styles a whole
 * link one way, so the parts are a `<small>` span (the muted part) and an image the chat draws (the mark), which also
 * carries the whole address as its accessible name. The address stays the link's target and its title. A label the author
 * wrote is never shortened. A picture path the agent only names (in inline code or as a link) gets its thumbnail under its
 * paragraph, as if it had been written as an image.
 */

/** The image address of the mark before a short link: `herdr-mark:web` or `herdr-mark:file`. */
export const MARK = "herdr-mark:";
/** The title of a picture the agent only named: drawn when it is found, nothing when it is not (it may not exist yet). */
export const MENTION = "herdr-mention";

/** A path segment count, and a length, past which only the last two segments show. */
const MAX_SEGMENTS = 4;
const MAX_PATH = 40;
/** A fragment shorter than this shows whole (`#L42`); a longer one is `#…`. */
const MAX_FRAGMENT = 12;

/** `github.com` and `/acme/payments-api/pull/128`: what a short web link shows, or `null` when it is not drawn short. */
export function shortUrl(url: string): { host: string; rest: string } | null {
  const m = /^https?:\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i.exec(url);
  // An address with a user in it (`https://github.com@evil.example/`) is shown whole: a short form would hide the host.
  if (!m || m[1]!.includes("@")) return null;
  const host = m[1]!.toLowerCase();
  let path = m[2] ?? "";
  try {
    path = decodeURI(path);
  } catch {
    // A malformed escape is shown as written.
  }
  const segments = path.split("/").filter(Boolean);
  let rest =
    segments.length > MAX_SEGMENTS || path.length > MAX_PATH
      ? `/…/${segments.slice(-2).join("/")}`
      : segments.length > 0
        ? `/${segments.join("/")}`
        : "";
  if (m[3] && m[3].length > 1) rest += "?…";
  else if (m[4] && m[4].length > 1) rest += m[4].length <= MAX_FRAGMENT ? m[4] : "#…";
  return { host, rest };
}

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

/** Escapes text for a link label: nothing in a host or a path turns into emphasis or a tag. */
const escape = (text: string): string => text.replace(/[\\`*_{}[\]<>()#+!|~]/g, (c) => `\\${c}`);
const escapeTitle = (text: string): string => text.replace(/["\\]/g, (c) => `\\${c}`);

/** The short label of a link whose text is `target`, or `null` to leave it as written. */
function shortLink(target: string): string | null {
  if (/[<>\s]/.test(target)) return null;
  const dest = `<${target}> "${escapeTitle(target)}"`;
  const alt = escape(target);
  if (/^https?:\/\//i.test(target)) {
    const short = shortUrl(target);
    if (!short) return null;
    const rest = short.rest ? `<small> ${escape(short.rest)}</small>` : "";
    return `[![${alt}](${MARK}web)${escape(short.host)}${rest}](${dest})`;
  }
  if (!isPath(target)) return null;
  const { path, line } = pathLink(target);
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (name === "") return null;
  return `[![${alt}](${MARK}file)${escape(name)}${line ? `<small>:${line}</small>` : ""}](${dest})`;
}

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

/** A bare address's end as GitHub finds it: trailing punctuation and an unbalanced `)` are not part of it. */
function bareEnd(url: string): string {
  let u = url.replace(/[.,:;!?'"*_~]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

/** One line of prose with its self-named links drawn short; picture paths it names go to `pictures`. */
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
      const label = line.slice(i + 1, close);
      const dest = destOf(line.slice(close + 2, paren));
      if (isPath(dest) && isImageName(pathLink(dest).path)) pictures.push(pathLink(dest).path);
      const short = label.trim() === dest ? shortLink(dest) : null;
      out += short ?? line.slice(i, paren + 1);
      i = paren + 1;
      continue;
    }
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(line.slice(i));
      if (m) {
        out += shortLink(m[1]!) ?? m[0];
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(*_~]/.test(line[i - 1]!))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(line.slice(i));
      if (m) {
        const url = bareEnd(m[0]);
        out += shortLink(url) ?? url;
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
 * An agent's prose (no top-level fences: `splitFences` took them) as the chat draws it: self-named links short, and under
 * each plain paragraph the pictures it names by path, as images titled `MENTION`. A picture already written as an image
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
