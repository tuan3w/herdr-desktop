import type { PaneMeta } from "herdr-desktop/native";

/**
 * What a screen reader says for a tab: `<title>, <state>, tab 3 of 8`. The state is left out for a tab that has none
 * (the board, Changes). The tab's own text is cut with an ellipsis when it does not fit, so this is the whole of it.
 */
export function tabLabel(title: string, state: string, index: number, count: number): string {
  return [title, state, `tab ${index + 1} of ${count}`].filter(Boolean).join(", ");
}

/**
 * What a terminal tab and its header call the pane: the most specific name the person gave wins (the pane's label, then a
 * tab they named), else the program's own derived name. herdr numbers an unnamed tab ("1"), so a default `tabLabel` never
 * shadows the derived name: `tabNamed` says it was a choice.
 */
export function terminalTitle(info: Pick<PaneMeta, "name" | "paneLabel" | "tabLabel" | "tabNamed">): string {
  return info.paneLabel || (info.tabNamed ? info.tabLabel : "") || info.name;
}

/** The workspace and tab names the person gave, in that order, left out where herdr only supplied a default (the folder, the tab's number). */
export function namedPlace(
  info: Pick<PaneMeta, "workspaceLabel" | "workspaceNamed" | "tabLabel" | "tabNamed">,
): string[] {
  return [info.workspaceNamed ? info.workspaceLabel : "", info.tabNamed ? info.tabLabel : ""].filter(Boolean);
}
