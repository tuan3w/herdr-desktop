/**
 * Quick phrases: the short lines a person types to an agent again and again, offered as chips above the empty composer.
 * A chip only fills the composer; the person still sends. Ported from herdr-mobile (`quick_phrases.dart`,
 * `sent_phrases.dart`). Pure: `lib/pane-memory.ts` keeps the memory in the `phrases.v1` setting.
 *
 * Learned phrases are text the person typed, so what may become a chip is narrow (the reason is by each rule):
 * - sent at least `MIN_SENDS` times: a message sent once is where a secret or a one-off path lives;
 * - one line of at most `MAX_LENGTH` characters, not a `/command`: a chip is a row, a command is not a phrase;
 * - no address and no unbroken token of `LONGEST_TOKEN` characters: those are keys, tokens and hashes;
 * - only `MAX_TRACKED` are remembered, the rarest and oldest dropped first (there is no time decay: what is kept
 *   stays small and recent by that rule).
 * Callers learn only from text sent to an agent, never from a line typed into a shell.
 */

/** Most phrases of the person's own list: the chip row is a row, not a library. */
export const MAX_COUNT = 12;
export const MAX_LENGTH = 80;
export const MIN_SENDS = 2;
export const MAX_TRACKED = 300;
export const LONGEST_TOKEN = 24;
/** Learned chips shown beside the person's own. */
export const MAX_CHIPS = 3;

export const DEFAULT_PHRASES: readonly string[] = [
  "continue",
  "yes, go ahead",
  "run the tests",
  "explain what you changed",
];

/** One message the person sent: its text, how often, and when last (a sequence number: larger is later). */
export interface Learned {
  t: string;
  n: number;
  l: number;
}

export interface PhraseMemory {
  /** The person's own list; null while they never edited it, so the defaults apply (and may change in a release). */
  own: string[] | null;
  learned: Learned[];
}

export const emptyPhrases = (): PhraseMemory => ({ own: null, learned: [] });

/** The list in use: the person's own, else the shipped defaults. */
export const ownPhrases = (m: PhraseMemory): readonly string[] => m.own ?? DEFAULT_PHRASES;

/** `text` as it is stored: whitespace folded to single spaces, trimmed, cut to `MAX_LENGTH` characters. */
export function cleanPhrase(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  const chars = [...folded];
  return chars.length <= MAX_LENGTH ? folded : chars.slice(0, MAX_LENGTH).join("").trim();
}

/** `raw` as a list: each cleaned, empties and repeats dropped, cut to `MAX_COUNT`. */
export function normalizePhrases(raw: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const phrase = cleanPhrase(item);
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
    if (out.length === MAX_COUNT) break;
  }
  return out;
}

export type PhraseProblem = "empty" | "duplicate" | "full";

/** Why `text` cannot join the list (or replace `replacing`), shown under the editor's field; null when it can. */
export function phraseProblem(list: readonly string[], text: string, replacing?: string): PhraseProblem | null {
  const phrase = cleanPhrase(text);
  if (!phrase) return "empty";
  if (phrase === replacing) return null;
  if (list.includes(phrase)) return "duplicate";
  if (replacing === undefined && list.length >= MAX_COUNT) return "full";
  return null;
}

export const PROBLEM_TEXT: Record<PhraseProblem, string> = {
  empty: "Write something to say",
  duplicate: "Already in the list",
  full: `The list is full (${MAX_COUNT} phrases)`,
};

/** The memory with `text` appended to the own list; unchanged when `phraseProblem` says no. */
export function addPhrase(m: PhraseMemory, text: string): PhraseMemory {
  const list = ownPhrases(m);
  return phraseProblem(list, text) ? m : { ...m, own: [...list, cleanPhrase(text)] };
}

/** The memory with `text` where `old` was; unchanged when `old` is missing or `phraseProblem` says no. */
export function replacePhrase(m: PhraseMemory, old: string, text: string): PhraseMemory {
  const list = ownPhrases(m);
  const at = list.indexOf(old);
  if (at < 0 || phraseProblem(list, text, old)) return m;
  const next = [...list];
  next[at] = cleanPhrase(text);
  return { ...m, own: next };
}

export function removePhrase(m: PhraseMemory, phrase: string): PhraseMemory {
  const list = ownPhrases(m);
  return list.includes(phrase) ? { ...m, own: list.filter((p) => p !== phrase) } : m;
}

/** The lookup key of `text`, or null when it may never be learned. */
export function learnKey(text: string): string | null {
  const line = text.trim();
  if (line.length < 2 || line.length > MAX_LENGTH) return null;
  if (line.includes("\n") || line.startsWith("/")) return null;
  if (line.includes("://")) return null;
  for (const token of line.split(/\s+/)) if (token.length >= LONGEST_TOKEN) return null;
  return line.toLowerCase();
}

/** Likeliest chip first: most sends, then latest. */
const rank = (a: Learned, b: Learned): number => b.n - a.n || b.l - a.l;

/** `learned` after `text` was sent once more; the same array when it may not be learned. */
export function learn(learned: readonly Learned[], text: string): Learned[] {
  const key = learnKey(text);
  if (key === null) return learned as Learned[];
  const line = text.trim();
  const seq = learned.reduce((top, e) => Math.max(top, e.l), 0) + 1;
  const seen = learned.find((e) => learnKey(e.t) === key);
  const next = seen
    ? learned.map((e) => (e === seen ? { t: line, n: e.n + 1, l: seq } : e))
    : [...learned, { t: line, n: 1, l: seq }];
  // The rarest and oldest go first.
  return next.length <= MAX_TRACKED ? next : [...next].sort(rank).slice(0, MAX_TRACKED);
}

/** The learned chips, most sent first, leaving out `except` (the person's own phrases, compared without regard to case). */
export function learnedChips(learned: readonly Learned[], except: readonly string[] = []): string[] {
  const skip = new Set(except.map((p) => p.toLowerCase()));
  return learned
    .filter((e) => e.n >= MIN_SENDS && !skip.has(learnKey(e.t) ?? e.t.toLowerCase()))
    .sort(rank)
    .slice(0, MAX_CHIPS)
    .map((e) => e.t);
}

/**
 * The chips above the composer: the person's own phrases, then what they send most. While the list is still the shipped
 * defaults the learned ones go first: the person has not chosen the defaults, and a message they really send beats a
 * guess. A list they edited stays where it is. A phrase that is also learned shows once, where the order puts it first.
 */
export function quickChips(m: PhraseMemory): string[] {
  const untouched = m.own === null;
  const own = ownPhrases(m);
  const learned = learnedChips(m.learned, untouched ? [] : own);
  const seen = new Set<string>();
  return (untouched ? [...learned, ...own] : [...own, ...learned]).filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Tolerant: whatever does not fit is dropped, never thrown on. */
export function parsePhrases(json: unknown): PhraseMemory {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return emptyPhrases();
  const raw = json as { own?: unknown; learned?: unknown };
  const own = Array.isArray(raw.own)
    ? normalizePhrases(raw.own.filter((p): p is string => typeof p === "string"))
    : null;
  const learned: Learned[] = [];
  if (Array.isArray(raw.learned)) {
    for (const item of raw.learned) {
      if (typeof item !== "object" || item === null) continue;
      const { t, n, l } = item as Partial<Learned>;
      if (
        typeof t === "string" &&
        learnKey(t) !== null &&
        Number.isInteger(n) &&
        (n as number) >= 1 &&
        Number.isInteger(l)
      ) {
        learned.push({ t, n: n as number, l: l as number });
      }
    }
  }
  return { own, learned: learned.slice(0, MAX_TRACKED) };
}
