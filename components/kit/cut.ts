/** Line breaks and spaces are not text: a wrapped line may drop the space it broke at. Counted in code points. */
const letters = (s: string) => [...s.replace(/\s/g, "")].length;

/**
 * Whether laid-out `lines` hold less than `shown`, the text the box draws. `shown` must be what is drawn, not a longer
 * tip text: a name drawn as `auth.ts` from the path `src/auth.ts` is whole, and comparing it with the path drew a fade
 * over every short name (measured: the layout reported `auth.ts` complete, `letters` of the path was larger).
 */
export function isCut(lines: readonly { text: string }[], shown: string): boolean {
  return letters(lines.map((l) => l.text).join("")) < letters(shown);
}
