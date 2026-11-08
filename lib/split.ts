import { announce } from "nsh";

import type { BoardRow } from "herdr-desktop/native";

import { changedFiles } from "#lib/changes-count";
import {
  type CompanionFacts,
  companionOf,
  focused,
  groupOf,
  layout,
  moveFocused,
  openBeside,
  panelsOf,
  parseChangesKey,
  parsePaneKey,
  rowKeyOf,
  selectTab,
  sessionKey,
} from "#lib/dock";
import { allRows, board, rowOf } from "#lib/herdr";
import { canShowChat, viewKeyOf } from "#lib/open-agent";

/**
 * Split as a person asks for it (`Open beside`, `mod+\`, the chat header's button): a tab that shares its group moves
 * into a group of its own; a tab that is alone has nothing to leave behind, so its companion opens beside it instead
 * (`companionOf`: a chat gets its Changes, Changes gets the chat). The rules are `lib/dock.ts`'s; this reads the facts
 * they need from the board and from the last read of git.
 */

/** The agent view a Changes tab or a terminal puts beside itself: the open one for the folder first, else any agent in it. */
function viewFor(machine: string, cwd: string, own: string): string | undefined {
  const open = new Set(panelsOf(layout()));
  const rows = allRows(board()).filter((r) => r.machine === machine && r.cwd === cwd);
  const keyed = rows.map((r) => viewKeyOf(r)).filter((k) => k !== own);
  return keyed.find((k) => open.has(k)) ?? keyed[0];
}

function factsOf(key: string): CompanionFacts {
  const changes = parseChangesKey(key);
  if (changes) return { repo: true, view: viewFor(changes.machine, changes.cwd, key) };
  const rowKey = rowKeyOf(key);
  const row: BoardRow | undefined = rowKey === null ? undefined : rowOf(rowKey);
  const pane = parsePaneKey(key);
  // A terminal's other view is the chat read from its log, when there is one.
  const view = pane && canShowChat(pane.machine, pane.pane) ? sessionKey(pane.machine, `pane:${pane.pane}`) : undefined;
  if (!row?.cwd) return { repo: false, view };
  // Known from the last read of git (the chat's header reads it while it is in front): `null` is not a repository, or not read yet.
  return { cwd: row.cwd, repo: changedFiles(row.machine, row.cwd)() !== null, view };
}

/**
 * Splits `key` (the tab whose button or menu was used; the focused one for a key): a group with several tabs moves the
 * tab into a new group, a lone tab opens its companion beside it. Returns false, and says why, when it cannot.
 */
export async function splitTab(key: string, where: "right" | "bottom" = "right"): Promise<boolean> {
  if (key !== focused()) selectTab(key);
  const here = groupOf(layout(), key);
  if (!here) return false;
  if (here.panels.length > 1) return moveFocused(where);
  const companion = companionOf(key, factsOf(key));
  if ("why" in companion) {
    announce(companion.why);
    return false;
  }
  return openBeside(companion.key, where);
}

/** `Open to the side`: an agent's own view in a group beside the focused tab. */
export const openAgentBeside = (row: BoardRow): Promise<boolean> => openBeside(viewKeyOf(row), "right");
