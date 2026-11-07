import { Code } from "herdr-desktop/native";

/**
 * Words and sizes of the code renderer (`components/code-block.tsx`, `components/diff-block.tsx`). What the person
 * can toggle (`codeWrap`, `codeLineNumbers`, `codeWhitespace`, `diffSplit`) lives in `lib/settings.ts`.
 */

let warmed = false;

/**
 * Compiles the grammars chat code is mostly in, on a background thread, so the first block of a language does not pay for
 * its grammar on the person's first look. Returns at once; call it when the app starts.
 */
export function warmCode(): void {
  if (warmed) return;
  warmed = true;
  Code.warm();
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
