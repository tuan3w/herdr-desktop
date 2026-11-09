/**
 * The slash commands of an agent, ported from herdr-mobile (`slash_catalog.dart`, `slash_usage.dart`, `command_model.dart`):
 * what the chat composer's first word can complete to and what pinning and sending teach it. The list is the agent's own
 * (`available_commands_update`, Claude's skill listing) plus, for a chat read from a terminal, the agent's built-ins
 * from `lib/slash-builtins.ts` (owner, 2026-11-09: Claude Code's log never lists `/clear` or `/compact`). Pure:
 * `lib/pane-memory.ts` keeps the memory, the composer shows it.
 */

/** Where a command comes from; listing order is this order. */
export type SlashSource = "project" | "user" | "builtIn";

const SOURCE_ORDER: Record<SlashSource, number> = { project: 0, user: 1, builtIn: 2 };

export interface SlashCommand {
  /** Without the trigger; may contain `:` for a namespaced command. */
  name: string;
  description: string;
  source: SlashSource;
  /** What its argument is for, shown after the name once picked; absent when it takes none. */
  hint?: string;
  /** `/`, or `$` for Codex's skills. */
  trigger: "/" | "$";
  /** The agent's own command (`/clear`), or a skill or custom command someone added (Claude's skill listing). */
  kind: "command" | "skill";
}

/**
 * The kind of a name the person pinned or sent that the agent's table lacks: omp's `/skill:<name>` form and Codex's
 * `$name` are skills; anything else is taken for the agent's own.
 */
const kindOfKey = (key: string): SlashCommand["kind"] =>
  key.startsWith("$") || key.startsWith("skill:") ? "skill" : "command";

/** What the composer holds once a command is picked: the command and one space, ready for its arguments. */
export const commandText = (c: SlashCommand): string => `${c.trigger}${c.name}`;

/** What pins and use remember a command under: the bare name for `/`, the name with `$` for a skill. */
export const usageKey = (c: SlashCommand): string => (c.trigger === "/" ? c.name : `${c.trigger}${c.name}`);

// --- What the person pinned and sent, per agent label (lower case). Nothing secret: command names only.

/** Most commands remembered per agent. */
export const MAX_PER_AGENT = 40;
/** The newest are never pushed out by older, busier ones, or the recents of a bare `/` would forget what was just sent. */
export const KEEP_RECENT = 5;
/** How many recently sent commands follow the pinned ones on a bare `/`. */
export const RECENT_SHOWN = 5;

/** `[count, lastUsed]` per command key. */
type Use = [number, number];

export interface SlashMemory {
  uses: Record<string, Record<string, Use>>;
  pinned: Record<string, string[]>;
}

export const emptyMemory = (): SlashMemory => ({ uses: {}, pinned: {} });

const agentKey = (label: string): string => label.trim().toLowerCase();

/** Tolerant: whatever does not fit is dropped, never thrown on. */
export function parseMemory(json: unknown): SlashMemory {
  const memory = emptyMemory();
  if (typeof json !== "object" || json === null) return memory;
  const { uses, pinned } = json as { uses?: unknown; pinned?: unknown };
  if (typeof uses === "object" && uses !== null) {
    for (const [agent, byName] of Object.entries(uses)) {
      if (typeof byName !== "object" || byName === null) continue;
      const parsed: Record<string, Use> = {};
      for (const [name, use] of Object.entries(byName as Record<string, unknown>)) {
        if (!Array.isArray(use) || use.length !== 2) continue;
        const [count, at] = use;
        if (!Number.isInteger(count) || count < 1 || !Number.isInteger(at)) continue;
        parsed[name] = [count, at];
      }
      if (Object.keys(parsed).length > 0) memory.uses[agent] = parsed;
    }
  }
  if (typeof pinned === "object" && pinned !== null) {
    for (const [agent, names] of Object.entries(pinned)) {
      if (!Array.isArray(names)) continue;
      const parsed = [...new Set(names.filter((n): n is string => typeof n === "string"))];
      if (parsed.length > 0) memory.pinned[agent] = parsed;
    }
  }
  return memory;
}

