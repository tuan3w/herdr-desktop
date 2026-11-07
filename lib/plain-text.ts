import { splitFences } from "#lib/markdown-fences";

/**
 * What a message says without the Markdown that draws it: the text `Copy message` puts on the clipboard (`Copy as
 * Markdown` puts the source). Code stays exactly as written, a table becomes tab-separated rows (it pastes into a
 * spreadsheet), a link is `text (address)`, an image is its alt text, and the marks that only style (`#`, `**`, `_`,
 * backticks, `>`) are gone. Pure and total.
 */
export function plainText(source: string): string {
  return splitFences(source)
    .map((part) => (part.kind === "fence" ? part.code : plainProse(part.text)))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function plainProse(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || TABLE_RULE.test(line)) continue;
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (row) {
      out.push(
        row[1]!
          .split("|")
          .map((cell) => inline(cell.trim()))
          .join("\t"),
      );
      continue;
    }
    out.push(inline(line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^(\s*)>\s?/, "$1")));
  }
  return out.join("\n");
}

/** The inline marks of one line: images, links, code spans, emphasis and escapes. */
function inline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=[\s).,;:!?]|$)/g, "$1$3")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}
