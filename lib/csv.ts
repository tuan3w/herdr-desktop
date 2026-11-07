/**
 * A table read from comma, semicolon, tab or bar separated text (RFC 4180: quotes hold separators and line breaks, a
 * doubled quote is one). The viewer shows the first `ROW_LIMIT` rows; the rest is said, never silently dropped.
 */
export interface Sheet {
  /** The first row, or `column 1`, `column 2`... when the first row looks like data. */
  header: string[];
  rows: string[][];
  /** The text had more rows than `rows` holds. */
  truncated: boolean;
  /** The separator read. */
  delimiter: string;
}

/** The most rows kept: a table of a few thousand rows is a screenful of scrolling, not a file to read here. */
export const ROW_LIMIT = 2000;

const DELIMITERS = [",", ";", "\t", "|"];

/** The separator that splits the first lines into the same number (above one) of cells most often; a comma when none does. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, 6).filter((l) => l.trim() !== "");
  let best = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => parseLine(l, d).length);
    const first = counts[0] ?? 0;
    const consistent = counts.filter((c) => c === first).length;
    const score = first > 1 ? consistent * 1000 + first : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** One line split at `delimiter`, quotes honoured (a line with a quote that never closes is split as far as it goes). */
function parseLine(line: string, delimiter: string): string[] {
  return parseRows(line, delimiter, 1)[0] ?? [];
}

function parseRows(text: string, delimiter: string, limit: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  while (i < text.length && rows.length < limit) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === delimiter) {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endCell();
      rows.push(row);
      row = [];
    } else {
      cell += c;
    }
    i++;
  }
  if (rows.length < limit && (cell !== "" || row.length > 0)) {
    endCell();
    rows.push(row);
  }
  return rows;
}

/** Whether a cell is a number, for deciding that a first row of numbers is data and not a header. */
const numeric = (cell: string) => cell.trim() !== "" && Number.isFinite(Number(cell));

/** Reads `text` as a table. The first row is the header unless it is all numbers. Short rows are padded to the widest. */
export function parseSheet(text: string): Sheet {
  const delimiter = detectDelimiter(text);
  const all = parseRows(text.replace(/^\uFEFF/, ""), delimiter, ROW_LIMIT + 2).filter(
    (r) => !(r.length === 1 && r[0] === ""),
  );
  const truncated = all.length > ROW_LIMIT + 1;
  const kept = all.slice(0, ROW_LIMIT + 1);
  const width = kept.reduce((w, r) => Math.max(w, r.length), 0);
  const padded = kept.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
  const first = padded[0];
  const hasHeader = first !== undefined && !first.every((c) => c === "" || numeric(c));
  const header = hasHeader ? first : Array.from({ length: width }, (_, n) => `column ${n + 1}`);
  const rows = hasHeader ? padded.slice(1) : padded;
  // Empty or repeated header names would collide as column keys.
  const seen = new Map<string, number>();
  const unique = header.map((h, n) => {
    const base = h.trim() === "" ? `column ${n + 1}` : h;
    const times = seen.get(base) ?? 0;
    seen.set(base, times + 1);
    return times === 0 ? base : `${base} (${times + 1})`;
  });
  return { header: unique, rows: rows.slice(0, ROW_LIMIT), truncated: truncated || rows.length > ROW_LIMIT, delimiter };
}