/** Pinned names of `agent`, in the order they were pinned. */
export const pinnedOf = (m: SlashMemory, agent: string): string[] => m.pinned[agentKey(agent)] ?? [];

export const isPinned = (m: SlashMemory, agent: string, key: string): boolean => pinnedOf(m, agent).includes(key);

/** How many times `key` was sent to `agent`. */
export const countOf = (m: SlashMemory, agent: string, key: string): number => m.uses[agentKey(agent)]?.[key]?.[0] ?? 0;

const byRecency = (uses: Record<string, Use>): string[] =>
  Object.keys(uses).sort((a, b) => uses[b][1] - uses[a][1] || (a < b ? -1 : a > b ? 1 : 0));

/** Every key sent to `agent` at least once, newest first. */
export const usedOf = (m: SlashMemory, agent: string): string[] => {
  const uses = m.uses[agentKey(agent)];
  return uses ? byRecency(uses) : [];
};

/** Keeps the newest `KEEP_RECENT`, then the busiest of the rest (ties: newest first), up to `MAX_PER_AGENT`. */
function prune(uses: Record<string, Use>): Record<string, Use> {
  const names = Object.keys(uses);
  if (names.length <= MAX_PER_AGENT) return uses;
  const newest = byRecency(uses);
  const kept = newest.slice(0, KEEP_RECENT);
  const rest = newest
    .slice(KEEP_RECENT)
    .sort((a, b) => uses[b][0] - uses[a][0] || uses[b][1] - uses[a][1] || (a < b ? -1 : 1));
  kept.push(...rest.slice(0, MAX_PER_AGENT - KEEP_RECENT));
  return Object.fromEntries(kept.map((name) => [name, uses[name]]));
}

/** `memory` after `key` was sent to `agent` at time `at` (milliseconds). An empty agent or key changes nothing. */
export function recordUse(m: SlashMemory, agent: string, key: string, at: number): SlashMemory {
  const who = agentKey(agent);
  if (!who || !key) return m;
  const byName = { ...m.uses[who] };
  byName[key] = [(byName[key]?.[0] ?? 0) + 1, at];
  return { ...m, uses: { ...m.uses, [who]: prune(byName) } };
}

/** `memory` with `key` pinned for `agent`, or unpinned when it was; an agent left with no pins is forgotten. */
export function togglePin(m: SlashMemory, agent: string, key: string): SlashMemory {
  const who = agentKey(agent);
  if (!who || !key) return m;
  const names = [...(m.pinned[who] ?? [])];
  const at = names.indexOf(key);
  if (at >= 0) names.splice(at, 1);
  else names.push(key);
  const pinned = { ...m.pinned };
  if (names.length === 0) delete pinned[who];
  else pinned[who] = names;
  return { ...m, pinned };
}

// --- The list the composer shows.

const WORD = /^[/$]\S*$/;
const SENT = /^([/$])(\w[\w:.-]{0,63})(?:\s|$)/;
const PICKED = /^([/$])(\w[\w:.-]{0,63}) $/;

const triggerOf = (key: string): "/" | "$" => (key.startsWith("$") ? "$" : "/");

/** By source (project, user, built-in), then by `uses` (most first), keeping the given order among equals. */
function ordered(list: SlashCommand[], uses?: (c: SlashCommand) => number): SlashCommand[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => SOURCE_ORDER[a.c.source] - SOURCE_ORDER[b.c.source] || (uses ? uses(b.c) - uses(a.c) : 0) || a.i - b.i,
    )
    .map((x) => x.c);
}

/**
 * The commands that `input` (the composer's whole text) is the start of. Empty unless `input` is a lone `/word` (or
 * `$word`): once there is a space the command is chosen and the rest is its arguments.
 *
 * A bare trigger lists the pinned commands, then the most recently sent, then the rest. A word lists names that start
 * with it, then names that contain it, then descriptions that do; within a group source order, then use; pinned commands
 * lead them all, and the name typed in full leads the pinned ones. Names the
 * person pinned or sent that the table lacks are candidates too (an agent without a table lists only those).
 */
