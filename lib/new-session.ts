import { Herdr } from "herdr-desktop/native";

import type { AgentRoute, SessionInfo } from "herdr-desktop/native";

/**
 * The rules of `New agent session` that are not drawing: which folder is acceptable, which agents to offer, what a
 * failed start means and what to do next, and what the form remembers. Starting is Rust (`Sessions.start`); nothing
 * here talks to a machine except the two remembered settings.
 */

/** An agent the form lists, whether the machine can run it or not. */
export interface AgentChoice {
  /** The agent's route id: what `Sessions.start` takes. */
  id: string;
  /** What the person reads. */
  label: string;
  /** The machine runs it (`Sessions.probe` named it). */
  installed: boolean;
}

/**
 * The agents the keeper knows (`native/core/src/session/vendored/routes.json`), for dimming the ones the machine lacks:
 * `Sessions.probe` answers only with the ones it can run. An agent the probe names that is not here is still offered.
 */
const KNOWN: readonly AgentRoute[] = [
  { id: "omp", label: "omp" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "pi" },
];

/** What the machine runs first, then the known agents it lacks (dimmed, with the reason in the form). */
export function agentChoices(runnable: readonly AgentRoute[]): AgentChoice[] {
  const have = new Set(runnable.map((r) => r.id));
  return [
    ...runnable.map((r) => ({ id: r.id, label: r.label, installed: true })),
    ...KNOWN.filter((k) => !have.has(k.id)).map((k) => ({ id: k.id, label: k.label, installed: false })),
  ];
}

/** What is wrong with the folder a session starts in; `undefined` when nothing. `~` is the machine's home and is expanded there. */
export function sessionFolderError(folder: string): string | undefined {
  const path = folder.trim();
  if (path === "") return "Enter the folder the agent works in.";
  if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/"))
    return "Enter an absolute path on that machine, starting with / or ~/.";
  if (/[\0\r\n]/.test(path)) return "A folder path is one line.";
  return undefined;
}

/** Why a start did not happen and what to do about it: the keeper's own words, then a next step. */
export interface StartFailure {
  /** What happened, as the keeper said it. */
  text: string;
  /** What the person can do now. */
  next: string;
}

/** The next step for the failure `text` says, by what the keeper and the machine report (`native/core/src/session/error.rs`). */
export function startFailure(text: string, machineName: string): StartFailure {
  const said = text.trim() || "The session did not start.";
  const next = (() => {
    if (/python3/i.test(said)) return `Install python3 on ${machineName}, then try again.`;
    if (/isn.t installed/i.test(said) && /helper/i.test(said))
      return "Try again: the app installs its helper on first use.";
    if (/isn.t installed|not installed/i.test(said))
      return `Install the agent on ${machineName}, or pick another agent.`;
    if (/folder|doesn.t exist|no such/i.test(said)) return `Check the folder: it must exist on ${machineName}.`;
    if (/exited|failed|initialize/i.test(said))
      return `Run the agent once in a terminal on ${machineName} to see why: it may need you to sign in.`;
    if (/sessions are open|close one/i.test(said)) return "End or close one of the open sessions, then start again.";
    if (/ssh|connect|timed out|refused|unreachable|host/i.test(said))
      return `Check ${machineName} in Machines, then try again.`;
    return "Nothing was started. Check the folder and the agent, then try again.";
  })();
  return { text: said, next };
}

/** The folders offered under the folder field: the one used last, then where sessions and agents already work, without repeats. */
export function recentFolders(options: {
  remembered?: string;
  sessions: readonly SessionInfo[];
  agents: readonly string[];
  limit?: number;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of [options.remembered ?? "", ...options.sessions.map((s) => s.cwd), ...options.agents]) {
    const path = folder.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out.slice(0, options.limit ?? 8);
}

const agentKey = (machine: string) => `newSession.agent.${machine}`;
const folderKey = (machine: string) => `newSession.folder.${machine}`;

/** The agent last started on `machine` and the folder it ran in, if there was one (settings, so a restart keeps them). */
export function lastStart(machine: string): { agent?: string; folder?: string } {
  const agent = Herdr.setting(agentKey(machine));
  const folder = Herdr.setting(folderKey(machine));
  return {
    agent: typeof agent === "string" ? agent : undefined,
    folder: typeof folder === "string" ? folder : undefined,
  };
}

/** Remembers what was started on `machine`, for the next opening of the form. */
export function rememberStart(machine: string, agent: string, folder: string): void {
  Herdr.setSetting(agentKey(machine), agent);
  Herdr.setSetting(folderKey(machine), folder);
}

/** Seconds since the Unix epoch of an ISO 8601 time an agent reported; `null` when it is not one. */
export function epochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** What the person calls an agent: its label when the keeper's list knows it, else its id. */
export function agentLabel(id: string): string {
  return KNOWN.find((k) => k.id === id)?.label ?? id;
}
