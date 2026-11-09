import type { Row } from "#lib/session-rows";
import { linesShown, subagentLinesPt, subagentsOf } from "#lib/session-subagents";
import { OUTPUT_LINES } from "#lib/session-text";

/**
 * How far from the end the list still pulls the view down as rows grow (`autoscrollToBottomThreshold`). Small on purpose:
 * one wheel notch (about 50 pt) up is the reader saying "stay here", and a streaming row must not take them back.
 */
export const FOLLOW_PT = 12;
/**
 * How far from the end still counts as being at it for the tab (`atEnd`: the `Jump to latest` pill and the unseen count).
 * Larger than `FOLLOW_PT` so the pill does not flicker on a few points of scroll or of rounding; between the two the
 * view stays where the reader put it and the pill stays quiet.
 */
export const AT_END_PT = 64;

/** Whether a view scrolled to `offset` (of `size` high, over `content`) is at the end for the pill and the unseen count. */
export function isAtEnd(offset: number, size: number, content: number): boolean {
  return offset + size >= content - AT_END_PT;
}

/** Where a page key goes: 90% of the view up or down, kept inside the content. */
export function pageOffset(offset: number, size: number, content: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(content - size, offset + direction * size * 0.9));
}

/**
 * How tall a row not yet drawn is taken to be, in points, before the conversation's rows are known (a new chat). The
 * list has one estimate for every row it has not measured, and rows run from a 28 pt note to a 900 pt answer; this is a
 * turn of a working chat (a question, a folded run of calls, what it did, an answer of a few paragraphs) over four rows.
 */
export const DEFAULT_ROW_PT = 160;
/** Rows read for the estimate: the end of the conversation, where it opens. */
const SAMPLE = 240;

/** Points of a line of the chat's text (`text-base`) and characters of the column (`max-w-3xl`, 720 pt of text) on one. */
const LINE_PT = 24;
const LINE_CHARS = 96;
/** A block of code: its header, a line of code, the lines shown folded and the `Show all` bar (`CodeBlock`). */
const CODE_HEAD_PT = 40;
const CODE_LINE_PT = 18;
const CODE_SHOWN = 16;
const CODE_FOOT_PT = 32;

/** How tall an answer's Markdown draws: its lines wrapped at the column, each fence folded to its first lines. */
function markdownPt(text: string): number {
  let pt = 0;
  let fence = -1;
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    let at = start;
    while (at < end && text.charCodeAt(at) === 32) at++;
    if (text.startsWith("```", at) || text.startsWith("~~~", at)) {
      if (fence < 0) {
        fence = 0;
        pt += CODE_HEAD_PT;
      } else {
        pt += Math.min(fence, CODE_SHOWN) * CODE_LINE_PT + (fence > CODE_SHOWN + 2 ? CODE_FOOT_PT : 0);
        fence = -1;
      }
    } else if (fence >= 0) fence++;
    else pt += end === start ? LINE_PT / 2 : LINE_PT * Math.ceil((end - start) / LINE_CHARS);
    if (nl === -1) break;
    start = nl + 1;
  }
  if (fence >= 0) pt += Math.min(fence, CODE_SHOWN) * CODE_LINE_PT;
  return pt;
}

/** A line of a step's plain output, and of the live tail under a running step. */
export const OUT_LINE_PT = 16;

/**
 * A step: its line, and while one of its calls runs the two-line tail of what it prints. Open, each call is its command in
 * one code block (header, then its lines up to what the block shows folded) and its output as plain lines, and a thought
 * before the step is a line of its own.
 */
function stepsPt(row: Extract<Row, { kind: "steps" }>): number {
  let pt = 8;
  for (const step of row.steps) {
    const running = step.calls.some((c) => c.item.tool?.status === "pending" || c.item.tool?.status === "inProgress");
    pt += 44 + (running ? 2 * OUT_LINE_PT + 12 : 0);
    if (!step.open) continue;
    pt += 32 * step.thoughts.length + 16;
    for (const call of step.calls) {
      const tool = call.item.tool;
      if (!tool) continue;
      const command = (tool.subject ?? "").split("\n").length;
      const output = Math.min(tool.head.length + tool.tail.length, OUTPUT_LINES) + 0.5;
      pt += 28 + CODE_HEAD_PT + CODE_LINE_PT * Math.min(command, CODE_SHOWN) + OUT_LINE_PT * output;
    }
  }
  return pt;
}

/** How tall one row draws, roughly, from what it holds: the measured heights of each kind on macOS (`docs/PERFORMANCE.md`). */
export function rowPt(row: Row): number {
  switch (row.kind) {
    case "user":
      return 44 + 20 * Math.ceil(Math.max(1, (row.item.text ?? "").length) / 80) + (row.item.images.length ? 80 : 0);
    case "agent":
      // The row's padding and the copy bar under it.
      return 40 + markdownPt(row.item.text ?? "");
    case "steps":
      return stepsPt(row);
    case "work":
      return 52;
    case "effects":
      return 8 + 28 * (row.effects.failures.length + row.effects.external.length + (row.effects.edited ? 1 : 0));
    case "subagent":
      // The card's header, and while one works (or the card is open) a line of `SUBAGENT_LINE_PT` for each subagent.
      return 48 + subagentLinesPt(row.item.tool ? linesShown(subagentsOf(row.item.tool), row.open) : 0);
    default:
      return 32;
  }
}

/**
 * The size the list takes for a row it has not measured: the mean of `rowPt` over the end of the conversation, to 8 pt.
 * A low estimate (it was 72 pt, the mean row is about 250) makes the content grow under the reader as rows are measured,
 * the bar's thumb shrink and jump, and the list bind rows it then finds it did not need.
 */
export function estimateRowPt(rows: readonly Row[]): number {
  if (rows.length < 8) return DEFAULT_ROW_PT;
  const from = Math.max(0, rows.length - SAMPLE);
  let sum = 0;
  for (let i = from; i < rows.length; i++) sum += rowPt(rows[i]!);
  return Math.min(600, Math.max(48, Math.round(sum / (rows.length - from) / 8) * 8));
}
