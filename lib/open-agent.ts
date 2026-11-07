import { announce } from "nsh";
import { Sessions } from "herdr-desktop/native";
import type { BoardRow } from "herdr-desktop/native";
import { openPane, openSession, paneKey, removePanel, sessionKey } from "./dock";
import { rowOf } from "./herdr";

/**
 * Which view opens an agent. The chat is the way to work with an agent, the terminal is the fallback:
 *
 * - a chat session (an ACP agent a keeper runs) opens its chat tab;
 * - an agent that runs in a herdr pane and is omp, Claude Code or Codex opens the chat read from its log (`Show chat`),
 *   with the terminal one key away (`Show terminal`);
 * - anything else (a shell, an agent whose log cannot be found) opens the terminal mirror.
 *
 * The person's choice is per pane and lasts for this run only: a restart opens the chat again, which is the default
 * for those agents. The tabs attach and detach themselves (a chat tab reads its log or keeper while it is open).
 */

/** Panes whose terminal the person asked for (`machine/pane`): they open as the terminal until `Show chat`. */
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
  return !wantTerminal.has(`${row.machine}/${row.paneId}`) && canShowChat(row.machine, row.paneId) ? "chat" : "terminal";
}

/** Opens an agent in its view; `reply` (the board's `Reply…`) also puts the keyboard in a terminal's message box. */
export async function openAgent(row: BoardRow, options?: { reply?: boolean }): Promise<void> {
  if (viewOf(row) === "chat") await openSession(row.machine, row.session ? row.paneId : `pane:${row.paneId}`);
  else await openPane(row.machine, row.paneId, options);
}

/** Opens the terminal agent in `pane` by its place (a notification's click): its chat when it has one, else its terminal. */
export async function openTarget(machine: string, pane: string, options?: { reply?: boolean }): Promise<void> {
  const row = rowOf(`${machine}/${pane}`);
  if (row) await openAgent(row, options);
  else await openPane(machine, pane, options);
}

/** `Show terminal`: swaps the chat read from a pane's log for the terminal mirror of that pane. */
export async function showTerminal(machine: string, pane: string): Promise<void> {
  wantTerminal.add(`${machine}/${pane}`);
  await openPane(machine, pane);
  removePanel(sessionKey(machine, `pane:${pane}`));
  announce("Showing the terminal");
}

/** `Show chat`: swaps the terminal mirror of a pane for the chat read from its log. */
export async function showChat(machine: string, pane: string): Promise<void> {
  if (!canShowChat(machine, pane)) {
    announce("This agent has no chat to show");
    return;
  }
  wantTerminal.delete(`${machine}/${pane}`);
  await openSession(machine, `pane:${pane}`);
  removePanel(paneKey(machine, pane));
  announce("Showing the chat");
}
