import { Sessions } from "herdr-desktop/native";
import { announce } from "nsh";

import type { BoardRow } from "herdr-desktop/native";

import { openSession, openTerminal, removePanel, sessionKey, terminalKey } from "#lib/dock";
import { rowOf } from "#lib/herdr";
import { terminalEnabled } from "#lib/settings";

/**
 * Which view opens an agent. The chat is the way to supervise an agent, the terminal is the way to work in it:
 *
 * - a chat session (an ACP agent a keeper runs) opens its chat tab;
 * - an agent that runs in a herdr pane and is omp, Claude Code or Codex opens the chat read from its log (`Chat`),
 *   with its real terminal one press away (`Terminal`, `mod+shift+m`);
 * - anything else (a shell, an agent whose log cannot be found) opens the real terminal directly.
 *
 * With the terminal tab off in Settings (`terminalEnabled`, the default for now) the chat is the only view offered: an
 * agent that can be read as a chat always opens it, `showTerminal` refuses, and an agent that cannot still opens its
 * terminal tab, which then mounts no terminal and says how to open the agent in the person's own terminal.
 *
 * The person's choice is per pane and lasts for this run only: a restart opens the chat again, which is the default
 * for those agents. The tabs attach and detach themselves (a chat tab reads its log or keeper while it is open; a terminal
 * tab starts its program only because the person opened it, `isArmed`).
 */

/** What a terminal request says while the terminal tab is off: the one place to turn it on. */
export const TERMINAL_OFF = "The terminal tab is off. Turn it on in Settings.";

/** Panes whose terminal the person asked for (`machine/pane`): they open as the terminal until `Chat`. */
const wantTerminal = new Set<string>();

/** Whether the agent in `pane` can be read as a chat: omp, Claude Code or Codex, and its log can be told. */
export function canShowChat(machine: string, pane: string): boolean {
  try {
    return Sessions.canObserve(machine, pane);
  } catch {
    // The engine is not running yet (a lab): nothing can be observed.
    return false;
  }
}

/** The tab to show for a row now: `chat` or `terminal`. Pure of side effects, so the sidebar can mark rows with it. */
export function viewOf(row: BoardRow): "chat" | "terminal" {
  if (row.session) return "chat";
  return (!terminalEnabled() || !wantTerminal.has(`${row.machine}/${row.paneId}`)) &&
    canShowChat(row.machine, row.paneId)
    ? "chat"
    : "terminal";
}

/** The tab key of an agent's own view (`viewOf`): its chat's or its terminal's. */
export const viewKeyOf = (row: BoardRow): string =>
  viewOf(row) === "chat"
    ? sessionKey(row.machine, row.session ? row.paneId : `pane:${row.paneId}`)
    : terminalKey(row.machine, row.paneId);

/** Opens an agent in its view; `here` puts its tab in the context shown instead of its project's (and moves it); `reply` (the board's `Reply…`) also puts the keyboard in the chat's box, or in the terminal. */
export async function openAgent(row: BoardRow, options?: { reply?: boolean; here?: boolean }): Promise<void> {
  if (viewOf(row) === "chat") await openSession(row.machine, row.session ? row.paneId : `pane:${row.paneId}`, options);
  else await openTerminal(row.machine, row.paneId, options);
}

/** Opens the terminal agent in `pane` by its place (a notification's click): its chat when it has one, else its terminal. */
export async function openTarget(machine: string, pane: string, options?: { reply?: boolean }): Promise<void> {
  const row = rowOf(`${machine}/${pane}`);
  if (row) await openAgent(row, options);
  else await openTerminal(machine, pane, options);
}

/** `Terminal`: swaps the chat read from a pane's log for the real terminal of that pane (herdr's client, pointed at the pane first). */
export async function showTerminal(machine: string, pane: string): Promise<void> {
  if (!terminalEnabled()) {
    announce(TERMINAL_OFF);
    return;
  }
  wantTerminal.add(`${machine}/${pane}`);
  await openTerminal(machine, pane);
  removePanel(sessionKey(machine, `pane:${pane}`));
  announce("Showing the terminal");
}

/** `Chat`: swaps the terminal of a pane for the chat read from its log. */
export async function showChat(machine: string, pane: string): Promise<void> {
  if (!canShowChat(machine, pane)) {
    announce("This agent has no chat to show");
    return;
  }
  wantTerminal.delete(`${machine}/${pane}`);
  await openSession(machine, `pane:${pane}`);
  removePanel(terminalKey(machine, pane));
  announce("Showing the chat");
}
