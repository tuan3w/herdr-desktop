import { signal } from "nsh";

import type { BoardRow, PromptOption, PromptView } from "herdr-desktop/native";

/**
 * The rules of the bulk answer view (`components/bulk-answer.tsx`): which blocked agents it lists, which of them may be
 * ticked, which option each tick means, and when the two-step button is armed. Pure, so the safety of one gesture that
 * can answer several agents is tested without a window. Sending itself is `fromPrompt(...).send`, the dock's checked path.
 */

/**
 * The same 400 ms and 4 s as the one answer dock (`answer-dock.tsx` keeps its own copies, unexported): a row that just
 * appeared or changed takes no tick, and an armed button disarms after this long.
 */
export const GUARD_MS = 400;
export const ARM_MS = 4000;
/** Rows the view lists; the rest say `N more: answer these first`. */
export const CAP = 30;

/** True while the view is shown, so the bulk bar steps aside (two bars of actions at once is two ways to act). */
export const answerViewOpen = signal(false);

const isRisky = (o: PromptOption) => !!o.riskReason || o.standingGrant;

/**
 * The option that allows once: the first that is neither risky nor a decline, by its flags and never by its place in
 * the list (menus differ: `Yes` may be 1st or 2nd). Nothing when there is none, and then the row cannot be bulk-answered.
 */
export function allowOnce(prompt: PromptView): PromptOption | undefined {
  return prompt.options.find((o) => !isRisky(o) && !o.reject);
}

/** The option that declines, by its flag: the first plain one (a decline that lasts or carries a risk is not a bulk one). */
export function declineOption(prompt: PromptView): PromptOption | undefined {
  return prompt.options.find((o) => o.reject && !isRisky(o));
}

/** Why a row is listed without a box that works: its own tab or its chat answers it. */
export type Why = "risky" | "session" | "unknown";

export interface Entry {
  row: BoardRow;
  /** The question as shown. Absent for a session (a chat has no prompt on the board). */
  prompt?: PromptView;
  /** Set when the row may be ticked. */
  allow?: PromptOption;
  /** Set when it cannot, and says in words where to answer it. */
  why?: Why;
  /** What the row says in place of a box. */
  say?: string;
}

/** A blocked agent on a connected machine whose question the view can show or point to. */
function entryOf(row: BoardRow): Entry | undefined {
  if (row.status !== "blocked" || row.offline) return undefined;
  if (row.session) return { row, why: "session", say: "Answer in the chat" };
  // A terminal that needs the person but whose question is not (or not yet) read: listed, never tickable.
  if (!row.prompt) return { row, why: "unknown", say: "Answer in its own tab" };
  // With nothing to read there is nothing to approve in bulk: the person answers it where the whole question is.
  const allow = row.prompt.subject?.trim() ? allowOnce(row.prompt) : undefined;
  return allow
    ? { row, prompt: row.prompt, allow }
    : { row, prompt: row.prompt, why: "risky", say: "Answer in its own tab" };
}

/** What the view lists for `rows`: at most `CAP`, and how many more there are. Terminal questions first, in the board's order. */
export function answerEntries(rows: readonly BoardRow[]): { entries: Entry[]; more: number } {
  const all = rows.flatMap((r) => entryOf(r) ?? []);
  const ordered = [...all.filter((e) => e.why !== "session"), ...all.filter((e) => e.why === "session")];
  return { entries: ordered.slice(0, CAP), more: Math.max(0, ordered.length - CAP) };
}

/** Whether the view is shown: at least one terminal agent has a question on the board (a chat alone is answered in its chat). */
export const hasAnswerView = (rows: readonly BoardRow[]): boolean =>
  rows.some((r) => r.status === "blocked" && !r.offline && !r.session && !!r.prompt);

/** One ticked row: the question exactly as it was displayed when the box was ticked. */
export interface Tick {
  prompt: PromptView;
  allow: PromptOption;
  /** Where the answer goes and what the result calls it, as it was when ticked. */
  machine: string;
  pane: string;
  name: string;
}

export type Ticks = Readonly<Record<string, Tick>>;

/** Identifies a question's appearance: a changed question is a new one. */
export const seenKey = (key: string, digest: string) => `${key}@${digest}`;

