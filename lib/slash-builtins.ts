/**
 * The commands built into the agents whose terminal panes open as a chat. Their logs never list them (Claude Code's lists
 * only its skills, omp's and Codex's nothing), so the `/` list of such a chat would lack `/clear` and `/compact`; the
 * owner decided on 2026-11-09 to keep them here. Only commands that do their work from the typed line are listed: one
 * that only opens a picker or a dialog in the terminal (`/config`, omp's `/model`) would leave the chat waiting on a
 * screen it cannot show. Read from each agent's own source (Claude Code 2.1.319, omp's `slash-commands/`, Codex 0.160).
 * A keeper's ACP session has none of these: its agent lists its own commands.
 */

import type { SlashCommand } from "#lib/slash";

type Entry = [name: string, description: string, hint?: string];

const TABLES: Record<string, Entry[]> = {
  claude: [
    ["clear", "Start a new session with an empty context; this one can be resumed"],
    ["compact", "Summarise the conversation so far to free context", "[what to keep]"],
    ["context", "Show how much of the context is used"],
    ["usage", "Show what this session has cost and the plan's usage"],
    ["init", "Write a CLAUDE.md that describes this project"],
    ["model", "Use another model for the rest of the session", "<model>"],
    ["resume", "Go back to an earlier conversation by its id", "<conversation id>"],
    ["rename", "Rename this conversation", "<name>"],
  ],
  omp: [
    ["new", "Start a new session"],
    ["clear", "Drop the conversation's context and keep the session"],
    ["compact", "Summarise the session to free context", "[focus]"],
    ["handoff", "Carry what matters into a new session", "[focus]"],
    ["plan", "Plan before changing anything (again to leave plan mode)", "[prompt]"],
    ["queue", "Send a message after the agent's turn ends", "<message>"],
    ["resume", "Go back to an earlier session by its id", "<session id>"],
    ["fast", "Switch the faster service tier on or off"],
  ],
  codex: [
    ["new", "Start a new chat"],
    ["compact", "Summarise the conversation to free context"],
    ["init", "Write an AGENTS.md with instructions for Codex"],
    ["diff", "Show the git diff, untracked files included"],
    ["status", "Show the session's model, limits and token use"],
  ],
};

/** The built-in commands of the agent `agent` (herdr's label: `claude`, `omp`, `codex`), none for another. */
export function builtInsOf(agent: string): SlashCommand[] {
  return (TABLES[agent.trim().toLowerCase()] ?? []).map(([name, description, hint]) => ({
    name,
    description,
    source: "builtIn",
    trigger: "/",
    kind: "command",
    ...(hint ? { hint } : {}),
  }));
}

/**
 * The agent's own commands, then the built-ins it did not list. On the same name the agent's own entry is kept: its
 * description is the one it runs with. `observed`: the chat reads a terminal pane (only those get built-ins).
 */
export function withBuiltIns(own: readonly SlashCommand[], agent: string, observed: boolean): SlashCommand[] {
  if (!observed) return [...own];
  const named = new Set(own.map((c) => c.name));
  return [...own, ...builtInsOf(agent).filter((c) => !named.has(c.name))];
}
