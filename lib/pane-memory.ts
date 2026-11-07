import { Herdr } from "herdr-desktop/native";
import { signal } from "nsh";

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
 * What the chat's composer learns (slash pins and uses), kept in the Rust settings file (`Herdr.setting`) so it
 * survives a restart and belongs to the engine's data directory, not to a window. Read once on first use; every change is
 * written through. The pure rules live in `lib/slash.ts`.
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
