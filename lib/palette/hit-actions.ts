import { Herdr, Sessions } from "herdr-desktop/native";
import { announce, Clipboard } from "nsh";

import { confirmDestructive, notify } from "#kit";
import { chatNaming, naming, newSession, openSettings, paneNaming } from "#lib/actions";
import { context, focusComposerSoon, inside, moveFocused, removePanel, terminalKey } from "#lib/dock";
import { projectOf, reviewWithUndo, rowOf } from "#lib/herdr";
import { openProject } from "#lib/nav";
import { canShowChat, openAgent, showChat, showTerminal, viewOf } from "#lib/open-agent";
import { browseFiles, viewFile } from "#lib/open-files";
import type { PaletteCommand } from "#lib/palette/commands";
import type { PaletteRow } from "#lib/palette/rows";
import { terminalEnabled } from "#lib/settings";
import { keyText } from "#lib/shortcuts";
import { projectFolder } from "#lib/sidebar";

/**
 * What can be done with a result besides opening it: the action panel (`mod+p` again on a row). The first action is what
 * `Enter` does. An action that cannot run now stays listed with the reason, so the person learns it exists; one that
 * cannot be taken back asks first (`confirmDestructive`), one that can says so with an `Undo`.
 */
export interface HitAction {
  id: string;
  label: string;
  /** The key that does it from the list, as this platform writes it. */
  keys?: string;
  /** Why it cannot run now. */
  disabled?: string;
  /** Asks first: the muted hint on its row. */
  asks?: string;
  run: () => void | Promise<void>;
}

const failed = (what: string) => (e: unknown) =>
  notify(`${what}: ${e instanceof Error ? e.message : String(e)}`, { type: "error" });

const copy = (text: string, what: string) => () =>
  void Clipboard.writeText(text).then(() => notify(`${what} copied`), failed(`Could not copy the ${what}`));

/** The actions for `row`; `commands` are the ones registered at open. */
export function actionsFor(row: PaletteRow, commands: ReadonlyMap<string, PaletteCommand>): HitAction[] {
  const hit = row.hit;
  if (!hit) return [];
  switch (hit.kind) {
    case "agent":
      return agentActions(hit.target);
    case "message":
      return [
        { id: "open", label: "Open the agent", keys: keyText("enter"), run: () => openRow(hit.target) },
        { id: "copy", label: "Copy the line", run: copy(hit.title, "Line") },
      ];
    case "project":
      return projectActions(hit.target);
    case "machine":
      return [
        { id: "edit", label: "Open Machines…", keys: keyText("enter"), run: () => openSettings("machines") },
        {
          id: "reconnect",
          label: "Reconnect",
          run: () => {
            try {
              Herdr.reconnect(hit.target);
              announce(`Reconnecting to ${hit.title}`);
            } catch (e) {
              failed("Could not reconnect")(e);
            }
          },
        },
      ];
    default: {
      const command = commands.get(hit.target);
      return [
        {
          id: "run",
          label: hit.kind === "theme" ? "Use this theme" : hit.kind === "setting" ? "Change" : "Run",
          keys: keyText("enter"),
          disabled: row.disabled,
          run: () => command?.run(),
        },
        {
          id: "reset",
          label: "Reset ranking",
          run: () => {
            Herdr.forget(`command:${hit.target}`);
            notify("Ranking reset");
          },
        },
      ];
    }
  }
}

/** The actions of a file hit: `path` is absolute on `machine`. */
export function fileActions(machine: string, path: string, root: string): HitAction[] {
  const dir = path.slice(0, Math.max(1, path.lastIndexOf("/")));
  return [
    { id: "open", label: "Open", keys: keyText("enter"), run: () => viewFile(machine, path) },
    { id: "browse", label: "Show in its folder", run: () => browseFiles(machine, dir) },
    { id: "copy-path", label: "Copy path", run: copy(path, "Path") },
    {
      id: "copy-relative",
      label: "Copy path in the project",
      run: copy(path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path, "Path"),
    },
  ];
}

async function openRow(key: string): Promise<void> {
  const row = rowOf(key);
  if (row) await openAgent(row);
}