/** What stops a tick, or nothing: a row not eligible, a row inside its 400 ms guard, a command taller than its box not yet read. */
export function tickBlock(
  entry: Entry,
  state: { guarded: boolean; overflow: boolean; read: boolean },
): "ineligible" | "guard" | "unread" | undefined {
  if (!entry.allow || !entry.prompt) return "ineligible";
  if (state.guarded) return "guard";
  if (state.overflow && !state.read) return "unread";
  return undefined;
}

/**
 * The ticks that still stand against the rows as they are now: a row that is gone (it stopped needing the person, or
 * was answered elsewhere) leaves, and one whose question is not the one that was ticked leaves too and is named in
 * `changed`: nothing is ever sent for it.
 */
export function reconcile(ticks: Ticks, entries: readonly Entry[]): { kept: Ticks; changed: string[] } {
  const live = new Map(entries.map((e) => [e.row.key, e]));
  const kept: Record<string, Tick> = {};
  const changed: string[] = [];
  for (const [key, tick] of Object.entries(ticks)) {
    const now = live.get(key);
    if (!now) continue;
    if (now.prompt?.digest === tick.prompt.digest) kept[key] = tick;
    else changed.push(key);
  }
  return { kept, changed };
}

/** What an armed button was armed for. Any difference from what is on screen now disarms it. */
export interface Armed {
  /** The verb armed. */
  verb: "allow";
  /** The ticked rows and the question each was ticked with. */
  ticks: string;
  /** Every question of every listed row: a new question anywhere disarms. */
  world: string;
  at: number;
}

const signatureOf = (items: readonly string[]) => [...items].sort().join("|");

export const ticksSignature = (ticks: Ticks) =>
  signatureOf(Object.entries(ticks).map(([k, t]) => seenKey(k, t.prompt.digest)));

export const worldSignature = (entries: readonly Entry[]) =>
  signatureOf(entries.map((e) => seenKey(e.row.key, e.prompt?.digest ?? "")));

/** Whether `armed` still holds `ARM_MS` after it was set, for exactly these ticks and exactly this screen. */
export function stillArmed(armed: Armed | undefined, ticks: Ticks, entries: readonly Entry[], now: number): boolean {
  return (
    !!armed &&
    now - armed.at < ARM_MS &&
    armed.ticks === ticksSignature(ticks) &&
    armed.world === worldSignature(entries)
  );
}

/**
 * What a press of `Allow N commands` does: the first arms (nothing is sent), the second, while still armed for the
 * same ticks on the same screen, sends. With nothing ticked, nothing happens.
 */
export function pressAllow(
  armed: Armed | undefined,
  ticks: Ticks,
  entries: readonly Entry[],
  now: number,
): { action: "none" | "arm" | "send"; armed: Armed | undefined } {
  if (Object.keys(ticks).length === 0) return { action: "none", armed: undefined };
  if (stillArmed(armed, ticks, entries, now)) return { action: "send", armed: undefined };
  return {
    action: "arm",
    armed: { verb: "allow", ticks: ticksSignature(ticks), world: worldSignature(entries), at: now },
  };
}

/** `1 command`, `3 commands`. */
export const commandsText = (n: number) => `${n} ${n === 1 ? "command" : "commands"}`;

/** The button's words: what it does now, and when armed what the second press does. */
export function allowLabel(count: number, armed: boolean): string {
  return armed ? `Press again to allow ${count} · you read each command above` : `Allow ${commandsText(count)}`;
}

/** How one row's answer ended, for the lasting toast and the row. */
export interface Result {
  name: string;
  kind: "sent" | "changed" | "stopped";
  note: string;
}

/** `Allowed 3: payments review, auth, notes`; refusals follow, each by name: nothing is hidden behind a count. */
export function resultText(verb: "Allowed" | "Declined", results: readonly Result[]): string {
  const sent = results.filter((r) => r.kind === "sent").map((r) => r.name);
  const refused = results.filter((r) => r.kind !== "sent");
  const parts: string[] = [];
  if (sent.length > 0) parts.push(`${verb} ${sent.length}: ${sent.join(", ")}`);
  if (refused.length > 0)
    parts.push(
      `${refused.length} not sent: ${refused.map((r) => `${r.name} (${r.kind === "changed" ? "the question changed" : r.note})`).join(", ")}`,
    );
  return parts.join(" · ");
}
