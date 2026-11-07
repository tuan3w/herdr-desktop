import type { BoardRow, SearchHit } from "herdr-desktop/native";

import type { IconName } from "#kit";
import { projectOf, rowOf } from "#lib/herdr";
import type { PaletteCommand } from "#lib/palette/commands";
import { keyText } from "#lib/shortcuts";
import { ageText, projectLabel, rowLabel } from "#lib/sidebar";
import type { AgentStatus } from "#lib/status";

/**
 * One row of any palette list, as the screen draws and speaks it. The row is read from the live board each time it is
 * asked (a state or an age changes in place); which rows there are and in which order never does while the palette is
 * open (`Search.open` froze that).
 */
export interface PaletteRow {
  /** The item id: unique in the list. */
  id: string;
  kind: SearchHit["kind"] | "file" | "action" | "help" | "agentKind";
  title: string;
  /** Matched letters of `title`: pairs `[start, end)`, flattened. */
  marks: readonly number[];
  /** The synonym that found it, shown after the title. */
  alias?: string | null;
  /** The muted line: project, checkout, machine; the group of a command. */
  parts: readonly string[];
  /** An agent's state: the row draws its shape. */
  state?: AgentStatus;
  /** What stands in front of the title. */
  glyph: "status" | "monogram" | IconName;
  /** How long an agent has been in its state; empty for the rest. */
  age: string;
  /** The key, as this platform writes it (`Ctrl+N`), or an affordance (`↵`). */
  keys?: string;
  /** On or in effect: shown as a check. */
  checked: boolean;
  /** Why it cannot be chosen; set exactly when it cannot. */
  disabled?: string;
  /** This agent needs the person: its title is drawn in the signal's quiet form. */
  waiting: boolean;
  /** The whole row as a screen reader says it: `Command` announces only this. */
  spoken: string;
  /** A synthetic row (a help line, an action, a next step, a step's candidate) is chosen by this, not by opening a result. */
  choose?: () => void;
  /** A file: where it is. `path` is absolute on `machine`; `root` is the project folder it was searched in. */
  file?: { machine: string; path: string; root: string };
  /** The result the row stands for, when it is one (not an action or a step candidate). */
  hit?: SearchHit;
  /** The heading it is listed under on the empty palette (`Needs you`, `Recent`); unset while typing. */
  group?: string | null;
}

const ICONS: Partial<Record<PaletteRow["kind"], IconName>> = {
  command: "arrow-right",
  setting: "sliders",
  theme: "sun",
  machine: "monitor",
  message: "message",
  file: "file",
  action: "arrow-right",
  help: "search",
};

/** A result as a row. `commands` are the ones registered at open: a command's key, state and reason come from them. */
export function rowOfHit(hit: SearchHit, commands: ReadonlyMap<string, PaletteCommand>): PaletteRow {
  if (hit.kind === "agent") return agentRow(hit);
  if (hit.kind === "project") return projectRow(hit);
  const command = commands.get(hit.target);
  const disabled = command?.spec.disabled ? (command.reason ?? "Not available here") : undefined;
  const keys = command?.shortcut === undefined ? undefined : keyText(command.shortcut);
  const checked = command?.checked === true;
  const named = hit.alias ? `${hit.title}, also called ${hit.alias}` : hit.title;
  return {
    id: hit.id,
    kind: hit.kind,
    title: hit.title,
    marks: hit.marks,
    alias: hit.alias,
    parts: hit.kind === "message" ? hit.parts : disabled ? [disabled] : [],
    glyph: ICONS[hit.kind] ?? "arrow-right",
    age: "",
    keys,
    checked,
    disabled,
    waiting: false,
    spoken: [
      hit.kind === "message" ? `message in ${hit.parts.join(", ")}: ${hit.title}` : named,
      hit.kind === "setting" || hit.kind === "theme" ? hit.kind : "",
      checked ? (hit.kind === "theme" ? "current" : "on") : "",
      keys ? `shortcut ${keys}` : "",
      disabled ? `unavailable, ${disabled}` : "",
    ]
      .filter(Boolean)
      .join(", "),
    hit,
    group: hit.group,
  };
}

/** An agent: its shape and age are the board's now, its name and place are what the search found. */
function agentRow(hit: SearchHit): PaletteRow {
  const live: BoardRow | undefined = rowOf(hit.target);
  const project = live ? projectOf(live.project) : undefined;
  const status: AgentStatus = live?.status ?? hit.state ?? "unknown";
  const spoken = live && project ? rowLabel(live, project.name) : [hit.title, ...hit.parts].join(", ");
  return {
    id: hit.id,
    kind: "agent",
    title: hit.title,
    marks: hit.marks,
    alias: hit.alias,
    parts: hit.parts,
    state: status,
    glyph: "status",
    age: ageText(live?.sinceSecs),
    checked: false,
    waiting: status === "blocked" && live?.offline !== true,
    disabled: undefined,
    // Which view an agent opens in is a native question per row (`viewOf`), too dear to ask of every row at every tick.
    spoken: live?.session ? `chat, ${spoken}` : spoken,
    hit,
    group: hit.group,
  };
}

function projectRow(hit: SearchHit): PaletteRow {
  const project = projectOf(hit.target);
  return {
    id: hit.id,
    kind: "project",
    title: hit.title,
    marks: hit.marks,
    alias: hit.alias,
    parts: hit.parts,
    glyph: "monogram",
    age: "",
    checked: false,
    waiting: false,
    spoken: project ? `project, ${projectLabel(project)}` : `project, ${hit.title}`,
    hit,
    group: hit.group,
  };
}

/** The title cut into runs, each marked or not, so the drawn name can bold the letters the query matched. */
export function runsOf(title: string, marks: readonly number[]): { text: string; marked: boolean }[] {
  const out: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const [from, to] = [Math.max(at, marks[i]), Math.min(title.length, marks[i + 1])];
    if (to <= from) continue;
    if (from > at) out.push({ text: title.slice(at, from), marked: false });
    out.push({ text: title.slice(from, to), marked: true });
    at = to;
  }
  if (at < title.length) out.push({ text: title.slice(at), marked: false });
  return out.length > 0 ? out : [{ text: title, marked: false }];
}