function agentActions(key: string): HitAction[] {
  const row = rowOf(key);
  if (!row)
    return [
      { id: "gone", label: "This agent is gone", disabled: "It is no longer on the board", run: () => undefined },
    ];
  const project = projectOf(row.project);
  const chat = viewOf(row) === "chat";
  const terminalChat = chat && !row.session;
  /** The linked worktree the agent works in, when it does: the one `Remove worktree…` is about. */
  const checkout =
    project?.checkouts.find((c) => c.path === row.checkout) ??
    project?.checkouts.find((c) => row.cwd && inside(row.cwd, c.path));
  const other: HitAction = terminalChat
    ? { id: "terminal", label: "Show terminal", run: () => showTerminal(row.machine, row.paneId) }
    : !chat && canShowChat(row.machine, row.paneId)
      ? { id: "chat", label: "Show chat", run: () => showChat(row.machine, row.paneId) }
      : {
          id: "other-view",
          label: row.session ? "Show terminal" : "Show chat",
          disabled: row.session ? "A chat session has no terminal" : "This agent has no chat to show",
          run: () => undefined,
        };
  // With the terminal tab off (`terminalEnabled`) nothing offers a terminal, not even as a dimmed row: only `Show chat` is kept.
  const others = terminalEnabled() || other.id === "chat" ? [{ ...other, keys: keyText("mod+enter") }] : [];
  const here = context() === row.project ? "this project" : (projectOf(context())?.name ?? "the board");
  const reviewable = row.status === "done" && !row.reviewed && !row.offline;
  const stoppable = row.status === "working" || row.status === "blocked";
  return [
    { id: "open", label: "Open", keys: keyText("enter"), run: () => openRow(key) },
    {
      id: "side",
      label: "Open to the side",
      keys: keyText("shift+enter"),
      run: async () => {
        await openAgent(row);
        await moveFocused("right");
      },
    },
    { id: "here", label: `Open here (${here})`, run: () => openAgent(row, { here: true }) },
    ...others,
    {
      id: "reply",
      label: "Reply…",
      run: async () => {
        await openAgent(row, { reply: true });
        if (chat) await focusComposerSoon();
      },
    },
    {
      id: "reviewed",
      label: "Mark reviewed",
      disabled: reviewable ? undefined : "Only a finished agent you have not looked at",
      run: () => void reviewWithUndo([row]),
    },
    {
      id: "stop",
      label: "Stop",
      asks: "sends Esc to the agent",
      disabled: row.offline ? "Its machine is not connected" : stoppable ? undefined : "It is not working",
      run: async () => {
        const ok = await confirmDestructive({
          title: `Stop “${row.name}”?`,
          description: "This presses Esc in the agent, which interrupts what it is doing.",
          action: "Stop",
        });
        if (!ok) return;
        try {
          if (row.session) await Sessions.cancel(row.machine, row.paneId);
          else await Herdr.sendKeys(row.machine, row.paneId, ["esc"]);
          announce(`Stopped ${row.name}`);
        } catch (e) {
          failed("Could not stop it")(e);
        }
      },
    },
    {
      id: "rename",
      label: "Rename…",
      run: () =>
        naming.set(
          row.session
            ? chatNaming(row.machine, row.paneId, row.name)
            : paneNaming(row.machine, row.paneId, Herdr.paneMeta(row.machine, row.paneId)?.paneLabel ?? ""),
        ),
    },
    { id: "copy-id", label: row.session ? "Copy session id" : "Copy pane id", run: copy(row.paneId, "Id") },
    {
      id: "copy-folder",
      label: "Copy folder",
      disabled: row.cwd ? undefined : "herdr does not say where it works",
      run: copy(row.cwd ?? "", "Folder"),
    },
    {
      id: "close",
      label: "Close pane in herdr…",
      asks: "stops what runs in it",
      disabled: row.session ? "Not a terminal pane" : undefined,
      run: async () => {
        const ok = await confirmDestructive({
          title: `Close pane “${row.name}”?`,
          description: `This stops what runs in it, on ${row.machineName}${project ? `, in ${project.name}` : ""}. It cannot be undone.`,
          action: "Close pane",
        });
        if (!ok) return;
        try {
          await Herdr.closePane(row.machine, row.paneId);
          removePanel(terminalKey(row.machine, row.paneId));
          notify(`Closed pane ${row.name}`);
        } catch (e) {
          failed("Could not close the pane")(e);
        }
      },
    },
    {
      id: "remove-worktree",
      label: "Remove worktree…",
      asks: "closes its workspace",
      disabled: row.session ? "Not a terminal pane" : checkout?.linked ? undefined : "Not in a linked worktree",
      run: async () => {
        const ok = await confirmDestructive({
          title: `Remove worktree “${checkout?.name ?? row.name}”?`,
          description:
            "This asks herdr to remove the worktree folder and close its workspace, with everything that runs in it. herdr may refuse and say why; this app never forces it.",
          action: "Remove worktree",
        });
        if (!ok) return;
        try {
          await Herdr.removeWorktree(row.machine, row.workspaceId);
          announce(`Removed worktree ${checkout?.name ?? row.name}`);
        } catch (e) {
          failed("Could not remove the worktree")(e);
        }
      },
    },
    {
      id: "kill",
      label: "Kill session…",
      asks: "ends the chat",
      disabled: row.session ? undefined : "Only a chat session this app started",
      run: async () => {
        const ok = await confirmDestructive({
          title: `Kill session “${row.name}”?`,
          description: `This ends the chat on ${row.machineName}. It cannot be undone.`,
          action: "Kill session",
        });
        if (!ok) return;
        try {
          await Sessions.kill(row.machine, row.paneId);
          notify(`Ended ${row.name}`);
        } catch (e) {
          failed("Could not end the session")(e);
        }
      },
    },
  ];
}

function projectActions(key: string): HitAction[] {
  const project = projectOf(key);
  if (!project)
    return [{ id: "gone", label: "This project is gone", disabled: "It has no agents now", run: () => undefined }];
  const folder = projectFolder(project);
  return [
    { id: "switch", label: "Switch to this project", keys: keyText("enter"), run: () => void openProject(key) },
    { id: "new", label: "New agent session here…", run: () => newSession({ machine: project.machine, folder }) },
    {
      id: "pin",
      label: project.pinned ? "Unpin" : "Pin",
      run: () => {
        try {
          Herdr.pinProject(key, !project.pinned);
          announce(project.pinned ? `Unpinned ${project.name}` : `Pinned ${project.name}`);
        } catch (e) {
          failed("Could not pin it")(e);
        }
      },
    },
    {
      id: "files",
      label: "Browse files",
      disabled: folder === "" ? "It has no folder" : undefined,
      run: () => browseFiles(project.machine, folder),
    },
    {
      id: "copy-folder",
      label: "Copy folder",
      disabled: folder === "" ? "It has no folder" : undefined,
      run: copy(folder, "Folder"),
    },
  ];
}
