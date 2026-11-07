/**
 * Splits a Markdown message into the prose that `TextView` draws and the fenced code that `CodeBlock` draws. Only
 * top-level fences are split out: one inside a list item or a quote stays in the prose, where `TextView`'s own block
 * draws it (a split there would tear the list in two). Pure and total: every text gives segments whose parts, put back,
 * are the text, and an unfinished fence (the reply is still being written) is the last segment with `open` set.
 */

export interface ProseSegment {
  kind: "prose";
  /** Stable per position, so a streamed message keeps each part's view while it grows. */
  key: string;
  text: string;
}

export interface FenceSegment {
  kind: "fence";
  key: string;
  /** The whole info string after the fence (`rust,no_run`, `ts title="a.ts"`); empty when there is none. */
  info: string;
  /** The text of a `title="…"` or `file="…"` attribute of the info string: what a corner shows instead of the language. */
  title?: string;
  /** The lines between the fences, as written (the fence's indentation removed), without the closing line's break. */
  code: string;
  /** No closing fence yet: still being written when it is the end of a streamed message. */
  open: boolean;
  /** The opening line has its line break: its info string is complete (before that it may be half typed). */
  infoComplete: boolean;
}

export type Segment = ProseSegment | FenceSegment;

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** The value of a `title="…"` or `file="…"` attribute of a fence's info string. */
function titleOf(info: string): string | undefined {
  const m = /(?:^|[\s,{])(?:title|file(?:name)?)=(?:"([^"]*)"|'([^']*)'|([^\s"',}]+))/.exec(info);
  return m ? (m[1] ?? m[2] ?? m[3]) || undefined : undefined;
}

/** Removes up to `width` leading spaces: the indentation a fence has is not part of its code. */
function dedent(line: string, width: number): string {
  let n = 0;
  while (n < width && line.charCodeAt(n) === 32) n++;
  return n === 0 ? line : line.slice(n);
}

export function splitFences(source: string): Segment[] {
  const out: Segment[] = [];
  const lines = source.split("\n");
  let prose: string[] = [];
  let inList = false;
  let afterBlank = false;
  /** A fence of a list item or a quote that is being read through: nothing in it starts a top-level fence. */
  let nested: { char: string; length: number } | undefined;

  const flush = () => {
    const text = prose.join("\n");
    prose = [];
    if (text.trim() !== "") out.push({ kind: "prose", key: `p:${out.length}`, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const last = i === lines.length - 1;
    if (nested) {
      prose.push(line);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === nested.char && close[1]!.length >= nested.length) nested = undefined;
      continue;
    }
    const open = OPEN.exec(line);
    if (open && !(open[2]![0] === "`" && open[3]!.includes("`"))) {
      const indent = open[1]!.length;
      if (indent > 0 && inList) {
        nested = { char: open[2]![0]!, length: open[2]!.length };
        prose.push(line);
        continue;
      }
      const char = open[2]![0]!;
      const length = open[2]!.length;
      const info = open[3]!.trim();
      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      // Built once per fence: a streamed message scans its whole text again for every chunk.
      const closer = new RegExp(`^ {0,3}\\${char}{${length},}\\s*$`);
      for (; j < lines.length; j++) {
        if (closer.test(lines[j]!)) {
          closed = true;
          break;
        }
        body.push(dedent(lines[j]!, indent));
      }
      flush();
      out.push({ kind: "fence", key: `f:${out.length}`, info, title: titleOf(info), code: body.join("\n"), open: !closed, infoComplete: !last });
      i = j;
      inList = false;
      afterBlank = false;
      continue;
    }
    const blank = line.trim() === "";
    if (LIST_ITEM.test(line)) inList = true;
    else if (!blank && !/^\s/.test(line) && afterBlank) inList = false;
    afterBlank = blank;
    prose.push(line);
  }
  flush();
  return out;
}

/** The first word of a fence's info string, lower-cased and without the decoration `{.python}` or `language-` add. */
export function fenceLanguage(info: string): string {
  const word = info.replace(/^\{\.?/, "").split(/[\s,{}]/)[0] ?? "";
  return word.replace(/^language-/i, "").toLowerCase();
}
