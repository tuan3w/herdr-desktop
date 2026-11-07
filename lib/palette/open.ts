import { Herdr } from "herdr-desktop/native";
import { announce } from "nsh";

import { machinesOpen } from "#lib/actions";
import { moveFocused } from "#lib/dock";
import { viewFile } from "#lib/files";
import { projectOf, rowOf } from "#lib/herdr";
import { openProject } from "#lib/nav";
import { canShowChat, openAgent, showChat, showTerminal, viewOf } from "#lib/open-agent";
import type { PaletteCommand } from "#lib/palette/commands";
import type { PaletteRow } from "#lib/palette/rows";
import { projectFolder, projectSummary } from "#lib/sidebar";

/** How a result opens: what `Enter` does, `Shift+Enter` (beside the tab in front), `mod+Enter` (the other view of an agent). */
export type OpenHow = "default" | "side" | "view";

/**
 * Opens what a result stands for. A command is run and counted (`command:<id>` in the recents, so what is used often
 * ranks higher). Returns false when there was nothing to open (the agent went away while the palette was open).
 */
export async function openResult(
  row: PaletteRow,
  commands: ReadonlyMap<string, PaletteCommand>,
  how: OpenHow,
): Promise<boolean> {
  const hit = row.hit;
  if (row.file) {
    viewFile(row.file.machine, row.file.path);
    return true;
  }
  if (!hit) return false;
  switch (hit.kind) {
    case "agent":
    case "message": {
      const agent = rowOf(hit.target);
      if (!agent) {
        announce("That agent is gone");
        return false;
      }
      if (how === "view" && hit.kind === "agent") {
        if (viewOf(agent) === "chat" && !agent.session) await showTerminal(agent.machine, agent.paneId);
        else if (viewOf(agent) === "terminal" && canShowChat(agent.machine, agent.paneId))
          await showChat(agent.machine, agent.paneId);
        else await openAgent(agent);
        return true;
      }
      await openAgent(agent);
      if (how === "side") await moveFocused("right");
      announce(`Switched to ${agent.name}`);
      return true;
    }
    case "project":
      return openProject(hit.target);
    case "machine":
      machinesOpen.set(true);
      return true;
    default:
      commands.get(hit.target)?.run();
      try {
        Herdr.visit(`command:${hit.target}`);
      } catch {
        // No engine (a lab): nothing to count.
      }
      return true;
  }
}

/**
 * The one line under the list for the highlighted row: what it is, where, and the last thing it said. It is a reserved
 * line, so moving the highlight never moves the list.
 */
export function previewOf(row: PaletteRow | undefined): string {
  if (!row) return "";
  if (row.disabled) return row.disabled;
  const hit = row.hit;
  if (row.file) return row.file.path;
  // A row that is not a result (a next step, an action) already says what it is: the line stays empty.
  if (!hit) return "";
  if (hit.kind === "agent") {
    const agent = rowOf(hit.target);
    if (!agent) return "";
    const said =
      agent.status === "blocked" && agent.prompt
        ? agent.prompt.question
        : (agent.lastMessage ?? [...agent.preview].reverse().find((l) => l.trim() !== "") ?? "");
    return [agent.cwd, said.trim() === "" ? "" : `“${said.trim().replace(/\s+/g, " ")}”`].filter(Boolean).join(" · ");
  }
  if (hit.kind === "project") {
    const project = projectOf(hit.target);
    if (!project) return "";
    const agents = project.rows.length === 1 ? "1 agent" : `${project.rows.length} agents`;
    return [agents, projectSummary(project, false), projectFolder(project)].filter(Boolean).join(" · ");
  }
  if (hit.kind === "message") return `${hit.title}`;
  if (hit.kind === "machine") return hit.parts.join(" · ");
  return row.alias ? `Also found as “${row.alias}”` : "";
}
