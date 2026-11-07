import type { SearchFocus } from "herdr-desktop/native";

import { context, focused, HOME, rowKeyOf } from "#lib/dock";
import { projectOf, rowOf } from "#lib/herdr";
import { projectFolder } from "#lib/sidebar";

/** Where the person is: the agent in front, else the project whose tabs are shown. The ranking favours both, the empty palette omits the agent. */
export function paletteFocus(): SearchFocus {
  const rowKey = rowKeyOf(focused());
  const row = rowKey === null ? undefined : rowOf(rowKey);
  if (row) return { row: row.key, project: row.project, machine: row.machine };
  const shown = context();
  const project = shown === HOME ? undefined : projectOf(shown);
  return project ? { project: project.key, machine: project.machine } : {};
}

/** The folder `Files` searches: the main checkout of the project in front, on its machine. `null` on the board, where there is no project. */
export function filesRoot(
  focus: SearchFocus = paletteFocus(),
): { machine: string; root: string; project: string } | null {
  const project = focus.project ? projectOf(focus.project) : undefined;
  const root = project ? projectFolder(project) : "";
  return project && root !== "" ? { machine: project.machine, root, project: project.name } : null;
}
