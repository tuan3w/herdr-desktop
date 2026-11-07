import { effect, signal, Storage } from "nsh";
import { save } from "#lib/save";

/**
 * How code blocks are drawn, as the person set it (`components/code-block.tsx`). Persisted under its own key until the
 * chat is integrated, when these three move into `lib/settings.ts` beside `paneFit` (the rule is one place for
 * options; `docs/specs/chat-craft.md`, "Integration").
 */
const KEY = "herdr.code.v1";

/** Wrap long lines instead of scrolling sideways. */
export const codeWrap = signal(false);
/** Line numbers in a muted gutter. */
export const codeLineNumbers = signal(false);
/** Tabs as `→` and trailing spaces as `·`. */
export const codeWhitespace = signal(false);
/** Diffs side by side (old left, new right) instead of one column. */
export const diffSplit = signal(false);

interface Saved {
  wrap: boolean;
  lineNumbers: boolean;
  whitespace: boolean;
  split?: boolean;
}

let started = false;

/** Reads the saved choices once and keeps them saved. Call it before the first block is drawn. */
export async function loadCodeSettings(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Saved>;
      if (typeof saved.wrap === "boolean") codeWrap.set(saved.wrap);
      if (typeof saved.lineNumbers === "boolean") codeLineNumbers.set(saved.lineNumbers);
      if (typeof saved.whitespace === "boolean") codeWhitespace.set(saved.whitespace);
      if (typeof saved.split === "boolean") diffSplit.set(saved.split);
    }
  } catch (e) {
    console.warn("herdr-desktop: code settings not read", e);
  }
  effect(() => save(KEY, JSON.stringify({ wrap: codeWrap(), lineNumbers: codeLineNumbers(), whitespace: codeWhitespace(), split: diffSplit() } satisfies Saved)));
}

/** Lines of a block shown before `Show all N lines`. */
export const CODE_COLLAPSED_LINES = 16;
/** The tallest an open block gets (points) before it scrolls inside itself. */
export const CODE_MAX_HEIGHT = 560;

/** `Code, TypeScript, 41 lines`: what a screen reader says a block is. */
export function codeLabel(language: string, lines: number): string {
  return `Code${language ? `, ${language}` : ""}, ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** The lines a copied text has (a trailing line break does not start another). */
export function lineCount(code: string): number {
  if (code === "") return 0;
  let n = 1;
  for (let i = 0; i < code.length - 1; i++) if (code.charCodeAt(i) === 10) n++;
  return n;
}

/** `Diff of src/auth.ts, 2 added, 1 removed`. */
export function diffLabel(path: string | undefined, added: number, removed: number): string {
  return `Diff${path ? ` of ${path}` : ""}, ${added} added, ${removed} removed`;
}
