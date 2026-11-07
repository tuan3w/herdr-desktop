/**
 * Text an agent wrote that the person is asked to approve, made safe to read: nothing in it can hide what it says.
 *
 * A command is the one place an invisible character does harm. A right-to-left override reorders what is drawn, so a
 * command can read as something other than what it runs as; a control character can move the cursor of a terminal that
 * later shows the log. Both become a visible `‹U+202E›` (the code point in hex), so the reader sees that something is
 * there. Newlines and tabs stay (a multi-line script is the point); a run of blank lines folds to one line that counts
 * them, because a command padded with a screenful of blank lines is how the real line gets pushed out of the box.
 */

/** Bidirectional overrides and isolates, and the Arabic letter mark. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Zero-width characters and the byte-order mark: invisible, so they would otherwise pass unseen. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/;
/** Blank lines in a row from which the run folds into a count. */
const FOLD_FROM = 2;

/** `text` with invisible and control characters shown as `‹U+XXXX›`, tabs as four spaces and long runs of blank lines folded. */
export function visibleText(text: string): string {
  let out = "";
  for (const c of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ")) {
    const code = c.codePointAt(0) ?? 0;
    const control = (code < 0x20 && c !== "\n") || (code >= 0x7f && code <= 0x9f);
    out += control || BIDI.test(c) || ZERO_WIDTH.test(c) ? `‹U+${code.toString(16).toUpperCase().padStart(4, "0")}›` : c;
  }
  const kept: string[] = [];
  let blank = 0;
  const flush = () => {
    if (blank >= FOLD_FROM) kept.push(`↵ ${blank} blank lines`);
    else for (let i = 0; i < blank; i++) kept.push("");
    blank = 0;
  };
  for (const line of out.split("\n")) {
    if (line.trim() === "") {
      blank += 1;
      continue;
    }
    flush();
    kept.push(line);
  }
  flush();
  return kept.join("\n").replace(/^\n+|\n+$/g, "");
}

/**
 * How many rows `text` takes in a box `columns` characters wide: each line wraps at the width (a line of any length
 * is at least one row). An estimate for a monospace face; the box's real wrapping can differ by a row.
 */
export function rowsOf(text: string, columns: number): number {
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil([...line].length / columns)), 0);
}

/**
 * Code an agent wrote, safe to draw: the same invisible and control characters as `visibleText` become `‹U+XXXX›`, but
 * the text is otherwise exactly as written (tabs, blank lines and indentation stay), because it is also what `Copy code`
 * puts on the clipboard.
 */
export function safeCode(text: string): string {
  let out = "";
  for (const c of text.replace(/\r\n?/g, "\n")) {
    const code = c.codePointAt(0) ?? 0;
    const control = (code < 0x20 && c !== "\n" && c !== "\t") || (code >= 0x7f && code <= 0x9f);
    out += control || BIDI.test(c) || ZERO_WIDTH.test(c) ? `‹U+${code.toString(16).toUpperCase().padStart(4, "0")}›` : c;
  }
  return out;
}
