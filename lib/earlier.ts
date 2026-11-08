/**
 * Older turns of a chat read from a terminal's log (`design/chat.md`, "Earlier messages"). The Rust side says what
 * is possible (`SessionView.observed.earlier`) and does the reading; this file is the one rule of when the screen asks
 * on its own, so a person who scrolls up finds older rows already there.
 */

/** `ObservedView.earlier`: none (the whole log is shown), available, loading, tooLong (the widest read is shown). */
export type Earlier = "none" | "available" | "loading" | "tooLong";

/** The sentence for a log longer than the widest read; Rust's ceiling is 64 MB (`ObservedConfig::tail_max`). */
export const TOO_LONG = "Earlier messages are not shown: Herdr reads the last 64 MB of a log.";

/**
 * Whether the person is close enough to the top of the list that older rows should already be loading: within one
 * viewport of it, and older rows can be had. An empty list is at the top: pass `extentBefore` 0 and `viewport` 1.
 */
export function shouldAutoLoad(extentBefore: number, viewport: number, state: Earlier): boolean {
  return state === "available" && extentBefore < viewport;
}

/**
 * `shouldAutoLoad`, once per arrival: it answers true once while `earlier` is `available`, and again only after the
 * state left `available` (a read ran), so a list that stays near the top asks for the next, wider read when this one
 * has landed and never asks twice for the same one. Pressing the row is not affected: it always asks.
 */
export function createAutoLoad(): (extentBefore: number, viewport: number, state: Earlier) => boolean {
  let armed = true;
  return (extentBefore, viewport, state) => {
    if (state !== "available") {
      armed = true;
      return false;
    }
    if (!armed || !shouldAutoLoad(extentBefore, viewport, state)) return false;
    armed = false;
    return true;
  };
}
