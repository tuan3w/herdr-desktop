/** Soft hyphens and zero-width characters: a paste can carry them, nobody sees them, and they break a search match. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** Lowercase, no diacritics, no invisible characters: "Crème Brûlée" -> "creme brulee". Both sides of a search go through it. */
export function fold(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Stroked d does not decompose, so NFD leaves it.
    .replace(/[\u0111\u0110]/g, "d")
    .toLowerCase();
}