export function matchCommands(
  input: string,
  agent: string,
  commands: readonly SlashCommand[],
  memory: SlashMemory,
): SlashCommand[] {
  if (!WORD.test(input) || !agent.trim()) return [];
  const trigger = input[0] as "/" | "$";
  const mine = commands.filter((c) => c.trigger === trigger);
  const known = new Map(mine.map((c) => [usageKey(c), c]));
  const remembered = [...new Set([...pinnedOf(memory, agent), ...usedOf(memory, agent)])];
  const extras: SlashCommand[] = remembered
    .filter((key) => !known.has(key) && triggerOf(key) === trigger)
    .map((key) => ({
      name: key.startsWith("$") ? key.slice(1) : key,
      description: "",
      source: "builtIn",
      trigger,
      kind: kindOfKey(key),
    }));
  const query = input.slice(1).toLowerCase();
  const uses = (c: SlashCommand) => countOf(memory, agent, usageKey(c));
  if (query === "") {
    const all = new Map([...known, ...extras.map((c) => [usageKey(c), c] as const)]);
    const pinned = pinnedOf(memory, agent).flatMap((key) => all.get(key) ?? []);
    const shown = new Set(pinned.map(usageKey));
    const recent = usedOf(memory, agent)
      .filter((key) => !shown.has(key))
      .slice(0, RECENT_SHOWN)
      .flatMap((key) => all.get(key) ?? []);
    for (const c of recent) shown.add(usageKey(c));
    return [...pinned, ...recent, ...ordered(mine.filter((c) => !shown.has(usageKey(c))))];
  }
  const starts: SlashCommand[] = [];
  const inName: SlashCommand[] = [];
  const inText: SlashCommand[] = [];
  for (const c of [...mine, ...extras]) {
    const name = c.name.toLowerCase();
    if (name.startsWith(query)) starts.push(c);
    else if (name.includes(query)) inName.push(c);
    else if (c.description.toLowerCase().includes(query)) inText.push(c);
  }
  // A command typed in full and nothing else left to choose: nothing to show.
  if (starts.length === 1 && starts[0].name.toLowerCase() === query && inName.length === 0) return [];
  const found = [...ordered(starts, uses), ...ordered(inName, uses), ...ordered(inText, uses)];
  // A pinned command leads whatever the word matched, in the order it was pinned: pinning means "keep it at the top".
  // The command whose whole name was typed leads even those: Enter on the open list picks the first row, and must keep
  // `/review` rather than turn it into `/review-pr`.
  const pins = pinnedOf(memory, agent);
  const rank = (c: SlashCommand) => {
    if (c.name.toLowerCase() === query) return -1;
    const at = pins.indexOf(usageKey(c));
    return at < 0 ? pins.length : at;
  };
  return found
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/**
 * The key to remember when `line` was sent, or null when it is not a command: a path or plain text, and a `$name` the
 * agent has no skill of (`$PATH is wrong` is a sentence).
 */
export function sentKey(line: string, agent: string, commands: readonly SlashCommand[]): string | null {
  const m = SENT.exec(line);
  if (!agent.trim() || !m) return null;
  if (m[1] === "$") return commands.some((c) => c.trigger === "$" && c.name === m[2]) ? `$${m[2]}` : null;
  return m[2];
}

/** What the command just picked takes, while the composer holds exactly the command and its space; else null. */
export function hintFor(input: string, commands: readonly SlashCommand[]): string | null {
  const m = PICKED.exec(input);
  if (!m) return null;
  const hint = commands.find((c) => c.trigger === m[1] && c.name === m[2])?.hint;
  return hint ? hint : null;
}

/**
 * The list as the box shows it: the agent's commands and its skills apart, each in the order `matchCommands` ranked them,
 * the group that holds the best match first, so the first row (what Enter picks) is still the best match.
 */
export function byKind(ranked: readonly SlashCommand[]): SlashCommand[] {
  const first = ranked[0]?.kind;
  return [...ranked.filter((c) => c.kind === first), ...ranked.filter((c) => c.kind !== first)];
}
