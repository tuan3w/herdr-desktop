import { Herdr } from "herdr-desktop/native";
import { signal } from "nsh";

import {
  addPhrase,
  emptyPhrases,
  learn,
  parsePhrases,
  type PhraseMemory,
  removePhrase,
  replacePhrase,
} from "#lib/phrases";
import {
  emptyMemory,
  parseMemory,
  recordUse,
  sentKey,
  type SlashCommand,
  type SlashMemory,
  togglePin,
} from "#lib/slash";

/**
 * What the pane's composer learns, kept in the Rust settings file (`Herdr.setting`) so it survives a restart and
 * belongs to the engine's data directory, not to a window. Read once on first use; every change is written through.
 * The pure rules live in `lib/slash.ts` and `lib/phrases.ts`; Settings edits the same stores (the quick phrase list, the
 * slash pins, "forget what was learned").
 * `remembered` is also what the Changes tab keeps its `reviewed` marks in (`lib/changes-model.ts`).
 */
export function remembered<T>(key: string, parse: (json: unknown) => T, empty: () => T) {
  const state = signal<T | undefined>(undefined);
  const read = (): T => {
    let value = state();
    if (value === undefined) {
      try {
        value = parse(Herdr.setting(key));
      } catch (e) {
        // An unreadable setting starts empty: learning is a convenience, never a reason to fail.
        console.error(`herdr-desktop: cannot read ${key}`, e);
        value = empty();
      }
      state.set(value);
    }
    return value;
  };
  return {
    /** Reactive: reading it in an effect or a prop follows later changes. */
    get: read,
    set(next: T) {
      state.set(next);
      try {
        Herdr.setSetting(key, next);
      } catch (e) {
        console.error(`herdr-desktop: cannot save ${key}`, e);
      }
    },
  };
}

const slash = remembered<SlashMemory>("slash.v1", parseMemory, emptyMemory);
const phrases = remembered<PhraseMemory>("phrases.v1", parsePhrases, emptyPhrases);

/** What was pinned and sent per agent. Reactive. */
export const slashMemory = (): SlashMemory => slash.get();

/** Pins `key` (a command's `usageKey`) for `agent`, or unpins it. */
export function pinCommand(agent: string, key: string): void {
  slash.set(togglePin(slash.get(), agent, key));
}

/** Notes the command `line` starts with, once it was sent. Not a command (a path, text): nothing is noted. */
export function noteSent(line: string, agent: string, commands: readonly SlashCommand[]): void {
  const key = sentKey(line, agent, commands);
  if (key !== null) slash.set(recordUse(slash.get(), agent, key, Date.now()));
}

/** The quick phrases and what was learned. Reactive. */
export const phraseMemory = (): PhraseMemory => phrases.get();

/** Counts `text` as sent to an agent. Callers never pass a line typed into a shell. */
export function learnPhrase(text: string): void {
  const memory = phrases.get();
  const learned = learn(memory.learned, text);
  if (learned !== memory.learned) phrases.set({ ...memory, learned });
}

/** Forgets every learned phrase; the person's own list stays. */
export function forgetLearned(): void {
  const memory = phrases.get();
  if (memory.learned.length > 0) phrases.set({ ...memory, learned: [] });
}

/** Edits the person's own list; each returns whether the list changed (`phraseProblem` says why not). */
export function addOwnPhrase(text: string): boolean {
  const memory = phrases.get();
  const next = addPhrase(memory, text);
  if (next !== memory) phrases.set(next);
  return next !== memory;
}

export function replaceOwnPhrase(old: string, text: string): boolean {
  const memory = phrases.get();
  const next = replacePhrase(memory, old, text);
  if (next !== memory) phrases.set(next);
  return next !== memory;
}

export function removeOwnPhrase(phrase: string): void {
  const memory = phrases.get();
  const next = removePhrase(memory, phrase);
  if (next !== memory) phrases.set(next);
}
